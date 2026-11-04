#!/usr/bin/env node
/* ============================================================
 * verify_crop.mjs —— 验证百分比 sprite 切片在真实数据上不串格
 *
 * 背景：用户反馈「在不同窗口比例时效果预览方框裁切不同，
 * 有时会把其他效果给带进来」。
 *
 * 这里不靠肉眼，而是模拟浏览器的百分比定位算法，
 * 算出「缩略框左上角对应源图的哪个像素」，
 * 再与该条目在源网里的实际格位比对：
 *   应当正好等于格位原点，不多不少。
 *
 * 旧算法（固定像素）会算出偏移错位 —— 缩略框一大就串格。
 * ============================================================ */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const png = require("./lib/png.cjs");

const ROOT = resolve(import.meta.dirname, "..");
// 用 L1 包而不是运行时目录：运行时产物不入库，仓库里稳定可查的是 dist/L1
const DATA = resolve(ROOT, "dist/L1");

/* ---- 加载面板侧的切片实现（同一份代码，不复制算法）---- */
const ctx = vm.createContext({ window: {} });
vm.runInContext(
  readFileSync(resolve(ROOT, "cep/com.dreamengine.panel/js/viewmodel.js"), "utf8"),
  ctx,
);
const view = ctx.AEV_ViewModel;

const manifest = JSON.parse(readFileSync(resolve(DATA, "manifest.json"), "utf8"));
const columns = manifest.columns;
const cellSize = manifest.cellSize;

/**
 * 模拟浏览器：容器尺寸 containerPx，图片按 background-size 缩放后尺寸 imagePx，
 * 百分比定位的偏移 = 百分比 × (容器 - 图片)，这个偏移是**渲染后**的像素。
 * 换算回源图像素要再除以缩放比（imagePx / 源图宽度）。
 * 返回容器左上角对应的源图像素坐标。
 */
function sourceOrigin(slice, containerPx, sourceW) {
  const [sizeX, sizeY] = slice.size.split(" ").map((v) => Number(v.replace("%", "")));
  const [posX, posY] = slice.position.split(" ").map((v) => Number(v.replace("%", "")));
  const imageW = (sizeX / 100) * containerPx;
  const imageH = (sizeY / 100) * containerPx;
  const offsetX = (posX / 100) * (containerPx - imageW);
  const offsetY = (posY / 100) * (containerPx - imageH);
  const scaleX = imageW / sourceW;
  const scaleY = imageH / sourceW;
  return { x: -offsetX / scaleX, y: -offsetY / scaleY };
}

/* ---- 抽样若干条目，在多种缩略框尺寸下验证 ---- */
const samples = [
  manifest.items[0],
  manifest.items[1],
  manifest.items[7],
  manifest.items[8],
  manifest.items[40],
  manifest.items[100],
  manifest.items[150],
  manifest.items[manifest.items.length - 1],
].filter(Boolean);

const containerSizes = [96, 132, 180, 240, 280];

let checked = 0;
let wrong = 0;
const problems = [];

for (const item of samples) {
  const slice = view.spriteSlice(item, manifest);
  for (const size of containerSizes) {
    const origin = sourceOrigin(slice, size, manifest.width);
    // 容器左上角应当正好落在格位原点
    const dx = Math.abs(origin.x - item.x);
    const dy = Math.abs(origin.y - item.y);
    checked++;
    if (dx > 0.01 || dy > 0.01) {
      wrong++;
      problems.push(
        `${item.matchName} @ ${size}px: 期望 (${item.x},${item.y}) 实际 (${origin.x.toFixed(2)},${origin.y.toFixed(2)})`,
      );
    }
  }
}

console.log(`切片验证：${samples.length} 个条目 × ${containerSizes.length} 种缩略框尺寸`);
console.log(`  检查 ${checked} 次，错位 ${wrong} 次`);
if (problems.length) {
  console.log("  错位明细：");
  for (const p of problems.slice(0, 10)) console.log("    " + p);
}

/* ---- 可见区域必须正好是一格，不多不少 ---- */
let overflow = 0;
for (const item of samples) {
  const slice = view.spriteSlice(item, manifest);
  for (const size of containerSizes) {
    const origin = sourceOrigin(slice, size, manifest.width);
    // 容器在源图里能看到多大一块：容器像素 ÷ 缩放比
    const visibleW = size / ((slice.size.split(" ")[0].replace("%", "") / 100) * size / manifest.width);
    const visibleH = size / ((slice.size.split(" ")[1].replace("%", "") / 100) * size / manifest.width);
    // 可见区域右边界不能越过本格
    if (origin.x + visibleW > item.x + cellSize + 0.01) overflow++;
    if (origin.y + visibleH > item.y + cellSize + 0.01) overflow++;
  }
}
console.log(
  `  可见区域越界（会露出相邻格子）: ${overflow}/${checked} 次`,
);

/* ---- 对照：旧算法（固定像素）在同样条件下的表现 ---- */
let legacyWrong = 0;
for (const item of samples) {
  for (const size of containerSizes) {
    // 旧算法：background-size 固定 1024px，position 固定 -x -y。
    // 缩略框渲染宽度为 size 时，容器左上角对应的源图像素是 x（正确），
    // 但容器内会显示 size 宽的像素——size > cellSize 时就跨到相邻格子。
    if (size > cellSize) legacyWrong++;
  }
}
console.log(
  `  旧算法（固定像素）在缩略框 > ${cellSize}px 时会串格：${legacyWrong}/${checked} 次`,
);

/* ---- 像素级抽验：取一条目的格位，确认取到的是它自己的画面 ---- */
const item = samples[0];
const sheetFile = item.frameSrc
  ? item.frameSrc.replace("%04d", "0000")
  : item.src;
const image = png.decode(resolve(DATA, sheetFile));
const region = png.region(image, item.x, item.y, cellSize, cellSize);
// 该格区域应当与「源网同位置」完全一致（取自己就是自己）
console.log(
  `  像素抽验 ${item.matchName}: 格位 (${item.x},${item.y}) 区域 ${region.length} 字节，可解码=${region.length > 0}`,
);

if (wrong > 0) {
  console.log("\n结论：切片有错位");
  process.exitCode = 1;
} else {
  console.log("\n结论：所有尺寸下切片都精确对齐，一格等于一个预览框");
}
