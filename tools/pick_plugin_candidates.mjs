#!/usr/bin/env node
/* ============================================================
 * pick_plugin_candidates.mjs —— 挑出「下一批该渲哪些插件效果」
 *
 * 与 pick_candidates.mjs 的区别：那个只挑内置效果（L1 整网混渲），
 * 这个只挑第三方插件（L2 逐条隔离渲染）。两者共用 viewmodel 的排除规则，
 * 但内置/插件的分界用 isBuiltinEffect(matchName 前缀) 判定，绝不能混。
 *
 * 跳过三类：已有 L1 预览、已有插件 L2 预览、崩溃黑名单里的元凶。
 *
 * 用法：node tools/pick_plugin_candidates.mjs [--limit 24] [--plugin BCC]
 *        [--out 路径] [--catalog 路径]
 * 输出：每行 "matchName \t 帧数 \t 插件包"
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const limit = Number(arg("--limit", "24")) || 24;
const pluginFilter = arg("--plugin", "");
const catalogPath = resolve(arg("--catalog", resolve(ROOT, "probe-results/AE2021/T0_1_full.tsv")));
const outPath = resolve(arg("--out", resolve(ROOT, ".workbuddy/tmp/next_plugin_batch.tsv")));
const probeDir = resolve(homedir(), "Documents/DreamEngineProbe");
const blacklistPath = resolve(arg("--blacklist", resolve(probeDir, "plugin_blacklist.tsv")));

/* viewmodel 与 plugin_state 都是浏览器/ExtendScript 脚本，套一层 vm 就能在 Node 跑 */
function loadScript(path, globalName) {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(readFileSync(path, "utf8"), ctx);
  return ctx[globalName];
}
const view = loadScript(resolve(PANEL, "js/viewmodel.js"), "AEV_ViewModel");
const pluginState = loadScript(resolve(PANEL, "engine/plugin_state.jsx"), "AEV_PluginState");

function readCatalog(path) {
  const lines = readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split("\t");
  const iMatch = header.indexOf("matchName");
  const iName = header.indexOf("displayName");
  const iCat = header.indexOf("category");
  return lines.map((line) => {
    const c = line.split("\t");
    return {
      matchName: c[iMatch] || "",
      displayName: c[iName] || "",
      category: c[iCat] || ""
    };
  });
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/* 已有预览：L1 主索引 + 插件 L2 索引。
   索引优先读运行时目录（CEP 扩展 Junction → 主工作副本），
   读不到再退回仓库里的 data/ —— 否则「已生成过」的条目会被重复挑走。 */
const runtimePanel = resolve(
  process.env.APPDATA || "",
  "Adobe/CEP/extensions/com.dreamengine.panel",
);
function pickDataDir() {
  const dirs = [resolve(runtimePanel, "data"), resolve(PANEL, "data")];
  for (const dir of dirs) {
    if (existsSync(resolve(dir, "manifest.json"))) return dir;
  }
  return dirs[0];
}
const dataDir = resolve(arg("--data", pickDataDir()));

const existing = new Set();
const l1Path = resolve(dataDir, "manifest.json");
if (existsSync(l1Path)) {
  const manifest = JSON.parse(readFileSync(l1Path, "utf8"));
  for (const item of manifest.items || []) existing.add(item.matchName);
}
const done = new Set(
  pluginState.readEntries(readText(resolve(dataDir, "plugin_previews.tsv")))
    .map((e) => e.matchName),
);
const blacklist = pluginState.readBlacklist(readText(blacklistPath));
/* 面板那份黑名单是 JSON（面板读不到 TSV），两边合并，避免重复挑中元凶 */
const panelBlack = resolve(dataDir, "plugin_blacklist.json");
if (existsSync(panelBlack)) {
  try {
    const parsed = JSON.parse(readFileSync(panelBlack, "utf8"));
    for (const item of parsed.items || []) {
      if (item.matchName) blacklist[item.matchName] = item.reason || "crash";
    }
  } catch (e) {
    console.warn("忽略无法解析的黑名单文件：" + panelBlack);
  }
}

const candidates = readCatalog(catalogPath).filter((effect) => {
  if (!effect.matchName) return false;
  if (view.isExcludable(effect)) return false;
  if (view.isNoPreview(effect.category)) return false;
  // 安全边界：内置效果走 L1 整网，绝不进插件逐条通道
  if (view.isBuiltinEffect(effect)) return false;
  if (existing.has(effect.matchName)) return false;
  if (done.has(effect.matchName)) return false;
  if (blacklist[effect.matchName]) return false;
  if (pluginFilter && view.inferPlugin(effect) !== pluginFilter) return false;
  return true;
});

/** 按插件包轮转：首批就覆盖多个包，不会一口气全是 BCC */
function interleaveByPlugin(list) {
  const buckets = {};
  const order = [];
  for (const effect of list) {
    const key = view.inferPlugin(effect);
    if (!buckets[key]) { buckets[key] = []; order.push(key); }
    buckets[key].push(effect);
  }
  order.sort((a, b) => buckets[b].length - buckets[a].length);
  const out = [];
  const cursors = {};
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const key of order) {
      const at = cursors[key] || 0;
      if (at < buckets[key].length) {
        out.push(buckets[key][at]);
        cursors[key] = at + 1;
        progressed = true;
      }
    }
  }
  return out;
}

const ordered = interleaveByPlugin(candidates);
const picked = ordered.slice(0, limit);
/* 插件预览的帧数：1 帧。
   插件效果不打关键帧（参数是保守启发式拨的，动起来会失真），
   6 帧内容完全相同 —— 只渲 1 帧，省 5/6 的磁盘与面板加载开销。
   内置效果走 pick_candidates.mjs，那边仍然是 6 帧（有动画）。 */
const frames = 1;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  "# matchName\tframes\tplugin\n" +
    picked.map((e) => `${e.matchName}\t${frames}\t${view.inferPlugin(e)}`).join("\n") +
    "\n",
  "utf8",
);

const byPlugin = {};
for (const e of picked) {
  const key = view.inferPlugin(e);
  byPlugin[key] = (byPlugin[key] || 0) + 1;
}
console.log(`活跃插件候选 ${candidates.length} 条；已有 L1 预览 ${existing.size} 条、L2 预览 ${done.size} 条、黑名单 ${Object.keys(blacklist).length} 条`);
console.log(`  索引目录：${dataDir}`);
console.log(`本次挑出 ${picked.length} 条（每批最多 ${limit} 条）-> ${outPath}`);
console.log(`  按包：${Object.entries(byPlugin).map(([k, n]) => `${k} ${n}`).join(" / ") || "无"}`);
picked.slice(0, 10).forEach((e, i) => {
  console.log(`  ${String(i + 1).padStart(2)}. ${e.matchName} [${view.inferPlugin(e)}]`);
});
if (picked.length > 10) console.log(`  … 其余 ${picked.length - 10} 条`);
console.log("\n下一步：把名单复制到用户文档目录，关闭 AE 后运行离线脚本：");
console.log(`  Copy-Item "${outPath}" "${resolve(probeDir, "next_plugin_batch.tsv")}"`);
console.log('  & "C:\\Program Files\\Adobe\\Adobe After Effects 2021\\Support Files\\AfterFX.exe" -r "' +
  resolve(ROOT, "tools/run_plugin_preview.jsx").replace(/\//g, "\\") + '"');
