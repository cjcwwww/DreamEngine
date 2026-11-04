#!/usr/bin/env node
/* ============================================================
 * build_index.mjs —— 在 Node 侧重建预览索引（manifest.json + previews.tsv）
 *
 * 为什么需要：索引本来由 AE 侧写（CEP 没有写文件能力，jsx 拼 JSON 是既定做法），
 * 但 AE 写索引的时机绑在渲染流程里。一旦中间被打断（崩溃、覆盖、误装旧包），
 * 索引就和磁盘上的帧文件对不上了，而重建它必须开 AE——太重。
 *
 * 指纹算法住在 recipe.jsx 里，这里直接把它加载进 vm 求值，
 * 保证算出来的 key 与 AE 侧逐字节一致（不复制第二份实现）。
 *
 * 用法：node tools/build_index.mjs --entries <清单.tsv> [--data <目录>]
 *   清单每行：matchName \t sheet \t cell \t frames
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const DATA_DIR = resolve(arg("--data", resolve(ROOT, "cep/com.dreamengine.panel/data")));
const ENTRIES = resolve(arg("--entries", resolve(ROOT, ".workbuddy/tmp/entries.tsv")));
const CELL_SIZE = 256;
const COLUMNS = 8;
const WIDTH = 2048;
const HEIGHT = 2048;

if (!existsSync(ENTRIES)) {
  console.error("找不到清单：" + ENTRIES);
  process.exit(1);
}

/* ---- 加载 recipe.jsx 拿到指纹与场景规则（与 AE 侧同一份实现）---- */
const recipeCtx = vm.createContext({});
vm.runInContext(
  readFileSync(resolve(ROOT, "cep/com.dreamengine.panel/engine/recipe.jsx"), "utf8"),
  recipeCtx,
);
const recipe = recipeCtx.AEV_Recipe;

const ASSET_VERSION = "photo-v3"; // 与 engine/assets.jsx 的 VERSION 保持一致

function keyFor(matchName, frames) {
  const kind = recipe.assetKindFor(recipe.sceneFor(matchName));
  return recipe.cacheKey(matchName, kind + "@" + ASSET_VERSION, CELL_SIZE, frames);
}

/* ---- 读清单 ---- */
const rows = readFileSync(ENTRIES, "utf8")
  .replace(/\r/g, "")
  .split("\n")
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => {
    const c = line.split("\t");
    return {
      matchName: c[0],
      sheet: Number(c[1]) || 0,
      cell: Number(c[2]) || 0,
      frames: Number(c[3]) || 1,
    };
  });

if (!rows.length) {
  console.error("清单是空的");
  process.exit(1);
}

/* ---- 生成条目 ---- */
const items = [];
const indexLines = ["matchName\tsheet\tcell\tframes\tframeTemplate\tkey"];
const sheetsSeen = new Map();

for (const row of rows) {
  const x = (row.cell % COLUMNS) * CELL_SIZE;
  const y = Math.floor(row.cell / COLUMNS) * CELL_SIZE;
  const key = keyFor(row.matchName, row.frames);
  // 帧序列预览：文件名按 sheet 定，帧号用 %04d 占位
  const frameTemplate = `thumbs/batch_${String(row.sheet).padStart(3, "0")}_%04d.png`;
  const src = `thumbs/batch_${String(row.sheet).padStart(3, "0")}.png`;

  items.push({
    matchName: row.matchName,
    sheet: row.sheet,
    x,
    y,
    width: CELL_SIZE,
    height: CELL_SIZE,
    frames: row.frames,
    key,
    frameSrc: frameTemplate,
  });
  indexLines.push(
    [row.matchName, row.sheet, row.cell, row.frames, frameTemplate, key].join("\t"),
  );

  if (!sheetsSeen.has(row.sheet)) {
    sheetsSeen.set(row.sheet, {
      index: row.sheet,
      src: `thumbs/batch_${String(row.sheet).padStart(3, "0")}_0000.png`,
      width: WIDTH,
      height: HEIGHT,
    });
  }
}

const manifest = {
  version: 2,
  cellSize: CELL_SIZE,
  columns: COLUMNS,
  width: WIDTH,
  height: HEIGHT,
  sheets: [...sheetsSeen.values()].sort((a, b) => a.index - b.index),
  items,
};

writeFileSync(
  resolve(DATA_DIR, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8",
);
writeFileSync(resolve(DATA_DIR, "previews.tsv"), indexLines.join("\r\n"), "utf8");

const missing = items.filter((item) => {
  const file = resolve(DATA_DIR, item.frameSrc.replace("%04d", "0000"));
  return !existsSync(file);
});

console.log(`索引已重建：${items.length} 条，${manifest.sheets.length} 张网`);
console.log(`  指纹样例 ${items[0].matchName} -> ${items[0].key}`);
console.log(`  缺图 ${missing.length} 条`);
if (missing.length) {
  console.log("  " + missing.slice(0, 5).map((m) => m.matchName).join(", "));
}
