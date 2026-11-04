#!/usr/bin/env node
/* ============================================================
 * package_l1.mjs —— L1 内置包：帧间去重 + 打包
 *
 * 为什么做这个：静态效果的 6 帧内容完全相同（每帧约 46 KB），
 * 打包 L1 时就是 6 倍的纯浪费。而 AE 里多数效果本来就是静态的，
 * 只有用时间驱动的（运动模糊、湍流、时间置换等）才有帧间差异。
 *
 * 做法：逐张网比较各格子在 6 帧里的像素是否完全一致，
 *   · 全静态的网 → 只留第 1 帧，体积降到 1/6
 *   · 全动态的网 → 原样保留
 *   · 混在一起的网 → 拆成「静态网（单帧）」+「动态网（多帧）」并重排格位
 *
 * 用法：node tools/package_l1.mjs [--data 面板数据目录] [--out dist/L1]
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const png = require("./lib/png.cjs");

const ROOT = resolve(import.meta.dirname, "..");
const PANEL_DATA = resolve(ROOT, "cep/com.dreamengine.panel/data");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const DATA_DIR = resolve(arg("--data", PANEL_DATA));
const OUT_DIR = resolve(arg("--out", resolve(ROOT, "dist/L1")));
const CELL = 256;
const COLUMNS = 8;

const manifestPath = resolve(DATA_DIR, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error("找不到 manifest.json：" + manifestPath);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const WIDTH = manifest.width;
const HEIGHT = manifest.height;

/**
 * 渲染帧数：指纹是按「渲染参数」算的，而打包会把静态格子从 6 帧压成 1 帧。
 * 如果用打包后的帧数去比对指纹，会把「本来有效」的预览全判成过期
 * （实机踩过：60 条里 40 条被误报）。
 * 所以这里取的是**渲染时的帧数**：优先读源目录的 previews.tsv，没有就退回 manifest。
 */
const sourceIndex = resolve(DATA_DIR, "previews.tsv");
const renderFrames = new Map();
if (existsSync(sourceIndex)) {
  const lines = readFileSync(sourceIndex, "utf8").replace(/\r/g, "").split("\n");
  lines.shift();
  for (const line of lines) {
    if (!line) continue;
    const cells = line.split("\t");
    if (cells.length < 4) continue;
    renderFrames.set(cells[0], Number(cells[3]) || 1);
  }
}
for (const item of manifest.items) {
  if (!renderFrames.has(item.matchName)) {
    renderFrames.set(item.matchName, item.frames || 1);
  }
}

/* ---------- 基础工具 ---------- */

const sha = (buf) => createHash("sha1").update(buf).digest("hex");

function cellBox(cellIndex) {
  return {
    x: (cellIndex % COLUMNS) * CELL,
    y: Math.floor(cellIndex / COLUMNS) * CELL,
  };
}

function cellIndexOf(item) {
  return Math.floor(item.y / CELL) * COLUMNS + Math.floor(item.x / CELL);
}

/** 解码并统一成 RGB（3 通道），后面的取块/拼接都按 3 通道做 */
function loadRgb(file) {
  const image = png.decode(file);
  if (image.channels === 3) return image;
  const out = Buffer.alloc(image.width * image.height * 3);
  for (let i = 0, j = 0; i < image.data.length; i += 4, j += 3) {
    out[j] = image.data[i];
    out[j + 1] = image.data[i + 1];
    out[j + 2] = image.data[i + 2];
  }
  return { width: image.width, height: image.height, channels: 3, data: out };
}

/** 取一格（256×256）的像素 */
function cellRegion(image, cellIndex) {
  const box = cellBox(cellIndex);
  return png.region(image, box.x, box.y, CELL, CELL);
}

/** 把若干格按 slot 顺序拼成一张新网 */
function compose(cells, image) {
  const canvas = png.blank(WIDTH, HEIGHT);
  cells.forEach((cell, slot) => {
    const from = cellBox(cell);
    const to = cellBox(slot);
    const region = cellRegion(image, cell);
    for (let row = 0; row < CELL; row++) {
      region.copy(
        canvas.data,
        ((to.y + row) * WIDTH + to.x) * 3,
        row * CELL * 3,
        (row + 1) * CELL * 3,
      );
    }
    void from;
  });
  return canvas.data;
}

/* ---------- 收集：按 sheet 分组 ---------- */

const sheets = new Map();
for (const item of manifest.items) {
  if (!sheets.has(item.sheet)) sheets.set(item.sheet, []);
  sheets.get(item.sheet).push(item);
}
const sheetOrder = [...sheets.keys()].sort((a, b) => a - b);

let outSheetIndex = 0;
const outItems = [];
const outSheets = [];
let bytesBefore = 0;
let bytesAfter = 0;

