#!/usr/bin/env node
/* ============================================================
 * test-package.mjs —— L1 打包器测试
 *
 * 用合成图构造三种情况，不依赖真实缩略图：
 *   1. 单文件网        → 原样保留
 *   2. 全静态的帧序列网 → 只留第 1 帧
 *   3. 混合的帧序列网   → 拆成静态网 + 动态网，并重排格位
 *
 * 断言重点是「打包前后每个格子的像素必须完全一致」——
 * 打包只允许改变存储方式，不允许改变画面。
 * ============================================================ */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const png = require("./lib/png.cjs");

const ROOT = resolve(import.meta.dirname, "..");
const TMP = resolve(ROOT, ".workbuddy/tmp/package-test");

const CELL = 256;
const COLUMNS = 2;
const SHEET = CELL * COLUMNS;

/* ---------- 造测试用的数据目录 ---------- */

function solid(width, height, rgb) {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = rgb[0];
    buf[i * 3 + 1] = rgb[1];
    buf[i * 3 + 2] = rgb[2];
  }
  return { width, height, channels: 3, data: buf };
}

function fillCell(image, cellIndex, rgb) {
  const x = (cellIndex % COLUMNS) * CELL;
  const y = Math.floor(cellIndex / COLUMNS) * CELL;
  for (let row = 0; row < CELL; row++) {
    for (let col = 0; col < CELL; col++) {
      const at = ((y + row) * image.width + x + col) * 3;
      image.data[at] = rgb[0];
      image.data[at + 1] = rgb[1];
      image.data[at + 2] = rgb[2];
    }
  }
}

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  const data = resolve(TMP, "data");
  mkdirSync(resolve(data, "thumbs"), { recursive: true });

  // 网 0：单文件，两个格子
  const single = solid(SHEET, SHEET, [0, 0, 0]);
  fillCell(single, 0, [10, 120, 200]);
  fillCell(single, 1, [200, 90, 40]);
  writeFileSync(resolve(data, "thumbs/batch_000.png"), png.encode(SHEET, SHEET, single.data));

  // 网 1：6 帧，两格都静态 —— 整张应该被压成 1 帧
  for (let f = 0; f < 6; f++) {
    const frame = solid(SHEET, SHEET, [0, 0, 0]);
    fillCell(frame, 0, [10, 120, 200]);
    fillCell(frame, 1, [200, 90, 40]);
    writeFileSync(
      resolve(data, `thumbs/batch_001_${String(f).padStart(4, "0")}.png`),
      png.encode(SHEET, SHEET, frame.data),
    );
  }

  // 网 2：6 帧，格 0 静态、格 1 逐帧变化 —— 混合，应该被拆成两网
  for (let f = 0; f < 6; f++) {
    const frame = solid(SHEET, SHEET, [0, 0, 0]);
    fillCell(frame, 0, [30, 30, 30]);
    fillCell(frame, 1, [f * 40, 90, 40]);
    writeFileSync(
      resolve(data, `thumbs/batch_002_${String(f).padStart(4, "0")}.png`),
      png.encode(SHEET, SHEET, frame.data),
    );
  }

  const manifest = {
    version: 2,
    cellSize: CELL,
    columns: COLUMNS,
    width: SHEET,
    height: SHEET,
    sheets: [
      { index: 0, src: "thumbs/batch_000.png", width: SHEET, height: SHEET },
      { index: 1, src: "thumbs/batch_001_0000.png", width: SHEET, height: SHEET },
      { index: 2, src: "thumbs/batch_002_0000.png", width: SHEET, height: SHEET },
    ],
    items: [
      { matchName: "Static Single", sheet: 0, x: 0, y: 0, width: CELL, height: CELL, frames: 1, src: "thumbs/batch_000.png", key: "k1" },
      { matchName: "Static A", sheet: 1, x: 0, y: 0, width: CELL, height: CELL, frames: 6, frameSrc: "thumbs/batch_001_%04d.png", key: "k2" },
      { matchName: "Static B", sheet: 1, x: CELL, y: 0, width: CELL, height: CELL, frames: 6, frameSrc: "thumbs/batch_001_%04d.png", key: "k3" },
      { matchName: "Mixed Static", sheet: 2, x: 0, y: 0, width: CELL, height: CELL, frames: 6, frameSrc: "thumbs/batch_002_%04d.png", key: "k4" },
      { matchName: "Mixed Animated", sheet: 2, x: CELL, y: 0, width: CELL, height: CELL, frames: 6, frameSrc: "thumbs/batch_002_%04d.png", key: "k5" },
    ],
  };
  writeFileSync(resolve(data, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  writeFileSync(resolve(data, "names.json"), JSON.stringify({ items: [] }), "utf8");
}

/* ---------- 跑打包器 ---------- */

setup();
const out = resolve(TMP, "out");
execFileSync(
  process.execPath,
  [resolve(ROOT, "tools/package_l1.mjs"), "--data", resolve(TMP, "data"), "--out", out],
  { stdio: "pipe" },
);

const packed = JSON.parse(readFileSync(resolve(out, "manifest.json"), "utf8"));
const source = JSON.parse(readFileSync(resolve(TMP, "data/manifest.json"), "utf8"));

/* ---------- 断言 ---------- */

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("条目数不变", () => {
  assert.equal(packed.items.length, source.items.length);
});

test("单文件网原样保留为单帧", () => {
  const item = packed.items.find((i) => i.matchName === "Static Single");
  assert.ok(item);
  assert.equal(item.frames, 1);
  assert.ok(item.src);
  assert.equal(item.frameSrc, undefined);
});

test("整张静态的网被压成 1 帧", () => {
  for (const name of ["Static A", "Static B"]) {
    const item = packed.items.find((i) => i.matchName === name);
    assert.ok(item, `${name} 不见了`);
    assert.equal(item.frames, 1, `${name} 应只留 1 帧`);
    assert.ok(item.src, `${name} 应改用单文件引用`);
    assert.equal(item.frameSrc, undefined);
  }
});

test("静态格子从 6 帧压成 1 帧", () => {
  const item = packed.items.find((i) => i.matchName === "Mixed Static");
  assert.ok(item);
  assert.equal(item.frames, 1, "静态格子应只留 1 帧");
  assert.ok(item.src, "静态格子应改用单文件引用");
  assert.equal(item.frameSrc, undefined);
});

test("动态格子保留全部帧", () => {
  const item = packed.items.find((i) => i.matchName === "Mixed Animated");
  assert.ok(item);
  assert.equal(item.frames, 6);
  assert.ok(item.frameSrc);
});

test("混合网被拆成静态网与动态网", () => {
  const staticItem = packed.items.find((i) => i.matchName === "Mixed Static");
  const animatedItem = packed.items.find((i) => i.matchName === "Mixed Animated");
  assert.notEqual(staticItem.sheet, animatedItem.sheet, "两者必须落在不同的网");
});

test("打包前后每个格子的像素完全一致", () => {
  const sourceByName = new Map(source.items.map((i) => [i.matchName, i]));
  for (const item of packed.items) {
    const before = sourceByName.get(item.matchName);
    const beforeFile = before.frameSrc
      ? resolve(TMP, "data", before.frameSrc.replace("%04d", "0000"))
      : resolve(TMP, "data", before.src);
    const afterFile = item.frameSrc
      ? resolve(out, item.frameSrc.replace("%04d", "0000"))
      : resolve(out, item.src);
    const a = png.decode(beforeFile);
    const b = png.decode(afterFile);
    const ra = png.region(a, before.x, before.y, CELL, CELL);
    const rb = png.region(b, item.x, item.y, CELL, CELL);
    assert.ok(ra.equals(rb), `${item.matchName} 的像素在打包后发生了变化`);
  }
});

test("动态格子的每一帧都对得上", () => {
  const sourceByName = new Map(source.items.map((i) => [i.matchName, i]));
  const item = packed.items.find((i) => i.matchName === "Mixed Animated");
  const before = sourceByName.get("Mixed Animated");
  for (let f = 0; f < item.frames; f++) {
    const a = png.decode(resolve(TMP, "data", before.frameSrc.replace("%04d", String(f).padStart(4, "0"))));
    const b = png.decode(resolve(out, item.frameSrc.replace("%04d", String(f).padStart(4, "0"))));
    const ra = png.region(a, before.x, before.y, CELL, CELL);
    const rb = png.region(b, item.x, item.y, CELL, CELL);
    assert.ok(ra.equals(rb), `第 ${f} 帧对不上`);
  }
});

test("每个条目的引用的文件都存在", () => {
  for (const item of packed.items) {
    const file = item.frameSrc ? item.frameSrc.replace("%04d", "0000") : item.src;
    assert.ok(existsSync(resolve(out, file)), `${item.matchName} 引用的 ${file} 不存在`);
  }
});

test("打包报告记录了体积变化", () => {
  const report = JSON.parse(readFileSync(resolve(out, "build-report.json"), "utf8"));
  assert.equal(report.items, source.items.length);
  assert.equal(report.staticItems, 4);
  assert.equal(report.animatedItems, 1);
  assert.ok(report.bytesAfter < report.bytesBefore, "去重后体积应当变小");
});

/* ---------- 运行 ---------- */

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed++;
    console.error(`[FAIL] ${name}`);
    console.error(String((error && error.stack) || error));
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
rmSync(TMP, { recursive: true, force: true });
process.exitCode = failed === 0 ? 0 : 1;
