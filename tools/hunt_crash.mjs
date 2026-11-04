#!/usr/bin/env node
/* ============================================================
 * hunt_crash.mjs —— 从批量渲染日志里取出崩溃批次，生成逐条排查脚本
 *
 * 场景：批量渲染时 AE 进程直接消失，只能定位到「哪一批」。
 * 这个脚本把最后一批的名单抽出来，写进 run_crash_hunt.jsx 的目标列表，
 * 那个脚本会一个一个渲染，元凶就是日志里最后一个 BEGIN 而没有 END 的。
 *
 * 用法：node tools/hunt_crash.mjs [日志路径]
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const LOG = resolve(
  process.argv[2] ||
    `${process.env.USERPROFILE || process.env.HOME}/Documents/DreamEngineProbe/batch_generate.txt`,
);
const HUNT = resolve(ROOT, "tools/run_crash_hunt.jsx");

if (!existsSync(LOG)) {
  console.error("找不到日志：" + LOG);
  process.exit(1);
}

const lines = readFileSync(LOG, "utf8").replace(/\r/g, "").split("\n");

/* 找出最后一个没有对应 END 的批次 —— 那一批就是崩掉的 */
let pending = [];
let lastBegin = null;
for (const line of lines) {
  if (line.startsWith("BEGIN_SHEET|")) {
    const parts = line.split("|");
    lastBegin = { sheet: parts[1], names: parts[2].split(",") };
    pending = lastBegin.names;
  } else if (line.startsWith("SHEET|")) {
    pending = [];
  }
}

if (!pending.length) {
  console.log("日志里没有未完成的批次——上次运行是正常结束的。");
  console.log("如果确实崩了，请确认日志文件是否最新。");
  process.exit(0);
}

console.log(`崩溃批次 #${lastBegin.sheet}，共 ${pending.length} 个：`);
pending.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));

/* 写进排查脚本 */
let hunt = readFileSync(HUNT, "utf8");
const list = pending.map((n) => `        ${JSON.stringify(n)}`).join(",\n");
hunt = hunt.replace(/    var TARGETS = \[[\s\S]*?\n    \];/, `    var TARGETS = [\n${list}\n    ];`);
writeFileSync(HUNT, hunt, "utf8");
console.log(`\n已写入 ${HUNT}`);
console.log(`运行：AfterFX.exe -r tools/run_crash_hunt.jsx`);
