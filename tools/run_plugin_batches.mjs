#!/usr/bin/env node
/* ============================================================
 * run_plugin_batches.mjs —— 插件预览的批量驱动（自动多轮）
 *
 * 一轮 = 挑名单 → 复制到用户文档目录 → 启动 AE 跑离线脚本 → 等结果。
 * 每轮都是一次独立的 AE 进程：插件把 AE 搞崩也只影响这一轮，
 * 崩溃条目会在下一轮启动时自动拉黑并跳过（见 engine/plugin_state.jsx）。
 *
 * 用法：
 *   node tools/run_plugin_batches.mjs [--limit 24] [--rounds 40]
 *   [--ae "路径/AfterFX.exe"] [--timeout 900]
 *
 * 会一直跑到「没有候选」或「达到轮数上限」为止；随时 Ctrl+C 可停，
 * 下次再跑会从断点继续（已渲染的条目在索引里，黑名单里的自动跳过）。
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawn } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const PROBE_DIR = resolve(homedir(), "Documents/DreamEngineProbe");
const TMP_LIST = resolve(ROOT, ".workbuddy/tmp/next_plugin_batch.tsv");
const RUNTIME_LIST = resolve(PROBE_DIR, "next_plugin_batch.tsv");
const LOG = resolve(PROBE_DIR, "plugin_run.log");

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}
const limit = Number(arg("--limit", "24")) || 24;
const maxRounds = Number(arg("--rounds", "40")) || 40;
const timeoutSec = Number(arg("--timeout", "240")) || 240;
const AE = arg("--ae", "C:/Program Files/Adobe/Adobe After Effects 2021/Support Files/AfterFX.exe");
const SCRIPT = resolve(ROOT, "tools/run_plugin_preview.jsx");

if (!existsSync(AE)) {
  console.error("找不到 AE：" + AE);
  process.exit(1);
}
mkdirSync(resolve(ROOT, ".workbuddy/tmp"), { recursive: true });

function logLines() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").split(/\r?\n/).filter((l) => l.trim());
}

function aeRunning() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq AfterFX.exe", "/NH"], {
      encoding: "utf8",
    });
    return out.indexOf("AfterFX.exe") >= 0;
  } catch (e) {
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let totalOk = 0;
let totalFail = 0;

for (let round = 1; round <= maxRounds; round++) {
  // AE 已在运行的话，新实例会被转发过去，脚本根本不会执行（表现为日志不动）
  if (aeRunning()) {
    console.log("AE 正在运行，请先关闭 AE 再跑批量（否则脚本会被转发到现有实例）。");
    process.exit(1);
  }

  // 1) 挑名单（复用 pick_plugin_candidates 的规则）
  let picked = [];
  try {
    execFileSync(
      process.execPath,
      [resolve(ROOT, "tools/pick_plugin_candidates.mjs"), "--limit", String(limit)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (existsSync(TMP_LIST)) {
      picked = readFileSync(TMP_LIST, "utf8")
        .split(/\r?\n/)
        .filter((l) => l && l.charAt(0) !== "#")
        .map((l) => l.split("\t")[0]);
    }
  } catch (e) {
    console.error("挑名单失败：" + String(e.message || e).split("\n")[0]);
  }

  if (!picked.length) {
    console.log(`第 ${round} 轮：没有待渲的插件效果，收工。`);
    break;
  }

  // 2) 名单就位
  copyFileSync(TMP_LIST, RUNTIME_LIST);

  // 3) 启动 AE 跑离线脚本
  const before = logLines().length;
  const child = spawn(AE, ["-r", SCRIPT], { detached: true, stdio: "ignore" });
  child.unref();

  // 4) 等这一轮出结果：日志出现新的 RESULT，或 AE 进程消失（崩溃）
  const startedAt = Date.now();
  let crashed = false;
  while (true) {
    sleep(4000);
    const lines = logLines();
    if (lines.length > before && lines[lines.length - 1].indexOf("RESULT") === 0) break;
    if (!aeRunning()) {
      crashed = true;
      break;
    }
    if (Date.now() - startedAt > timeoutSec * 1000) {
      console.error("第 " + round + " 轮超时，终止 AE 继续。");
      try {
        execFileSync("taskkill", ["/IM", "AfterFX.exe", "/F"], { stdio: "ignore" });
      } catch (e) {}
      break;
    }
  }

  // 5) 统计本轮结果
  const fresh = logLines().slice(before);
  let ok = 0;
  let fail = 0;
  const failed = [];
  for (const line of fresh) {
    if (line.indexOf("OK|") === 0) ok++;
    else if (line.indexOf("FAIL|") === 0) {
      fail++;
      failed.push(line.split("|")[1]);
    }
  }
  totalOk += ok;
  totalFail += fail;
  console.log(
    `第 ${round} 轮：请求 ${picked.length} 条，成功 ${ok}，失败 ${fail}` +
      (crashed ? "（AE 进程消失，下一轮会自动拉黑崩溃条目）" : "") +
      (failed.length ? " 失败：" + failed.slice(0, 3).join("、") : ""),
  );
  if (!ok && !fail) {
    console.log("本轮没有产出（可能 AE 启动失败），停一下再看。");
    break;
  }
}

console.log(`\n累计：成功 ${totalOk}，失败 ${totalFail}`);
console.log("索引：" + resolve(homedir(), "Documents/DreamEngineProbe/plugin_run.log"));
