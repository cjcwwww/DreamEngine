#!/usr/bin/env node
/* ============================================================
 * mark_animated.mjs —— 标出哪些预览真的有动态
 *
 * 背景：预览目录里每个条目都存了 6 帧，但**大部分效果本身是静态的**
 * （各帧内容完全相同）。面板若一律当动画播，浏览器就要反复重解码
 * 同一张图 —— 视觉上是「闪几下」，而且没有任何信息量。
 *
 * 判定：把同一条目的各帧 PNG 做字节比对，全部相同 → 静态。
 *   PNG 是确定性编码，同一画面渲染出来字节完全相同（实测 773 条插件
 *   预览里 598 条如此），所以字节比对既能判「完全一样」，也不会把
 *   「有细微差异」误判成一样。
 *
 * 写到**独立索引** data/animated.json，不动 manifest.json：
 *   manifest.json 会被引擎的 writeManifest 整份重写（生成新预览时），
 *   标记写在它里面必然丢失。独立索引则只由本工具写。
 *
 * 用法：node tools/mark_animated.mjs [--data 目录]
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { homedir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const runtimePanel = resolve(
  process.env.APPDATA || "",
  "Adobe/CEP/extensions/com.dreamengine.panel",
);
const dataDir = resolve(arg("--data", resolve(runtimePanel, "data")));

if (!existsSync(dataDir)) {
  console.error("索引目录不存在：" + dataDir);
  process.exit(1);
}

function hashFile(path) {
  if (!existsSync(path)) return null;
  return createHash("md5").update(readFileSync(path)).digest("hex");
}

/**
 * 判定一个条目的各帧是否完全相同。
 * 缺帧时返回 true（保守：宁可当成有动态，也不要把动画吞掉）。
 */
function isAnimated(item) {
  const frames = item.frames || 1;
  if (!item.frameSrc) return false;
  if (frames <= 1) return false;
  const hashes = new Set();
  for (let f = 0; f < frames; f++) {
    const rel = String(item.frameSrc).replace("%04d", String(f).padStart(4, "0"));
    const h = hashFile(resolve(dataDir, rel));
    if (h === null) return true; // 缺帧 → 当成有动态
    hashes.add(h);
  }
  return hashes.size > 1;
}

/* ---- L1 内置整网 ---- */
const l1Path = resolve(dataDir, "manifest.json");
const l1 = existsSync(l1Path) ? JSON.parse(readFileSync(l1Path, "utf8")) : null;

/* ---- L2 插件单格 ---- */
const l2Path = resolve(dataDir, "plugin_manifest.json");
const l2 = existsSync(l2Path) ? JSON.parse(readFileSync(l2Path, "utf8")) : null;

const animated = {};
let total = 0;
let still = 0;

for (const manifest of [l1, l2]) {
  if (!manifest) continue;
  for (const item of manifest.items || []) {
    total++;
    if (!isAnimated(item)) {
      animated[item.matchName] = false;
      still++;
    }
  }
}

const out = {
  version: 1,
  // 只有「静态」的条目才需要记下来：面板默认当有动态处理，
  // 看到显式的 false 就不播。
  items: Object.keys(animated).map((matchName) => ({
    matchName,
    animated: false,
  })),
};

const outPath = resolve(dataDir, "animated.json");
writeFileSync(outPath, JSON.stringify(out, null, 1), "utf8");

console.log("索引目录：" + dataDir);
console.log(`内置 L1：${l1 ? l1.items.length + " 条" : "无"}`);
console.log(`插件 L2：${l2 ? l2.items.length + " 条" : "无"}`);
console.log(`\n合计 ${total} 条 → 静态 ${still} 条（有动态 ${total - still} 条）`);
console.log("已写：" + outPath);
