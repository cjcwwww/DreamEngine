#!/usr/bin/env node
/* ============================================================
 * check_plugin_previews.mjs —— 运行时插件预览体检
 *
 * 面板侧读的是运行时目录（CEP 扩展 → 主工作副本）的两个索引：
 *   data/manifest.json        内置 L1 整网（8×8）
 *   data/plugin_manifest.json 插件 L2 单格（1×1）
 * 这个脚本按面板的真实逻辑（library.js 的合并 + viewmodel 的切片）走一遍，
 * 找出「索引里有、图却不在」「切片算错」「黑名单仍被当成可渲染」等问题。
 *
 * 用法：node tools/check_plugin_previews.mjs [--data 目录]
 * ============================================================ */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");
function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const runtimePanel = resolve(
  process.env.APPDATA || "",
  "Adobe/CEP/extensions/com.dreamengine.panel",
);
const dataDir = resolve(arg("--data", resolve(runtimePanel, "data")));

const ctx = vm.createContext({ window: {} });
vm.runInContext(readFileSync(resolve(PANEL, "js/viewmodel.js"), "utf8"), ctx);
const view = ctx.AEV_ViewModel;

function loadJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

const l1 = loadJson(resolve(dataDir, "manifest.json"));
const l2 = loadJson(resolve(dataDir, "plugin_manifest.json"));
const blacklist = loadJson(resolve(dataDir, "plugin_blacklist.json"));

console.log(`索引目录：${dataDir}`);
console.log(`内置 L1：${l1 ? l1.items.length + " 条" : "无"}`);
console.log(`插件 L2：${l2 ? l2.items.length + " 条" : "无"}`);
console.log(`插件黑名单：${blacklist ? blacklist.items.length + " 条" : "无"}`);

let problems = 0;
function problem(text) {
  problems++;
  console.log("  [问题] " + text);
}

/* ---- 插件索引：文件存在性 + 切片 ---- */
if (l2) {
  let missing = 0;
  let badSlice = 0;
  let noMeta = 0;
  for (const item of l2.items || []) {
    if (!item.frameSrc && !item.src) {
      noMeta++;
      continue;
    }
    const file = resolve(dataDir, item.src || item.frameSrc.replace("%04d", "0000"));
    if (!existsSync(file)) {
      missing++;
      if (missing <= 5) problem(`图不存在：${item.matchName} -> ${item.src || item.frameSrc}`);
    }
    // 面板按条目自带的 slice* 字段算切片；缺了就��套整网参数 → 整张错位
    if (!item.sliceColumns || !item.sliceCellSize) {
      noMeta++;
      if (noMeta <= 5) problem(`条目缺 slice* 布局字段：${item.matchName}`);
      continue;
    }
    const slice = view.spriteSlice(item, l1);
    if (slice.size !== "100.0000% 100.0000%" || slice.position !== "0.0000% 0.0000%") {
      badSlice++;
      if (badSlice <= 5) {
        problem(`切片算错：${item.matchName} size=${slice.size} position=${slice.position}`);
      }
    }
  }
  console.log(
    `插件条目检查：${(l2.items || []).length} 条，缺图 ${missing}，切片异常 ${badSlice}，元信息缺失 ${noMeta}`,
  );
}

/* ---- 黑名单与索引不应互相矛盾 ---- */
if (blacklist && l2) {
  const black = new Set((blacklist.items || []).map((i) => i.matchName));
  const stillThere = (l2.items || []).filter((i) => black.has(i.matchName));
  if (stillThere.length) {
    problem(`${stillThere.length} 条已在黑名单里却仍出现在索引中：${stillThere.slice(0, 3).map((i) => i.matchName).join("、")}`);
  }
}

/* ---- 面板合并后的总条目数（内置 + 插件） ---- */
if (l1 && l2) {
  const merged = new Set((l1.items || []).map((i) => i.matchName));
  let overlap = 0;
  for (const item of l2.items || []) {
    if (merged.has(item.matchName)) overlap++;
    merged.add(item.matchName);
  }
  console.log(`面板可显示条目：${merged.size} 条（内置 ${l1.items.length} + 插件 ${l2.items.length}${overlap ? "，重叠 " + overlap : ""}）`);
}

console.log(problems === 0 ? "\n全部通过：没有发现问题。" : `\n发现 ${problems} 个问题。`);
if (problems > 0) process.exitCode = 1;
