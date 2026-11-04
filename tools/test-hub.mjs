#!/usr/bin/env node
/* ============================================================
 * test-hub.mjs —— DreamEngine Hub 核心层（不启动 GUI）
 *
 * 测的是三件最容易和别的模块对不上的事：
 *   1. 路径常量必须与 ps1、store.jsx 完全一致
 *      （不一致 = 「Hub 导入了，AE 面板看不见」）
 *   2. 重名规则必须与 presets.jsx 的 importOneJson 一致（base_1.ffx）
 *   3. 状态文件要能容忍「读到半截 JSON」—— ps1 正在写的时候就会这样
 *
 * 用法：node tools/test-hub.mjs
 * ============================================================ */

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, "..");
const HUB = resolve(ROOT, "hub");

const { createPaths } = require(join(HUB, "core/paths.js"));
const presets = require(join(HUB, "core/presets.js"));
const install = require(join(HUB, "core/install.js"));
const { readStateFile } = require(join(HUB, "core/render.js"));

const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log("[PASS] " + name);
  } catch (error) {
    failed++;
    console.log("[FAIL] " + name);
    console.log("       " + String(error.message || error).split("\n").slice(0, 5).join("\n       "));
  }
}

/* ---------- 1. 路径契约 ---------- */

test("路径常量与 ps1 / store.jsx 保持一致", () => {
  const paths = createPaths({ docsDir: "C:/D", appData: "C:/A" });
  const ps1 = read("tools/generate_plugin_presets.ps1");
  const store = read("cep/com.dreamengine.panel/engine/store.jsx");

  // 扩展目录名
  assert.equal(paths.extDir.split(/[\\/]/).pop(), "com.dreamengine.panel");
  assert.match(store, /DreamEngine/);
  assert.ok(ps1.includes("com.dreamengine.panel"), "ps1 里的扩展目录名变了");

  // 用户目录
  assert.match(paths.presets.replace(/\\/g, "/"), /\/DreamEngine\/presets$/);
  assert.ok(store.includes('"DreamEngine"'), "store.jsx 的根目录名变了");

  // 探针目录与状态文件
  assert.match(paths.probe.replace(/\\/g, "/"), /\/DreamEngineProbe$/);
  assert.ok(ps1.includes("DreamEngineProbe"), "ps1 的探针目录变了");
  assert.match(paths.hubState.replace(/\\/g, "/"), /hub_state\.json$/);
  assert.ok(ps1.includes("hub_state.json"), "ps1 没写 hub_state.json，Hub 就读不到进度");

  // 三份索引名
  assert.ok(ps1.includes("preset_plugin_manifest.json"));
  assert.equal(paths.presetPluginManifest.split(/[\\/]/).pop(), "preset_plugin_manifest.json");
});

/* ---------- 2. 重名规则 ---------- */

