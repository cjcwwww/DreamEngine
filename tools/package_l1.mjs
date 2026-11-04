#!/usr/bin/env node
/* ============================================================
 * package_l1.mjs —— L1 内置包打包器：帧间去重 + 全局重排
 *
 * 两件事：
 *   1. 帧间去重：逐格比较各帧像素，静态格子压成单帧（静态效果的 6 帧是纯浪费）
 *   2. 全局重排：静态与动态各自填满整网。
 *      渲染时是「每 8 个一张网」，直接打包会浪费 87% 的画布；
 *      重排后 307 条只占 5~6 张网。
 *
 * 关键约束：打包只允许改变存储方式，不允许改变画面。
 * 所以每条都做逐格像素比对（tools/test-package.mjs 里有同样的断言）。
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

const manifestPath = resolve(DATA_DIR, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error("找不到 manifest.json：" + manifestPath);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
// 格子尺寸与列数取自 manifest —— 渲染参数改过（256 -> 128）之后写死会取错格子
const CELL = manifest.cellSize;
const COLUMNS = manifest.columns;
const WIDTH = manifest.width;
const HEIGHT = manifest.height;
const PER_SHEET = COLUMNS * COLUMNS;

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

/** 解码并统一成 RGB（3 通道） */
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

function cellRegion(image, cellIndex) {
  const box = cellBox(cellIndex);
  return png.region(image, box.x, box.y, CELL, CELL);
}

/* ---------- 渲染帧数：指纹按渲染参数算，不能用打包后的帧数 ---------- */
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

/* ---------- 输出流：静态（单帧）与动态（多帧）各自填满整网 ---------- */

mkdirSync(resolve(OUT_DIR, "thumbs"), { recursive: true });
const written = new Set();
let bytesBefore = 0;
let bytesAfter = 0;

function writeFile(name, buf) {
  writeFileSync(resolve(OUT_DIR, "thumbs", name), buf);
  written.add(name);
  bytesAfter += buf.length;
}

const outItems = [];
const outSheets = [];

/* 静态流与动态流共用一个网号计数器 —— 各自从 0 开始会写同名文件互相覆盖 */
const sheetCounter = { next: 0 };

/** 静态流：一张网存满 64 个格子就落盘 */
const staticStream = {
  buffer: null,
  cursor: 0,
  sheetIndex: -1,
  open() {
    // 网号在「开缓冲」时就占下来，条目引用的是这一版；
    // 若等到落盘才占号，静态流与动态流交错时引用会指向别人的网。
    this.sheetIndex = sheetCounter.next++;
    this.buffer = png.blank(WIDTH, HEIGHT);
    this.cursor = 0;
  },
  place(region, slot) {
    const to = cellBox(slot);
    const ch = 3;
    for (let row = 0; row < CELL; row++) {
      region.copy(
        this.buffer.data,
        ((to.y + row) * WIDTH + to.x) * ch,
        row * CELL * ch,
        (row + 1) * CELL * ch,
      );
    }
  },
  flush() {
    if (!this.buffer || this.cursor === 0) return;
    const name = `batch_${String(this.sheetIndex).padStart(3, "0")}.png`;
    writeFile(name, png.encode(WIDTH, HEIGHT, this.buffer.data));
    outSheets.push({ index: this.sheetIndex, src: `thumbs/${name}`, width: WIDTH, height: HEIGHT });
    this.buffer = null;
  },
};

/** 动态流：一组帧共用同一张网的格位 */
const animStream = {
  buffers: [],
  cursor: 0,
  sheetIndex: -1,
  frames: 0,
  open(frameCount) {
    this.sheetIndex = sheetCounter.next++;
    this.buffers = [];
    for (let f = 0; f < frameCount; f++) this.buffers.push(png.blank(WIDTH, HEIGHT));
    this.cursor = 0;
    this.frames = frameCount;
  },
  place(region, frameIndex, slot) {
    const to = cellBox(slot);
    const ch = 3;
    for (let row = 0; row < CELL; row++) {
      region.copy(
        this.buffers[frameIndex].data,
        ((to.y + row) * WIDTH + to.x) * ch,
        row * CELL * ch,
        (row + 1) * CELL * ch,
      );
    }
  },
  flush() {
    if (!this.buffers.length || this.cursor === 0) return;
    const prefix = `batch_${String(this.sheetIndex).padStart(3, "0")}`;
    for (let f = 0; f < this.buffers.length; f++) {
      writeFile(
        `${prefix}_${String(f).padStart(4, "0")}.png`,
        png.encode(WIDTH, HEIGHT, this.buffers[f].data),
      );
    }
    outSheets.push({ index: this.sheetIndex, src: `thumbs/${prefix}_0000.png`, width: WIDTH, height: HEIGHT });
    this.buffers = [];
  },
};

/* ---------- 逐张源网处理 ---------- */

const sheets = new Map();
for (const item of manifest.items) {
  if (!sheets.has(item.sheet)) sheets.set(item.sheet, []);
  sheets.get(item.sheet).push(item);
}
const sheetOrder = [...sheets.keys()].sort((a, b) => a - b);

