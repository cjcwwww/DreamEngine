#!/usr/bin/env node
/* ============================================================
 * build_l1_targets.mjs —— 生成 L1 内置包的目标清单
 *
 * 为什么要有这个脚本：L1 要覆盖「绝大多数常用效果」，
 * 清单必须能从本机 catalog 导出、可复现、可审计，
 * 而不是手写一长串名字。
 *
 * 数据来源：probe-results/AE2021/T0_1_full.tsv（M0 T0.1 实测导出，入库）
 * 排除规则与面板侧 viewmodel.isPoorPreviewTarget 保持一致，
 * 再额外排掉音频族（本来就不渲图）。
 *
 * 排序：按分类轮转，热门分类优先 —— 预览墙的顺序就是渲染顺序，
 * 常用的效果必须排在前面。
 *
 * 用法：node tools/build_l1_targets.mjs [--out 目标文件]
 * ============================================================ */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const DUMP = resolve(ROOT, "probe-results/AE2021/T0_1_full.tsv");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const OUT = resolve(arg("--out", resolve(ROOT, "cep/com.dreamengine.panel/data/l1-targets.tsv")));

/* 复用面板侧的排除与排序规则，避免两套判断漂移 */
const viewCtx = vm.createContext({ window: {} });
vm.runInContext(readFileSync(resolve(ROOT, "cep/com.dreamengine.panel/js/viewmodel.js"), "utf8"), viewCtx);
const view = viewCtx.AEV_ViewModel;

/* ---- 读 catalog 导出 ---- */
const lines = readFileSync(DUMP, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
const header = lines.shift().split("\t");
const iMatch = header.indexOf("matchName");
const iName = header.indexOf("displayName");
const iCat = header.indexOf("category");
const effects = lines.map((line) => {
  const c = line.split("\t");
  return {
    matchName: c[iMatch] || "",
    displayName: c[iName] || "",
    category: c[iCat] || "",
  };
});

/* ---- 过滤 ---- */
const BUILTIN = /^(ADBE|APC|CC) /;
const kept = effects.filter((e) => {
  if (!e.matchName) return false;
  if (!BUILTIN.test(e.matchName)) return false; // 只收内置（第三方整批混渲会让 AE 崩溃）
  if (view.isNoPreview(e.category)) return false; // 音频族本来就不渲图
  if (view.isExcludable(e)) return false; // 过期项 / 3D 通道 / 弹框类 / 挂起类 / CS 旧命名
  return true;
});

/* ---- 显式的「常用效果」清单 ----
 * 为什么要显式写：AE 内部效果注册顺序不等于菜单顺序，更不等于使用频率。
 * 预览墙第一屏放什么，直接决定别人装完后的第一印象，
 * 所以这里手工列出大多数人真正在用的那批，排在最前。
 * 名字取自本机实测导出的 matchName（写错的名字会被脚本报出来）。
 */
const CURATED = [
  // 模糊与锐化
  "ADBE Gaussian Blur 2", "ADBE Box Blur2", "ADBE Radial Blur", "ADBE Motion Blur",
  "ADBE Sharpen", "ADBE Unsharp Mask2", "CC Radial Fast Blur", "CC Radial Blur", "CC Vector Blur",
  // 调色
  "ADBE Brightness & Contrast 2", "ADBE CurvesCustom", "ADBE Easy Levels2", "ADBE Pro Levels2",
  "ADBE HUE SATURATION", "ADBE Tint", "ADBE Color Balance 2", "ADBE Lumetri", "APC Colorama",
  "ADBE Black&White", "ADBE PhotoFilterPS", "ADBE CHANNEL MIXER", "ADBE Tritone",
  "ADBE Leave Color", "ADBE Change Color", "ADBE Threshold2", "ADBE Exposure2", "ADBE Equalize",
  // 扭曲与变形
  "ADBE Turbulent Displace", "ADBE Wave Warp", "ADBE Ripple", "ADBE Bulge", "ADBE Twirl",
  "ADBE Corner Pin", "ADBE WRPMESH", "ADBE BEZMESH", "ADBE Displacement Map", "ADBE Mirror",
  "ADBE Offset", "ADBE Polar Coordinates", "ADBE Geometry2",
  // 风格化
  "ADBE Glo2", "ADBE Drop Shadow", "ADBE Bevel Alpha", "ADBE Posterize", "ADBE Mosaic",
  "ADBE Find Edges", "CC Kaleida", "CC Plastic", "CC Burn Film", "CC Glass", "CC Slant",
  // 生成
  "ADBE Ramp", "ADBE Fill", "ADBE 4ColorGradient", "ADBE Fractal Noise",
  "ADBE Dust & Scratches",
  // 抠像
  "ADBE Color Difference Key", "ADBE Linear Color Key2",
  // 通道与遮罩
  "ADBE Set Matte3", "ADBE Compound Blur", "ADBE Calculations", "ADBE Arithmetic",
  // 时间
  "ADBE Timewarp", "CC Force Motion Blur",
];

/* ---- 排序：常用清单优先，其余按分类轮转 ---- */
/* 同一分类内先排 ADBE（经典内置）再 APC 再 CC：
   预览墙的顺序就是渲染顺序，ADBE 那些才是大多数人真正在用的效果。 */
const PREFIX_RANK = { ADBE: 0, APC: 1, CC: 2 };
const curatedIndex = new Map(CURATED.map((n, i) => [n, i]));

const withOrder = kept.map((e, i) => ({
  effect: e,
  prefix: PREFIX_RANK[String(e.matchName).split(" ")[0]] ?? 9,
  index: i,
}));
withOrder.sort((a, b) => a.prefix - b.prefix || a.index - b.index);
const rotated = Array.from(view.interleaveByCategory(withOrder.map((x) => x.effect)));

/* 常用清单提到最前，其余保持分类轮转顺序 */
const curated = [];
const rest = [];
for (const e of rotated) {
  if (curatedIndex.has(e.matchName)) curated.push(e);
  else rest.push(e);
}
curated.sort((a, b) => curatedIndex.get(a.matchName) - curatedIndex.get(b.matchName));
const ordered = curated.concat(rest);

/* ---- 写出 ---- */
const linesOut = [
  "# L1 内置包目标清单 —— 由 tools/build_l1_targets.mjs 从本机 catalog 导出",
  "# 覆盖本机绝大多数常用内置效果；顺序即预览墙顺序（热门分类在前）",
  "# matchName",
  ...ordered.map((e) => e.matchName),
];
writeFileSync(OUT, linesOut.join("\n") + "\n", "utf8");

/* ---- 统计 ---- */
const byCat = {};
for (const e of kept) byCat[e.category || "未分类"] = (byCat[e.category || "未分类"] || 0) + 1;
console.log(`L1 目标：${ordered.length} 条 -> ${OUT}`);
console.log(`  预计 ${Math.ceil(ordered.length / 64)} 张网`);
console.log("  分类分布：");
for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`    ${k}: ${v}`);
}
// 报出清单里写了但本机没有的名字
const present=new Set(kept.map(e=>e.matchName));
const missing=CURATED.filter(n=>!present.has(n));
if(missing.length) console.log("  ⚠ 清单里本机不存在的效果（"+missing.length+"）："+missing.join(", "));
console.log("  前 12 条：");
ordered.slice(0, 10).forEach((e, i) => console.log(`    ${i + 1}. ${e.matchName}`));
