#!/usr/bin/env node
/* ============================================================
 * check_curve_calibration.mjs —— M4 标定比对（T5.1 的后半段）
 *
 * 输入：<我的文档>/DreamEngineProbe/M4_curve_fixture.json
 *      （由 tools/curve_fixture.jsx 在 AE 里生成）
 *
 * 做法：对每个样本、每一段、每一维度，用 curvelib 的公式重算曲线，
 *      与 AE 自己 valueAtTime() 给出的 17 个采样点逐点比对。
 *      —— 用采样值而不是截图，是因为采样值就是面板将来要画的同一套数据，
 *      而且能区分「公式错」与「坐标轴错」。
 *
 * 另外做两件事：
 *   1. 诊断「m 是否各维共享」：多维属性上，各维 speed/弦斜率 的比值
 *      如果一致，说明 temporal ease 确实是一条统一的时间重映射
 *      （curvelib 的核心假设）；不一致就必须改成逐维 m。
 *   2. 网格搜索 influenceScale / speedScale，给出建议修正系数。
 *      系数**不会自动写回**源码 —— 由人确认后改 curvelib 的 CALIBRATION。
 *
 * 用法：node tools/check_curve_calibration.mjs [夹具路径] [--verbose]
 * ============================================================ */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const ENGINE = resolve(ROOT, "cep/com.dreamengine.panel/engine");
const DEFAULT_FIXTURE = resolve(
  process.env.USERPROFILE || homedir(),
  "Documents/DreamEngineProbe/M4_curve_fixture.json",
);

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const fixturePath = args.find((a) => !a.startsWith("--")) || DEFAULT_FIXTURE;

if (!existsSync(fixturePath)) {
  console.log("没有找到标定夹具：" + fixturePath);
  console.log("先在 AE 里运行 tools/curve_fixture.jsx（文件 > 脚本 > 运行脚本文件），");
  console.log("产物落在 我的文档/DreamEngineProbe/M4_curve_fixture.json，然后再跑本工具。");
  process.exit(0);
}

const context = vm.createContext({});
// 与 AE 侧的加载顺序一致：先纯数学，再读写层
vm.runInContext(readFileSync(resolve(ENGINE, "curve_math.js"), "utf8"), context, { filename: "curve_math.js" });
vm.runInContext(readFileSync(resolve(ENGINE, "curvelib.jsx"), "utf8"), context, { filename: "curvelib.jsx" });
const C = context.AEV_Curve;

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const cases = fixture.cases || [];

if (!cases.length) {
  console.error("夹具里没有样本（failures: " + JSON.stringify(fixture.failures || []) + "）");
  process.exit(1);
}

/* ---------- 误差计算 ---------- */