test("重名规则与 presets.jsx 一致（base_1.ffx，不是 base(1).ffx）", () => {
  const jsx = read("cep/com.dreamengine.panel/engine/presets.jsx");
  // presets.jsx: base + "_" + n + ".ffx"
  assert.match(jsx, /base \+ "_" \+ n \+ "\.ffx"/);

  const dir = mkdtempSync(join(tmpdir(), "de-hub-"));
  try {
    writeFileSync(join(dir, "a.ffx"), "x");
    assert.equal(presets.uniqueTarget(dir, "a.ffx"), join(dir, "a_1.ffx"));
    writeFileSync(join(dir, "a_1.ffx"), "x");
    assert.equal(presets.uniqueTarget(dir, "a.ffx"), join(dir, "a_2.ffx"));
    assert.equal(presets.uniqueTarget(dir, "b.ffx"), join(dir, "b.ffx"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 3. 预设库读写 ---------- */

test("导入只收 .ffx，重复导入自动加序号，非 .ffx 被跳过", () => {
  const docs = mkdtempSync(join(tmpdir(), "de-hub-docs-"));
  const src = mkdtempSync(join(tmpdir(), "de-hub-src-"));
  try {
    const paths = createPaths({ docsDir: docs, appData: docs });
    writeFileSync(join(src, "夜视.ffx"), "preset");
    writeFileSync(join(src, "notes.txt"), "not a preset");

    const first = presets.importFiles([join(src, "夜视.ffx"), join(src, "notes.txt")], paths);
    assert.equal(first.imported.length, 1, "应该只导入 1 个");
    assert.equal(first.skipped.length, 1);
    assert.equal(first.skipped[0].reason, "not_ffx");

    const second = presets.importFiles([join(src, "夜视.ffx")], paths);
    assert.ok(second.imported[0].endsWith("夜视_1.ffx"), "重名没有加序号：" + second.imported[0]);

    const listed = presets.list(paths);
    assert.equal(listed.items.length, 2, "库内应有 2 个预设");
    assert.equal(listed.items[0].rendered, false, "没有索引时不该标成已渲染");
  } finally {
    rmSync(docs, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("列表能正确关联两份索引（面板内置 + 离线插件）", () => {
  const docs = mkdtempSync(join(tmpdir(), "de-hub-idx-"));
  try {
    const paths = createPaths({ docsDir: docs, appData: docs });
    mkdirSync(paths.presets, { recursive: true });
    mkdirSync(paths.dataDir, { recursive: true });

    const a = join(paths.presets, "a.ffx");
    const b = join(paths.presets, "b.ffx");
    writeFileSync(a, "1");
    writeFileSync(b, "2");

    writeFileSync(
      paths.presetManifest,
      JSON.stringify({
        version: 1,
        items: [{ path: a.replace(/\\/g, "/"), src: "thumbs/preset_000_0000.png", frames: 1 }],
      }),
    );
    writeFileSync(
      paths.presetPluginManifest,
      JSON.stringify({
        version: 1,
        items: [
          {
            path: b.replace(/\\/g, "/"),
            src: "thumbs/preset_1000_0000.png",
            frames: 6,
            animated: true,
            plugin: true,
          },
        ],
      }),
    );

    const listed = presets.list(paths);
    const byName = Object.fromEntries(listed.items.map((i) => [i.name, i]));
    assert.equal(byName.a.rendered, true);
    assert.equal(byName.a.frames, 1);
    assert.equal(byName.b.rendered, true);
    assert.equal(byName.b.animated, true);
    assert.equal(byName.b.offline, true, "离线索引里的条目应标 offline");
    assert.ok(byName.b.thumb.endsWith("preset_1000_0000.png"));
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
});

/* ---------- 4. 状态文件容错 ---------- */

test("状态文件：缺失或半截 JSON 都返回 null，不抛异常", () => {
  const dir = mkdtempSync(join(tmpdir(), "de-hub-state-"));
  try {
    assert.equal(readStateFile(join(dir, "nope.json")), null);

    const half = join(dir, "half.json");
    writeFileSync(half, '{"phase":"rendering","current":3');
    assert.equal(readStateFile(half), null, "半截 JSON 应该被当成「还没写好」");

    const good = join(dir, "ok.json");
    writeFileSync(good, JSON.stringify({ phase: "done", ok: 5 }));
    assert.equal(readStateFile(good).ok, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 5. 安装状态 ---------- */

test("安装状态：没装时不谎报，装了能读出版本号", () => {
  const docs = mkdtempSync(join(tmpdir(), "de-hub-inst-"));
  try {
    const paths = createPaths({ docsDir: docs, appData: docs });

    const before = install.status(paths);
    assert.equal(before.installed, false);
    assert.equal(before.version, "");

    mkdirSync(join(paths.extDir, "CSXS"), { recursive: true });
    mkdirSync(join(paths.dataDir, "thumbs"), { recursive: true });
    writeFileSync(join(paths.extDir, "index.html"), "<html></html>");
    writeFileSync(
      paths.manifestXml,
      '<ExtensionManifest ExtensionBundleVersion="0.2.0"></ExtensionManifest>',
    );
    writeFileSync(join(paths.dataDir, "thumbs", "x.png"), "png");

    const after = install.status(paths);
    assert.equal(after.installed, true);
    assert.equal(after.version, "0.2.0");
    assert.equal(after.thumbCount, 1);
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
});

/* ---------- 6. 不重写渲染逻辑 ---------- */

test("Hub 不自己实现渲染：必须 spawn 那个 ps1", () => {
  const main = read("hub/main.js");
  assert.match(main, /generate_plugin_presets\.ps1/, "main.js 没引用已验证的渲染脚本");
  assert.doesNotMatch(main, /aerender/, "Hub 不该直接调 aerender");

  const render = read("hub/core/render.js");
  assert.match(render, /spawn\(/, "render.js 应该 spawn 子进程");
  assert.match(render, /taskkill/, "停止时必须连子进程一起收掉（专用 AE 实例）");
  assert.match(render, /hub_state\.json/, "进度应读状态文件，而不是解析控制台输出");
});

console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}`);
if (failed > 0) process.exitCode = 1;
