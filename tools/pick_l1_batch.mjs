#!/usr/bin/env node
/* ============================================================
 * pick_l1_batch.mjs —— 从 L1 目标清单生成批量渲染名单
 *
 * 为什么要有这一步：L1 由哪些效果组成必须住在仓库里
 * （cep/com.dreamengine.panel/data/l1-targets.tsv），
 * 而不是只活在运行时的索引中——运行时索引会被安装、覆盖、重建，
 * 清单丢了就再也拼不回来。
 *
 * 输出：<我的文档>/DreamEngineProbe/next_batch.tsv
 *   首行 #replace 表示整批重渲（不留旧条目，避免重名）
 *   其后每行 "matchName \t 帧数"
 *
 * 用法：node tools/pick_l1_batch.mjs [帧数]
 * ============================================================ */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TARGETS = resolve(ROOT, "cep/com.dreamengine.panel/data/l1-targets.tsv");
const OUT_DIR = resolve(
  process.env.USERPROFILE || process.env.HOME || "",
  "Documents/DreamEngineProbe",
);
const OUT = resolve(OUT_DIR, "next_batch.tsv");
const FRAMES = Number(process.argv[2]) || 6;

const lines = readFileSync(TARGETS, "utf8")
  .replace(/\r/g, "")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, ["#replace", ...lines.map((n) => `${n}\t${FRAMES}`)].join("\n") + "\n", "utf8");

console.log(`L1 目标 ${lines.length} 条 -> ${OUT}（${FRAMES} 帧，整批重渲）`);