/* 先写后清理：不清空输出目录。
   实测踩过——先 rmSync 整个目录再写，一旦中途失败（而且 rmSync 目录会被
   环境劫持到回收站、可能超时），旧包已经被删掉，只剩半截。
   现在写完再按「本次产出的文件清单」删多余文件，失败时旧包仍然完整。 */
mkdirSync(resolve(OUT_DIR, "thumbs"), { recursive: true });
const written = new Set();

function writeSheet(name, rgb) {
  const buf = png.encode(WIDTH, HEIGHT, rgb);
  writeFileSync(resolve(OUT_DIR, "thumbs", name), buf);
  written.add(name);
  bytesAfter += buf.length;
  return buf.length;
}

for (const sheetIndex of sheetOrder) {
  const items = sheets.get(sheetIndex);
  const frames = Math.max(...items.map((i) => i.frames || 1));
  const itemByCell = new Map();
  for (const item of items) itemByCell.set(cellIndexOf(item), item);

  /* --- 单文件网：原样拷贝 --- */
  if (!items[0].frameSrc) {
    const src = resolve(DATA_DIR, items[0].src);
    const name = `batch_${String(outSheetIndex).padStart(3, "0")}.png`;
    copyFileSync(src, resolve(OUT_DIR, "thumbs", name));
    written.add(name);
    bytesBefore += statSync(src).size;
    bytesAfter += statSync(resolve(OUT_DIR, "thumbs", name)).size;
    outSheets.push({ index: outSheetIndex, src: `thumbs/${name}`, width: WIDTH, height: HEIGHT });
    for (const item of items) {
      outItems.push({
        matchName: item.matchName,
        sheet: outSheetIndex,
        x: item.x,
        y: item.y,
        width: CELL,
        height: CELL,
        frames: 1,
        src: `thumbs/${name}`,
        key: item.key || "",
      });
    }
    outSheetIndex++;
    continue;
  }

  /* --- 帧序列网：判断每格是否静态 --- */
  const files = [];
  for (let f = 0; f < frames; f++) {
    const name = `batch_${String(sheetIndex).padStart(3, "0")}_${String(f).padStart(4, "0")}.png`;
    files.push(resolve(DATA_DIR, "thumbs", name));
  }
  for (const f of files) bytesBefore += statSync(f).size;

  const decoded = files.map(loadRgb);
  const cellIndexes = [...itemByCell.keys()].sort((a, b) => a - b);

  const staticCells = [];
  const animatedCells = [];
  for (const cell of cellIndexes) {
    const first = sha(cellRegion(decoded[0], cell));
    let same = true;
    for (let f = 1; f < decoded.length; f++) {
      if (sha(cellRegion(decoded[f], cell)) !== first) {
        same = false;
        break;
      }
    }
    (same ? staticCells : animatedCells).push(cell);
  }

  /* --- 全静态：只留第 1 帧 --- */
  if (animatedCells.length === 0) {
    const name = `batch_${String(outSheetIndex).padStart(3, "0")}.png`;
    writeSheet(name, compose(staticCells, decoded[0]));
    outSheets.push({ index: outSheetIndex, src: `thumbs/${name}`, width: WIDTH, height: HEIGHT });
    for (const cell of staticCells) {
      const item = itemByCell.get(cell);
      const to = cellBox(staticCells.indexOf(cell));
      outItems.push({
        matchName: item.matchName,
        sheet: outSheetIndex,
        x: to.x,
        y: to.y,
        width: CELL,
        height: CELL,
        frames: 1,
        src: `thumbs/${name}`,
        key: item.key || "",
      });
    }
    outSheetIndex++;
    continue;
  }

  /* --- 全动态：原样保留 --- */
  if (staticCells.length === 0) {
    const prefix = `batch_${String(outSheetIndex).padStart(3, "0")}`;
    decoded.forEach((image, f) => {
      writeSheet(`${prefix}_${String(f).padStart(4, "0")}.png`, image.data);
    });
    outSheets.push({ index: outSheetIndex, src: `thumbs/${prefix}_0000.png`, width: WIDTH, height: HEIGHT });
    for (const cell of animatedCells) {
      const item = itemByCell.get(cell);
      const to = cellBox(animatedCells.indexOf(cell));
      outItems.push({
        matchName: item.matchName,
        sheet: outSheetIndex,
        x: to.x,
        y: to.y,
        width: CELL,
        height: CELL,
        frames: decoded.length,
        frameSrc: `thumbs/${prefix}_%04d.png`,
        key: item.key || "",
      });
    }
    outSheetIndex++;
    continue;
  }

  /* --- 混合：拆成静态网 + 动态网并重排格位 --- */
  {
    const name = `batch_${String(outSheetIndex).padStart(3, "0")}.png`;
    writeSheet(name, compose(staticCells, decoded[0]));
    outSheets.push({ index: outSheetIndex, src: `thumbs/${name}`, width: WIDTH, height: HEIGHT });
    staticCells.forEach((cell, slot) => {
      const item = itemByCell.get(cell);
      const to = cellBox(slot);
      outItems.push({
        matchName: item.matchName,
        sheet: outSheetIndex,
        x: to.x,
        y: to.y,
        width: CELL,
        height: CELL,
        frames: 1,
        src: `thumbs/${name}`,
        key: item.key || "",
      });
    });
    outSheetIndex++;
  }
  {
    const prefix = `batch_${String(outSheetIndex).padStart(3, "0")}`;
    decoded.forEach((image, f) => {
      writeSheet(`${prefix}_${String(f).padStart(4, "0")}.png`, compose(animatedCells, image));
    });
    outSheets.push({ index: outSheetIndex, src: `thumbs/${prefix}_0000.png`, width: WIDTH, height: HEIGHT });
    animatedCells.forEach((cell, slot) => {
      const item = itemByCell.get(cell);
      const to = cellBox(slot);
      outItems.push({
        matchName: item.matchName,
        sheet: outSheetIndex,
        x: to.x,
        y: to.y,
        width: CELL,
        height: CELL,
        frames: decoded.length,
        frameSrc: `thumbs/${prefix}_%04d.png`,
        key: item.key || "",
      });
    });
    outSheetIndex++;
  }
}