for (const sheetIndex of sheetOrder) {
  const items = sheets.get(sheetIndex);
  const itemByCell = new Map();
  for (const item of items) itemByCell.set(cellIndexOf(item), item);

  /* 一张源网里可能同时有「单文件条目」和「帧序列条目」——
     早期版本的打包器给两者分配了同一个网号，于是索引里出现混合网。
     所以这里按**条目**判断，而不是看这张网的第一个条目。 */
  let singleImage = null;
  let decoded = null;

  const needSingle = items.some((i) => !i.frameSrc);
  const needFrames = items.some((i) => i.frameSrc);

  if (needSingle) {
    const singleFile = resolve(DATA_DIR, "thumbs", `batch_${String(sheetIndex).padStart(3, "0")}.png`);
    if (existsSync(singleFile)) {
      bytesBefore += statSync(singleFile).size;
      singleImage = loadRgb(singleFile);
    }
  }
  if (needFrames) {
    const frames = Math.max(...items.filter((i) => i.frameSrc).map((i) => i.frames || 1));
    const files = [];
    for (let f = 0; f < frames; f++) {
      files.push(
        resolve(DATA_DIR, "thumbs", `batch_${String(sheetIndex).padStart(3, "0")}_${String(f).padStart(4, "0")}.png`),
      );
    }
    for (const f of files) if (existsSync(f)) bytesBefore += statSync(f).size;
    decoded = files.map((f) => (existsSync(f) ? loadRgb(f) : null));
  }

  const cellIndexes = [...itemByCell.keys()].sort((a, b) => a - b);

  for (const cell of cellIndexes) {
    const item = itemByCell.get(cell);

    /* --- 单文件条目：静态，直接取区域 --- */
    if (!item.frameSrc) {
      if (!singleImage) continue;
      if (!staticStream.buffer) staticStream.open();
      const slot = staticStream.cursor++;
      staticStream.place(cellRegion(singleImage, cell), slot);
      const to = cellBox(slot);
      outItems.push({
        matchName: item.matchName,
        sheet: staticStream.sheetIndex,
        x: to.x,
        y: to.y,
        width: CELL,
        height: CELL,
        frames: 1,
        src: `thumbs/batch_${String(staticStream.sheetIndex).padStart(3, "0")}.png`,
        key: item.key || "",
      });
      if (staticStream.cursor >= PER_SHEET) staticStream.flush();
      continue;
    }

    /* --- 帧序列条目：逐格判断静态还是动态 --- */
    if (!decoded || !decoded[0]) continue;
    const first = sha(cellRegion(decoded[0], cell));
    let same = true;
    for (let f = 1; f < decoded.length; f++) {
      if (!decoded[f]) continue;
      if (sha(cellRegion(decoded[f], cell)) !== first) {
        same = false;
        break;
      }
    }

    if (same) {
      /* 静态：只取第 1 帧 */
      if (!staticStream.buffer) staticStream.open();
      const slot = staticStream.cursor++;
      staticStream.place(cellRegion(decoded[0], cell), slot);
      const to = cellBox(slot);
      outItems.push({
        matchName: item.matchName,
        sheet: staticStream.sheetIndex,
        x: to.x,
        y: to.y,
        width: CELL,
        height: CELL,
        frames: 1,
        src: `thumbs/batch_${String(staticStream.sheetIndex).padStart(3, "0")}.png`,
        key: item.key || "",
      });
      if (staticStream.cursor >= PER_SHEET) staticStream.flush();
    } else {
      /* 动态：全部帧都留 */
      if (!animStream.buffers.length || animStream.frames !== decoded.length) {
        animStream.flush();
        animStream.open(decoded.length);
      }
      const slot = animStream.cursor++;
      for (let f = 0; f < decoded.length; f++) {
        if (!decoded[f]) continue;
        animStream.place(cellRegion(decoded[f], cell), f, slot);
      }
      const to = cellBox(slot);
      outItems.push({
        matchName: item.matchName,
        sheet: animStream.sheetIndex,
        x: to.x,
        y: to.y,
        width: CELL,
        height: CELL,
        frames: decoded.length,
        frameSrc: `thumbs/batch_${String(animStream.sheetIndex).padStart(3, "0")}_%04d.png`,
        key: item.key || "",
      });
      if (animStream.cursor >= PER_SHEET) animStream.flush();
    }
  }
}

/* 收尾：把没满的网也落盘 */
staticStream.flush();
animStream.flush();

/* ---------- 索引 ---------- */

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

/* previews.tsv：缓存索引，frames 列记的是**渲染帧数**，
   与打包后的存储帧数不同——指纹按渲染帧数算，这里必须保持渲染帧数。 */
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

/* 名字表取仓库里的版本（它是源数据），避免拿上一轮安装的旧包形成循环依赖 */
const namesSource = resolve(arg("--names", resolve(ROOT, "cep/com.dreamengine.panel/data/names.json")));
if (existsSync(namesSource)) {
  copyFileSync(namesSource, resolve(OUT_DIR, "names.json"));
}

/* 清理本次没产出的旧文件（先写后清，失败时旧包仍完整） */
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
  items: outItems.length,
  staticItems: outItems.length - animatedCount,
  animatedItems: animatedCount,
  sheetsBefore: manifest.sheets.length,
  sheetsAfter: outSheets.length,
  bytesBefore,
  bytesAfter,
  ratio: bytesBefore > 0 ? Math.round((bytesAfter / bytesBefore) * 1000) / 10 : 0,
  pruned,
};
writeFileSync(resolve(OUT_DIR, "build-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

console.log("L1 打包完成");
console.log(`  条目 ${report.items}（静态 ${report.staticItems} / 动态 ${report.animatedItems}）`);
console.log(`  网 ${report.sheetsBefore} -> ${report.sheetsAfter}`);
console.log(
  `  体积 ${(bytesBefore / 1024 / 1024).toFixed(2)} MB -> ${(bytesAfter / 1024 / 1024).toFixed(2)} MB（${report.ratio}%）`,
);
console.log(`  输出 ${OUT_DIR}`);
