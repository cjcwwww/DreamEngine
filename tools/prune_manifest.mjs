#!/usr/bin/env node
/* ============================================================
 * prune_manifest.mjs —— 按目标清单裁剪预览索引
 *
 * 为什么需要：L1 的目标清单（l1-targets.tsv）会随需求变化——
 * 比如「未分类的效果不要」。但已渲染的帧文件还在磁盘上，
 * 索引里也还留着那些条目。直接重渲一遍太贵（本机 307 条要几分钟），
 * 而这里只需要把索引裁一刀。
 *
 * 裁剪后仍能正确打包：package_l1.mjs 会做全局重排，
 * 留下的条目会被重新填满整网。
 *
 * 用法：node tools/prune_manifest.mjs [--data <目录>] [--targets <清单>]
 *   默认清单：cep/com.dreamengine.panel/data/l1-targets.tsv
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const DATA_DIR = resolve(
  arg("--data", resolve(ROOT, "cep/com.dreamengine.panel/data")),
);
const TARGETS = resolve(
  arg("--targets", resolve(ROOT, "cep/com.dreamengine.panel/data/l1-targets.tsv")),
);

const manifestPath = resolve(DATA_DIR, "manifest.json");
const indexPath = resolve(DATA_DIR, "previews.tsv");

if (!existsSync(manifestPath)) {
  console.error("找不到 manifest.json：" + manifestPath);
  process.exit(1);
}
if (!existsSync(TARGETS)) {
  console.error("找不到目标清单：" + TARGETS);
  process.exit(1);
}

/* ---- 读保留名单 ---- */
const keep = new Set(
  readFileSync(TARGETS, "utf8")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")),
);

/* ---- 裁 manifest ---- */
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const before = manifest.items.length;
const removed = new Set();
manifest.items = manifest.items.filter((item) => {
  if (keep.has(item.matchName)) return true;
  removed.add(item.matchName);
  return false;
});

/* sheets 里可能整张都没有保留的条目了 —— 那些网不再被引用 */
const usedSheets = new Set(manifest.items.map((item) => item.sheet));
manifest.sheets = (manifest.sheets || []).filter((sheet) =>
  usedSheets.has(sheet.index),
);

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

/* ---- 裁 previews.tsv（同一批条目的另一种表示，必须同步裁）---- */
let indexTrimmed = false;
if (existsSync(indexPath)) {
  const lines = readFileSync(indexPath, "utf8").replace(/\r/g, "").split("\n");
  const header = lines.shift();
  const kept = lines.filter((line) => {
    if (!line) return false;
    const name = line.split("\t")[0];
    if (keep.has(name)) return true;
    removed.add(name);
    return false;
  });
  writeFileSync(indexPath, [header, ...kept].join("\r\n"), "utf8");
  indexTrimmed = true;
}

console.log(
  `索引已裁剪：${before} -> ${manifest.items.length} 条（移除 ${removed.size}）`,
);
console.log(`  剩余网 ${manifest.sheets.length} 张`);
if (indexTrimmed) console.log("  previews.tsv 已同步");
if (removed.size) {
  console.log("  移除样例：" + [...removed].slice(0, 8).join(", "));
}