/** 用给定标定系数重算所有样本与 AE 采样的误差 */
function evaluate(influenceScale, speedScale) {
  C.CALIBRATION.influenceScale = influenceScale;
  C.CALIBRATION.speedScale = speedScale;

  const rows = [];
  let weighted = 0;
  let worst = 0;

  for (const item of cases) {
    const prop = item.prop;
    const keys = prop.keys || [];
    const samples = item.samples || [];
    if (keys.length < 2) continue;

    // 各维量程：用来把绝对误差归一化（不然 2000px 的位置和 0.5 的
    // 参数没法放在一张表里比较）
    const dims = prop.dims || 1;
    const spans = [];
    for (let d = 0; d < dims; d++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const k of keys) {
        const v = Number(k.v[d] || 0);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      spans.push(Math.max(1e-6, hi - lo));
    }

    let maxAbs = 0;
    let maxRel = 0;
    const detail = [];

    for (let i = 0; i + 1 < keys.length; i++) {
      const seg = C.segmentOf(keys, i);
      if (!seg) continue;
      for (const sample of samples) {
        const t = Number(sample.t);
        if (t < seg.tA - 1e-9 || t > seg.tB + 1e-9) continue;
        // 关键帧时刻同时属于前后两段（定格段尤其歧义），跳过不判
        if (Math.abs(t - seg.tA) < 1e-9 || Math.abs(t - seg.tB) < 1e-9) continue;
        for (let d = 0; d < dims; d++) {
          const ae = Number(sample.v[d] || 0);
          const ours = C.sampleValue(seg, d, t);
          const abs = Math.abs(ours - ae);
          const rel = abs / spans[d];
          if (abs > maxAbs) maxAbs = abs;
          if (rel > maxRel) maxRel = rel;
          if (rel > 0.02) {
            detail.push({
              seg: i,
              dim: d,
              t: Number(t.toFixed(4)),
              ae: Number(ae.toFixed(4)),
              ours: Number(ours.toFixed(4)),
              rel: Number((rel * 100).toFixed(2)),
            });
          }
        }
      }
    }

    weighted += maxRel * maxRel;
    if (maxRel > worst) worst = maxRel;
    rows.push({
      id: item.id,
      dims,
      keys: keys.length,
      maxAbs,
      maxRel,
      detail,
      spatial: !!prop.spatial,
      sep: !!prop.sep,
    });
  }

  return { rows, weighted: Math.sqrt(weighted / Math.max(1, rows.length)), worst };
}

/* ---------- 诊断：AE 到底怎么存多维 ease ---------- */

function shareDiagnostics() {
  C.CALIBRATION.influenceScale = 1;
  C.CALIBRATION.speedScale = 1;
  const out = [];
  for (const item of cases) {
    const keys = item.prop.keys || [];
    const dims = item.prop.dims || 1;
    if (dims < 2 || keys.length < 2) continue;
    for (let i = 0; i + 1 < keys.length; i++) {
      const seg = C.segmentOf(keys, i);
      if (!seg) continue;
      const speeds = keys[i].os || [];
      // ne = AE 侧 ease 数组的真实长度（os 是模型按维度展开后的数组，不是它）
      out.push({
        id: item.id,
        seg: i,
        easeCount: Number(keys[i].ne || 0),
        speed: Number(speeds[0] || 0),
        chordMag: Number(seg.chordMag.toFixed(3)),
        ratio: seg.chordMag > 1e-9 ? Number((Number(speeds[0] || 0) / seg.chordMag).toFixed(4)) : 0,
      });
    }
  }
  return out;
}

/* ---------- 主流程 ---------- */

const base = evaluate(1, 1);

console.log("=== M4 曲线标定比对 ===");
console.log("夹具：" + fixturePath);
console.log("AE：" + (fixture.ae || "?") + " ｜ 样本 " + cases.length +
  " 个 ｜ 阈值 2% 量程\n");

const header = "样本".padEnd(22) + "维".padStart(3) + "键".padStart(4) +
  "最大绝对误差".padStart(14) + "最大相对误差".padStart(14) + "  结论";
console.log(header);
console.log("-".repeat(header.length + 6));

/**
 * 已知边界：分离维度（sep-*）。
 *
 * 把位置分离成 X/Y 之后，AE 仍保留原 2D 路径的空间切线 —— 即使某一轴
 * 首末值相同（弦为 0），它也会沿弧线鼓出来（实测 sep-x 在 1200 上鼓到 1274）。
 * 面板把分离后的单轴当独立一维曲线处理，拿不到另一轴的信息，因此这条
 * 差异是模型覆盖不到的，不算失败，但要如实列出来。
 */
const KNOWN_LIMIT = (id) => /^sep-/.test(id);

