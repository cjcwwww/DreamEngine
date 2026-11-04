#!/usr/bin/env node
/* ============================================================
 * check_m4_live.mjs —— 判读 M4 实机验证的结果
 *
 * 输入（由 tools/run_m4_live.jsx 在 AE 里产出）：
 *   我的文档/DreamEngineProbe/M4_live_checks.json
 *
 * 判三件事：
 *   1. 往返：面板写回路径套上预设后，AE 实际存的 ease 是否等于预设意图，
 *      且 AE 自己 valueAtTime 的采样与我们按 CURVELIB 公式重算的曲线是否一致
 *   2. 并发：外部改动之后，用旧指纹写入必须被拒（status=conflict）
 *   3. 分离：改时间缓动不动空间切线；改空间切线不动时间缓动
 *
 * 用法：node tools/check_m4_live.mjs [报告路径]
 * ============================================================ */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import vm from "node:vm";
import assert from "node:assert/strict";

const ROOT = resolve(import.meta.dirname, "..");
const ENGINE = resolve(ROOT, "cep/com.dreamengine.panel/engine");
const DEFAULT = resolve(process.env.USERPROFILE || homedir(), "Documents/DreamEngineProbe/M4_live_checks.json");
const path = process.argv[2] || DEFAULT;

if (!existsSync(path)) {
  console.log("没有找到实机报告：" + path);
  console.log("先在 AE 里运行 tools/run_m4_live.jsx。");
  process.exit(0);
}

const ctx = vm.createContext({});
vm.runInContext(readFileSync(resolve(ENGINE, "curve_math.js"), "utf8"), ctx, { filename: "curve_math.js" });
vm.runInContext(readFileSync(resolve(ENGINE, "curvelib.jsx"), "utf8"), ctx, { filename: "curvelib.jsx" });
const C = ctx.AEV_Curve;

const live = JSON.parse(readFileSync(path, "utf8"));

let failed = 0;
const rows = [];
function check(name, fn) {
  try {
    fn();
    console.log("[PASS] " + name);
    rows.push({ name, ok: true });
  } catch (e) {
    failed++;
    rows.push({ name, ok: false });
    console.log("[FAIL] " + name);
    console.log("       " + String(e.message || e).split("\n").slice(0, 4).join("\n       "));
  }
}

console.log("=== M4 实机验证 ===");
console.log("AE " + live.ae + " ｜ 项目 " + live.project.file +
  " ｜ 夹具样本 " + live.fixtureCases + " 个");
console.log("工程项数 " + live.project.itemsBefore + " → " + live.project.itemsAfter);
if ((live.errors || []).length) console.log("脚本自报：" + live.errors.join(" / "));
console.log("");

/* ---------- 1. 预设意图：写进去的 ease 是否等于预设本身 ---------- */

function easeAt(key, side, dim) {
  // 快照里存的是数组：os/oi（出侧 speed/influence）、is/ii（入侧）
  const speeds = side === "out" ? key.os : key.is;
  const infs = side === "out" ? key.oi : key.ii;
  return {
    speed: Number((speeds && speeds[dim]) || 0),
    influence: Number((infs && infs[dim]) || 0),
  };
}

/** 预设意图表：只写我们真正验证的三条 */
const PRESET_INTENT = {
  ease: { influence: 33.33, speed: 0, sides: ["in", "out"] },
  strong: { influence: 75, speed: 0, sides: ["in", "out"] },
  "ease-out": { influence: 33.33, speed: 0, sides: ["out"] },
};

