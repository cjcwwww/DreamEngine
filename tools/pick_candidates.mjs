#!/usr/bin/env node
/* ============================================================
 * pick_candidates.mjs —— 离线挑出「下一批该渲哪些效果」
 *
 * 为什么要它：面板里的生成按钮走的是 CEP 点击，自动化不可靠；
 * 而候选筛选规则（排除过期/3D/文本生成器/分类轮转）写在 viewmodel 里，
 * 不该为了跑批而在 jsx 里再抄一份。这里复用同一套规则，输出一份名单给
 * tools/run_batch_generate.jsx 消费。
 *
 * 用法：node tools/pick_candidates.mjs [数量] [--out 路径]
 * 输出：每行 "matchName\t帧数"
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");
const CATALOG_DUMP = resolve(ROOT, "probe-results/AE2021/T0_1_full.tsv");

const limit = Number(process.argv[2]) || 48;
const outIndex = process.argv.indexOf("--out");
const outPath = outIndex > 0 ? process.argv[outIndex + 1] : resolve(ROOT, ".workbuddy/tmp/next_batch.tsv");

/* viewmodel 是浏览器脚本，套一层 window 就能在 node 里跑 */
const viewCtx = vm.createContext({ window: {} });
vm.runInContext(readFileSync(resolve(PANEL, "js/viewmodel.js"), "utf8"), viewCtx);
const view = viewCtx.AEV_ViewModel;

/* 本机效果清单（T0.1 实测导出，等于 catalog 的离线快照） */
function readCatalog() {
  const text = readFileSync(CATALOG_DUMP, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split("\t");
  const iMatch = header.indexOf("matchName");
  const iName = header.indexOf("displayName");
  const iCat = header.indexOf("category");
  return lines.map((line) => {
    const cells = line.split("\t");
    return {
      matchName: cells[iMatch] || "",
      displayName: cells[iName] || "",
      category: cells[iCat] || "",
    };
  });
}

const manifestPath = resolve(PANEL, "data/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const existing = new Set(manifest.items.map((item) => item.matchName));

const catalog = readCatalog().filter((effect) => {
  if (!effect.matchName) return false;
  if (effect.matchName.startsWith("Pseudo/")) return false;
  if (/Obsolete|过时/i.test(effect.category)) return false;
  return true;
});

const candidates = catalog.filter((effect) => {
  if (existing.has(effect.matchName)) return false;
  if (view.isNoPreview(effect.category)) return false;
  if (view.isPoorPreviewTarget(effect)) return false;
  // 只挑内置效果。实测：BCC / Sapphire / Universe 混在整网里会让 AE 硬崩溃
  // （进程直接消失，日志断在该批），而 L1 本来就该由内置效果构成。
  if (view.inferPlugin(effect) !== "内置") return false;
  return true;
});

const ordered = Array.from(view.interleaveByCategory(candidates)).slice(0, limit);

/* 帧数取定版配置，不要照抄已有条目——前 20 条是早期的单帧图，
   跟着它们走会把新预览也降级成单帧，丢掉悬停轮播。 */
const configText = readFileSync(resolve(ROOT, "config/render_params.jsxinc"), "utf8");
const frameMatch = configText.match(/frameCount:\s*(\d+)/);
const frames = frameMatch ? Number(frameMatch[1]) : 6;

const lines = ordered.map((effect) => `${effect.matchName}\t${frames}`);
writeFileSync(outPath, lines.join("\n") + "\n", "utf8");

console.log(`活跃效果 ${catalog.length} 个，已有预览 ${existing.size} 个，候选 ${candidates.length} 个`);
console.log(`本次挑出 ${ordered.length} 个 -> ${outPath}`);
ordered.slice(0, 12).forEach((effect, i) => {
  console.log(`  ${String(i + 1).padStart(2)}. ${effect.matchName} [${effect.category}]`);
});
if (ordered.length > 12) console.log(`  … 其余 ${ordered.length - 12} 个`);