/* ---------- 输出 ---------- */

outItems.sort((a, b) => a.sheet - b.sheet || a.y - b.y || a.x - b.x);

const outManifest = {
  version: 2,
  cellSize: manifest.cellSize,
  columns: manifest.columns,
  width: manifest.width,
  height: manifest.height,
  sheets: outSheets,
  items: outItems,
};
writeFileSync(resolve(OUT_DIR, "manifest.json"), JSON.stringify(outManifest, null, 2) + "\n", "utf8");

/* previews.tsv：缓存索引，描述每条预览的**渲染来源**。
   frames 列是渲染帧数（不是打包后的存储帧数）——指纹按渲染参数算，
   这里必须保持渲染帧数，否则 staleList 会把有效预览全判成过期。
   sheet/cell 列则是打包后的实际位置。 */
const indexLines = ["matchName\tsheet\tcell\tframes\tframeTemplate\tkey"];
for (const item of outItems) {
  const cell =
    Math.floor(item.y / manifest.cellSize) * manifest.columns +
    Math.floor(item.x / manifest.cellSize);
  indexLines.push(
    [
      item.matchName,
      String(item.sheet),
      String(cell),
      String(renderFrames.get(item.matchName) || item.frames || 1),
      item.frameSrc || "",
      item.key || "",
    ].join("\t"),
  );
}
writeFileSync(resolve(OUT_DIR, "previews.tsv"), indexLines.join("\r\n"), "utf8");

/* 名字表取仓库里的版本（它是源数据），而不是运行时目录里的那份——
   运行时那份可能是上一轮安装的旧包，拿它打包会形成循环依赖。 */
const namesSource = resolve(arg("--names", resolve(ROOT, "cep/com.dreamengine.panel/data/names.json")));
if (existsSync(namesSource)) {
  copyFileSync(namesSource, resolve(OUT_DIR, "names.json"));
} else if (existsSync(resolve(DATA_DIR, "names.json"))) {
  copyFileSync(resolve(DATA_DIR, "names.json"), resolve(OUT_DIR, "names.json"));
}
/* ---------- 清理本次没产出的旧文件 ---------- */

let pruned = 0;
for (const name of readdirSync(resolve(OUT_DIR, "thumbs"))) {
  if (written.has(name)) continue;
  try {
    unlinkSync(resolve(OUT_DIR, "thumbs", name));
    pruned++;
  } catch (e) {
    /* 删不掉就留着，不影响使用 */
  }
}

const animatedCount = outItems.filter((i) => (i.frames || 1) > 1).length;
const report = {
  // 不记构建时间：时间戳会让每次打包都产生一次无意义的版本差异
  source: DATA_DIR,
  items: outItems.length,
  staticItems: outItems.length - animatedCount,
  animatedItems: animatedCount,
  sheetsBefore: manifest.sheets.length,
  sheetsAfter: outSheets.length,
  bytesBefore,
  bytesAfter,
  ratio: bytesBefore > 0 ? Math.round((bytesAfter / bytesBefore) * 1000) / 10 : 0,
};
writeFileSync(resolve(OUT_DIR, "build-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

console.log("L1 打包完成");
console.log(`  条目 ${report.items}（静态 ${report.staticItems} / 动态 ${report.animatedItems}）`);
console.log(`  网 ${report.sheetsBefore} -> ${report.sheetsAfter}`);
console.log(
  `  体积 ${(bytesBefore / 1024 / 1024).toFixed(2)} MB -> ${(bytesAfter / 1024 / 1024).toFixed(2)} MB（${report.ratio}%）`,
);
console.log(`  输出 ${OUT_DIR}`);
