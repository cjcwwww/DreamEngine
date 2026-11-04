#!/usr/bin/env node
/* ============================================================
 * test-release.mjs —— 核验分发包能不能真的装起来用
 *
 * 背景：分发包是给别人用的，最容易出的问题就是
 * 「包里少文件 / 路径不对 / 脚本语法错」，而这些在开发机上看不出来。
 * 这里做四件事：
 *   1. 解压 zip 到临时目录，核对结构与关键文件
 *   2. 校验 l1/manifest.json 里的条目都指向包内真实存在的图
 *   3. 校验两份索引描述同一批条目
 *   4. 静态检查 install.ps1 的关键步骤是否齐全
 * ============================================================ */

import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const ROOT = resolve(import.meta.dirname, "..");
const TMP = resolve(ROOT, ".workbuddy/release-test");
const ZIP = resolve(ROOT, "dist/DreamEngine-0.2.0.zip");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("[PASS] " + name);
  } catch (e) {
    failed++;
    console.log("[FAIL] " + name);
    const detail = String(e.message || e)
      .split("\n")
      .slice(0, 6)
      .join("\n       ");
    console.log("       " + detail);
  }
}

/* ---- 解压 ---- */
mkdirSync(TMP, { recursive: true });
execFileSync("unzip", ["-o", "-q", ZIP, "-d", TMP], { stdio: "pipe" });
const PKG = resolve(TMP, "DreamEngine");

test("包里有扩展本体、L1、安装脚本、说明", () => {
  const required = [
    "install.ps1",
    "README.md",
    "extension/index.html",
    "extension/js/library.js",
    "extension/js/viewmodel.js",
    "extension/js/bridge.js",
    "extension/engine/previewgen.jsx",
    "extension/engine/recipe.jsx",
    "extension/engine/catalog.jsx",
    "extension/engine/store.jsx",
    "extension/engine/queue.jsx",
    "extension/engine/assets.jsx",
    "extension/engine/names.jsx",
    "extension/engine/render_config.jsx",
    "extension/data/names.json",
    "extension/CSXS/manifest.xml",
    "l1/manifest.json",
    "l1/names.json",
  ];
  for (const rel of required) {
    assert.ok(existsSync(resolve(PKG, rel)), "缺少 " + rel);
  }
});

test("扩展本体里没有残留预览图（预览应由 l1/ 提供）", () => {
  const thumbs = resolve(PKG, "extension/data/thumbs");
  if (existsSync(thumbs)) {
    assert.equal(readdirSync(thumbs).length, 0, "extension/data/thumbs 应为空");
  }
});

test("L1 的每一条预览都指向包内真实存在的图", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(PKG, "l1/manifest.json"), "utf8"),
  );
  assert.ok(manifest.items.length > 0, "L1 不应为空");
  let missing = 0;
  for (const item of manifest.items) {
    const files = item.frameSrc
      ? Array.from({ length: item.frames || 1 }, (_, f) =>
          item.frameSrc.replace("%04d", String(f).padStart(4, "0")),
        )
      : [item.src];
    for (const rel of files) {
      if (!existsSync(resolve(PKG, "l1", rel))) missing++;
    }
  }
  assert.equal(missing, 0, "有 " + missing + " 张图缺失");
});

test("L1 的 manifest 与 previews.tsv 描述同一批条目", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(PKG, "l1/manifest.json"), "utf8"),
  );
  const tsv = resolve(PKG, "l1/previews.tsv");
  assert.ok(existsSync(tsv), "缺 previews.tsv");
  const rows = readFileSync(tsv, "utf8")
    .replace(/\r/g, "")
    .trim()
    .split("\n")
    .slice(1);
  assert.equal(rows.length, manifest.items.length, "两份索引条目数不一致");
  const names = new Set(manifest.items.map((i) => i.matchName));
  for (const row of rows) {
    const cells = row.split("\t");
    assert.ok(names.has(cells[0]), cells[0] + " 不在 manifest 中");
  }
});

test("安装脚本覆盖了三个必要动作：装扩展、放 CEP 调试、部署 L1", () => {
  const ps = readFileSync(resolve(PKG, "install.ps1"), "utf8");
  assert.match(ps, /extensions/i, "没有指向 CEP 扩展目录");
  assert.match(ps, /PlayerDebugMode/i, "没有放开 CEP 调试模式");
  assert.match(ps, /l1/i, "没有部署 L1 预览");
  assert.match(ps, /thumbs/i, "没有复制预览图");
});

test("安装脚本写出的目标路径是扩展数据目录", () => {
  const ps = readFileSync(resolve(PKG, "install.ps1"), "utf8");
  assert.match(ps, /data/i, "没有提到 data 目录");
  assert.match(ps, /manifest\.json/i);
});

test("README 说明了安装方式、面板入口与已知限制", () => {
  const readme = readFileSync(resolve(PKG, "README.md"), "utf8");
  assert.match(readme, /install\.ps1/);
  assert.match(readme, /窗口/);
  assert.match(readme, /已知限制/);
});

console.log("\n" + passed + "/" + (passed + failed) + " passed");
if (failed > 0) process.exitCode = 1;