for (const item of live.roundtrip || []) {
  const id = item.id;
  const presetId = item.preset;
  const intent = PRESET_INTENT[presetId];
  const prop = item.prop;
  const keys = prop.keys || [];

  check(`往返 ${id}：预设 ${presetId} 的 ease 真的落到关键帧上`, () => {
    assert.ok(intent, "没有该预设的意图定义");
    assert.ok(keys.length >= 2, "关键帧不足");
    // 中间键两侧都该被改；首键只有出侧、末键只有入侧
    for (let k = 1; k < keys.length - 1; k++) {
      for (const side of intent.sides) {
        const e = easeAt(keys[k], side, 0);
        assert.ok(Math.abs(e.influence - intent.influence) < 0.6,
          `键${k} ${side} influence=${e.influence}，期望 ${intent.influence}`);
        assert.ok(Math.abs(e.speed - intent.speed) < 0.6,
          `键${k} ${side} speed=${e.speed}，期望 ${intent.speed}`);
      }
    }
  });

  check(`往返 ${id}：我们的公式与 AE 的求值一致（17 点采样）`, () => {
    const dims = prop.dims || 1;
    const samples = item.samples || [];
    let maxRel = 0;
    let worst = null;
    for (let d = 0; d < dims; d++) {
      let lo = Infinity, hi = -Infinity;
      for (const k of keys) {
        const v = Number(k.v[d] || 0);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      const span = Math.max(1e-6, hi - lo);
      for (const s of samples) {
        const t = Number(s.t);
        let seg = null;
        for (let i = 0; i + 1 < keys.length; i++) {
          const g = C.segmentOf(keys, i);
          if (g && t >= g.tA - 1e-9 && t <= g.tB + 1e-9) { seg = g; break; }
        }
        if (!seg) continue;
        const ae = Number(s.v[d] || 0);
        const ours = C.sampleValue(seg, d, t);
        const rel = Math.abs(ours - ae) / span;
        if (rel > maxRel) {
          maxRel = rel;
          worst = { d, t, ae, ours, rel };
        }
      }
    }
    assert.ok(maxRel <= 0.02,
      `最大相对误差 ${(maxRel * 100).toFixed(2)}%（${JSON.stringify(worst)}）`);
    console.log(`       ${id}：最大相对误差 ${(maxRel * 100).toFixed(3)}%`);
  });
}

/* ---------- 2. 并发 ---------- */

check("并发：外部改动后用旧指纹写入被拒", () => {
  const result = (live.conflict || {}).result || {};
  const status = typeof result === "string" ? result : String(result.status || "");
  assert.equal(status, "conflict", "没有返回 conflict：" + JSON.stringify(result));
  // 顺带确认它确实带回了「现值指纹」，而不是笼统报错
  if (typeof result === "object") {
    assert.ok(result.sig && result.sig !== (live.conflict || {}).sigBefore,
      "冲突返回没带上变化后的指纹");
  }
  const sigBefore = String((live.conflict || {}).sigBefore || "");
  assert.ok(sigBefore.length > 2, "没拿到写入前指纹");
});

/* ---------- 3. 路径与时间分离 ---------- */

check("分离：改时间缓动不动空间切线", () => {
  const p = live.path || {};
  const before = JSON.stringify(p.outTanBefore);
  const after = JSON.stringify(p.outTanAfterTemporal);
  assert.equal(after, before, "时间缓动改动了空间切线：" + before + " → " + after);
  // 同时确认缓动确实被改了（否则这条断言是空的）
  assert.notDeepEqual(p.easeAfterTemporal, p.easeBefore, "时间缓动没生效，断言无效");
});

check("分离：改空间切线不动时间缓动", () => {
  const p = live.path || {};
  assert.deepEqual(p.easeAfterTangent, p.easeAfterTemporal, "改切线把时间缓动带走了");
  assert.notDeepEqual(p.outTanAfterTangent, p.outTanBefore, "切线没写进去，断言无效");
});

/* ---------- 汇总 ---------- */

console.log("\n=== 汇总 ===");
console.log(`检查 ${rows.length} 项 ｜ 通过 ${rows.length - failed} ｜ 失败 ${failed}`);
if ((live.notes || []).length) console.log("备注：" + live.notes.join(" / "));
console.log("撤销（Ctrl+Z）无法用脚本代验：app.executeCommand(Undo) 会撤掉用户自己的操作，");
console.log("所以这一条留作人工确认（写回已包在单个 undo 组里，源码契约有断言）。");
process.exitCode = failed === 0 ? 0 : 1;
