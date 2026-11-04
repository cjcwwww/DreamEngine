#!/usr/bin/env node
/* ============================================================
 * install_l1.mjs —— 把打包好的 L1 内置包装进扩展数据目录
 *
 * 用途：dist/L1 是可分发的内置包（预览图 + 索引 + 名字表），
 * 装进扩展目录后面板就直接用这套预生成预览，不再依赖本机渲染。
 *
 * 会先备份现有 manifest.json，避免覆盖后无法回退。
 *
 * 用法：node tools/install_l1.mjs [--package dist/L1] [--target 扩展数据目录]
 * ============================================================ */

import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const PKG_DIR = resolve(arg("--package", resolve(ROOT, "dist/L1")));
const TARGET = resolve(
  arg("--target", resolve(ROOT, "cep/com.dreamengine.panel/data")),
);

if (!existsSync(resolve(PKG_DIR, "manifest.json"))) {
  console.error("找不到 L1 包：" + resolve(PKG_DIR, "manifest.json"));
  console.error("先跑 node tools/package_l1.mjs 生成。");
  process.exit(1);
}

mkdirSync(resolve(TARGET, "thumbs"), { recursive: true });

/* 备份旧索引 */
const oldManifest = resolve(TARGET, "manifest.json");
if (existsSync(oldManifest)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backup = resolve(TARGET, `manifest.json.backup-${stamp}`);
  copyFileSync(oldManifest, backup);
  console.log("已备份旧索引 → " + backup);
}

/* 复制预览图 */
const srcThumbs = resolve(PKG_DIR, "thumbs");
let copied = 0;
let bytes = 0;
for (const name of readdirSync(srcThumbs)) {
  if (!name.endsWith(".png")) continue;
  const from = resolve(srcThumbs, name);
  const to = resolve(TARGET, "thumbs", name);
  copyFileSync(from, to);
  copied++;
  bytes += statSync(to).size;
}

/* 复制索引与名字表 */
copyFileSync(resolve(PKG_DIR, "manifest.json"), oldManifest);
if (existsSync(resolve(PKG_DIR, "names.json"))) {
  copyFileSync(resolve(PKG_DIR, "names.json"), resolve(TARGET, "names.json"));
}

/* 校验 */
const manifest = JSON.parse(
  await import("node:fs").then((fs) => fs.readFileSync(oldManifest, "utf8")),
);
let missing = 0;
for (const item of manifest.items) {
  const file = item.frameSrc
    ? item.frameSrc.replace("%04d", "0000")
    : item.src;
  if (!existsSync(resolve(TARGET, file))) missing++;
}

/* 同步 previews.tsv：它与 manifest 必须是同一份条目的两种表示，
   staleList 靠它判过期，两边不一致会得出错误的过期结论。 */
const indexLines = ["matchName\tsheet\tcell\tframes\tframeTemplate\tkey"];
for (const item of manifest.items) {
  indexLines.push(
    [
      item.matchName,
      String(item.sheet),
      String(Math.floor(item.y / manifest.cellSize) * manifest.columns +
        Math.floor(item.x / manifest.cellSize)),
      String(item.frames || 1),
      item.frameSrc || "",
      item.key || "",
    ].join("\t"),
  );
}
writeFileSync(resolve(TARGET, "previews.tsv"), indexLines.join("\r\n"), "utf8");

console.log("L1 安装完成");
console.log(`  预览图 ${copied} 个（${(bytes / 1024 / 1024).toFixed(2)} MB）`);
console.log(`  索引条目 ${manifest.items.length} 条，缺图 ${missing} 个`);
console.log(`  目标 ${TARGET}`);
if (missing > 0) process.exitCode = 1;