let failed = 0;
for (const row of base.rows) {
  const ok = row.maxRel <= 0.02;
  if (!ok && !KNOWN_LIMIT(row.id)) failed++;
  console.log(
    String(row.id).padEnd(22) +
    String(row.dims).padStart(3) +
    String(row.keys).padStart(4) +
    row.maxAbs.toFixed(4).padStart(14) +
    (row.maxRel * 100).toFixed(3).padStart(13) + "%" +
    (ok ? "  PASS" : (KNOWN_LIMIT(row.id) ? "  KNOWN-LIMIT" : "  FAIL")),
  );
  if (!ok) {
    for (const d of row.detail.slice(0, 6)) {
      console.log(
        "      段" + d.seg + " 维" + d.dim + " t=" + d.t +
        "  AE=" + d.ae + "  面板=" + d.ours + "  差 " + d.rel + "%",
      );
    }
    if (row.detail.length > 6) console.log("      … 其余 " + (row.detail.length - 6) + " 处超出阈值");
  }
}

console.log("\n--- 多维 ease 的实际形态 ---");
const diag = shareDiagnostics();
if (!diag.length) {
  console.log("夹具里没有多维样本，跳过。");
} else {
  for (const d of diag) {
    console.log(d.id + " 段" + d.seg + "  ease 数组长度 " + d.easeCount +
      "  speed=" + d.speed + "  路径速度=" + d.chordMag + "  比值=" + d.ratio);
  }
  const counts = new Set(diag.map((d) => d.easeCount));
  console.log(counts.size === 1 && counts.has(1)
    ? "结论：多维属性也只存 **1 个** ease（长度 >1 会直接报错）→ 统一时间重映射成立，"
      + "速度按路径模长解释；curvelib 已按这条实现。"
    : "结论：ease 数组长度不统一（" + [...counts].join("/") + "），需要复核。");
}

console.log("\n--- 标定系数搜索 ---");
let best = { inf: 1, spd: 1, score: base.weighted };
for (let inf = 0.2; inf <= 3.001; inf += 0.1) {
  for (let spd = 0.5; spd <= 2.001; spd += 0.1) {
    if (Math.abs(inf - 1) < 1e-9 && Math.abs(spd - 1) < 1e-9) continue;
    const r = evaluate(Number(inf.toFixed(2)), Number(spd.toFixed(2)));
    if (r.weighted < best.score - 1e-9) {
      best = { inf: Number(inf.toFixed(2)), spd: Number(spd.toFixed(2)), score: r.weighted };
    }
  }
}
C.CALIBRATION.influenceScale = 1;
C.CALIBRATION.speedScale = 1;

if (best.inf === 1 && best.spd === 1) {
  console.log("默认系数 (1.0, 1.0) 已是最优，无需修正。");
} else {
  const gain = ((base.weighted - best.score) / Math.max(1e-9, base.weighted)) * 100;
  console.log("建议 influenceScale=" + best.inf + "  speedScale=" + best.spd +
    "（RMS 相对误差 " + (base.weighted * 100).toFixed(3) + "% → " +
    (best.score * 100).toFixed(3) + "%，改善 " + gain.toFixed(1) + "%）");
  if (gain < 20) {
    console.log("改善幅度有限（<20%），大概率不是系数问题，先看上面的逐点差异。");
  } else {
    console.log("改善显著：把这两个数填进 engine/curvelib.jsx 的 CALIBRATION，再跑一次本工具确认。");
  }
}

const failCount = base.rows.filter((r) => r.maxRel > 0.02 && !KNOWN_LIMIT(r.id)).length;
const limitCount = base.rows.filter((r) => r.maxRel > 0.02 && KNOWN_LIMIT(r.id)).length;
console.log("\n=== 汇总 ===");
console.log("样本 " + base.rows.length + " ｜ 通过 " +
  (base.rows.length - failCount - limitCount) +
  " ｜ 已知边界 " + limitCount + "（分离维度）" +
  " ｜ 未通过 " + failCount + " ｜ 最差相对误差 " + (base.worst * 100).toFixed(3) + "%");
if (fixture.failures && fixture.failures.length) {
  console.log("夹具自报失败项：" + fixture.failures.join(" / "));
}
process.exitCode = failCount === 0 ? 0 : 1;
