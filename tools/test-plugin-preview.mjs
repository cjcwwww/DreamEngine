#!/usr/bin/env node
/* ============================================================
 * test-plugin-preview.mjs —— 插件 L2 预览管线的静态回归
 *
 * 为什么不点 AE：插件混渲会直接杀掉 AE 进程，静态测试先把「安全边界、
 * 崩溃恢复、独立索引、面板合入」这四件事验死，实机逐条验证留到关闭 AE 后跑
 * tools/run_plugin_preview.jsx。
 *
 * 用法：node tools/test-plugin-preview.mjs
 * ============================================================ */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

function loadScript(rel, globalName) {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(read(rel), ctx);
  return ctx[globalName];
}
const view = loadScript("cep/com.dreamengine.panel/js/viewmodel.js", "AEV_ViewModel");
const ps = loadScript("cep/com.dreamengine.panel/engine/plugin_state.jsx", "AEV_PluginState");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------- 1. 内置 / 插件分界 ---------- */

test("内置效果按 matchName 前缀判定，插件不会被误认成内置", () => {
  for (const mn of ["ADBE Glo2", "APC Foo", "CC Blur", "CS CrossBlur"]) {
    assert.equal(view.isBuiltinEffect({ matchName: mn }), true, mn);
  }
  for (const mn of ["BCC Glow", "S_Glow", "RG Universe Foo", "RE:Vision Bar", "VIDEOCOPILOT Saber", "Pseudo/Duik"]) {
    assert.equal(view.isBuiltinEffect({ matchName: mn }), false, mn);
  }
  assert.equal(view.isBuiltinEffect({}), false);
});

test("inferPlugin 覆盖已知插件包，散类统一归「其它插件」", () => {
  assert.equal(view.inferPlugin({ matchName: "BCC Glow", category: "BCC Lights" }), "BCC");
  assert.equal(view.inferPlugin({ matchName: "S_Glow", category: "Sapphire Lighting" }), "Sapphire");
  assert.equal(view.inferPlugin({ matchName: "ADBE Glo2", category: "风格化" }), "内置");
  // 厂商把 category 写成中文分类名，不能拿分类名当插件名
  assert.equal(view.inferPlugin({ matchName: "FooBar", category: "杂色和颗粒" }), "其它插件");
  assert.equal(view.inferPlugin({ matchName: "FooBar", category: "" }), "其它插件");
});

/* ---------- 2. 心跳日志与崩溃恢复 ---------- */

test("心跳日志：未配对的 BEGIN = 上次崩掉的元凶", () => {
  const log = [
    "RUN||todo=4 pending=4",
    "BEGIN|BCC Glow|sheet=1000",
    "OK|BCC Glow|sheet=1000",
    "BEGIN|S_Glow|sheet=1001",
    "FAIL|S_Glow|no_png_template",
    "BEGIN|BCC Lens Flare|sheet=1002"
  ].join("\n");
  const parsed = ps.parseLog(log);
  assert.deepEqual(Array.from(parsed.crashed), ["BCC Lens Flare"]);
  assert.equal(parsed.lines.length, 6);
});

test("多次崩溃会全部拉黑，SKIP 后不再重复判定", () => {
  const parsed = ps.parseLog(
    ["BEGIN|A|s=1", "BEGIN|B|s=2", "OK|A|s=1", "BEGIN|C|s=3"].join("\n"),
  );
  assert.deepEqual(Array.from(parsed.crashed), ["B", "C"]);
  const after = ps.parseLog(
    parsed.lines.concat(["SKIP|B|crash", "SKIP|C|crash"]).join("\n"),
  );
  assert.deepEqual(Array.from(after.crashed), []);
});

test("黑名单 TSV 往返 + 面板 JSON 可读", () => {
  const map = ps.mergeBlacklist({}, ["BCC Glow", "S_Glow"], "crash");
  const tsv = ps.blacklistTsv(map);
  const back = ps.readBlacklist(tsv);
  assert.equal(back["BCC Glow"], "crash");
  assert.equal(back["S_Glow"], "crash");
  const json = JSON.parse(ps.blacklistJson(back));
  assert.equal(json.version, ps.VERSION);
  assert.equal(json.items.length, 2);
  assert.equal(json.items[0].reason, "crash");
  assert.equal(ps.mergeBlacklist(back, ["X"], "render_error")["X"], "render_error");
});

/* ---------- 3. 独立 L2 索引 ---------- */

test("条目 TSV 往返，同名条目重渲时替换而不是追加", () => {
  const entries = [
    { matchName: "BCC Glow", sheet: 1000, frames: 6, frameTemplate: "thumbs/batch_1000_%04d.png", plugin: "BCC" },
    { matchName: "S_Glow", sheet: 1001, frames: 6, frameTemplate: "thumbs/batch_1001_%04d.png", plugin: "Sapphire" }
  ];
  const back = ps.readEntries(ps.entriesTsv(entries));
  assert.equal(back.length, 2);
  assert.equal(back[1].frameTemplate, "thumbs/batch_1001_%04d.png");
  const replaced = ps.addEntry(back, {
    matchName: "BCC Glow", sheet: 1002, frames: 6,
    frameTemplate: "thumbs/batch_1002_%04d.png", plugin: "BCC"
  });
  assert.equal(replaced.length, 2);
  assert.equal(ps.readEntries(ps.entriesTsv(replaced))[1].sheet, 1002);
});

test("planRun 跳过已有预览与黑名单，并限流", () => {
  const todo = [
    { matchName: "A", frames: 6, plugin: "BCC" },
    { matchName: "B", frames: 6, plugin: "BCC" },
    { matchName: "C", frames: 6, plugin: "Sapphire" },
    { matchName: "D", frames: 6, plugin: "Sapphire" }
  ];
  const done = [{ matchName: "A" }];
  const black = { B: "crash" };
  const run = ps.planRun(todo, done, black, 1);
  assert.deepEqual(Array.from(run).map((x) => x.matchName), ["C"]);
  assert.equal(run[0].frames, 6);
});

test("独立 manifest 是 1×1 单格，条目自带布局且 sheet 按 index 可取", () => {
  const entries = [{
    matchName: "BCC Glow", sheet: 1000, frames: 6,
    frameTemplate: "thumbs/batch_1000_%04d.png", plugin: "BCC"
  }];
  const manifest = JSON.parse(ps.buildManifest(entries, {
    cellSize: 128, columns: 1, width: 128, height: 128
  }));
  assert.equal(manifest.columns, 1);
  assert.equal(manifest.cellSize, 128);
  assert.equal(manifest.width, 128);
  assert.equal(manifest.items.length, 1);
  const item = manifest.items[0];
  assert.equal(item.sliceColumns, 1);
  assert.equal(item.sliceCellSize, 128);
  assert.equal(item.sliceWidth, 128);
  assert.equal(item.sliceHeight, 128);
  // width/height 保持与 L1 item 相同的「格子尺寸」语义
  assert.equal(item.width, 128);
  assert.equal(item.height, 128);
  assert.equal(item.x, 0);
  assert.equal(item.y, 0);
  assert.equal(item.plugin, "BCC");
  assert.equal(item.frameSrc, "thumbs/batch_1000_%04d.png");
  assert.equal(item.src, "thumbs/batch_1000_0000.png");
  assert.equal(manifest.sheets[0].index, 1000);
  assert.equal(manifest.sheets[0].src, "thumbs/batch_1000_0000.png");
  // 不能出现重复键（会把 width/height 覆盖成不同值）
  assert.equal((ps.buildManifest(entries).match(/"width":/g) || []).length, 3);
});

test("spriteSlice 对插件单格图按条目布局切片，不套 L1 整网参数", () => {
  const slice = view.spriteSlice(
    {
      sliceColumns: 1, sliceCellSize: 128, sliceWidth: 128, sliceHeight: 128,
      width: 128, height: 128, x: 0, y: 0
    },
    { columns: 8, cellSize: 128, width: 1024, height: 1024 },
  );
  assert.equal(slice.size, "100.0000% 100.0000%");
  assert.equal(slice.position, "0.0000% 0.0000%");
});

test("L1 条目的 width/height 是格子尺寸，不能被误当成整图布局", () => {
  // 回归：曾把 item.width/height 当整图，rows 变 1，非首格全部切到 (0,0)
  const slice = view.spriteSlice(
    { x: 0, y: 128, width: 128, height: 128 },
    { columns: 8, cellSize: 128, width: 1024, height: 1024 },
  );
  assert.equal(slice.size, "800.0000% 800.0000%");
  assert.equal(slice.position, "0.0000% 14.2857%");
});

/* ---------- 4. 渲染隔离与离线脚本 ---------- */

test("renderBatch 支持 singleCell：1×1 单格，不改默认整网行为", () => {
  const gen = read("cep/com.dreamengine.panel/engine/previewgen.jsx");
  assert.match(gen, /var singleCell = !!\(options && options\.singleCell\)/);
  assert.match(gen, /var columns = singleCell \? 1 : conf\.contactSheet\.columns/);
  assert.match(gen, /var width = singleCell \? cellSize : conf\.contactSheet\.width/);
  assert.match(gen, /var height = singleCell \? cellSize : conf\.contactSheet\.height/);
  assert.match(gen, /var cellOffset = singleCell \? 0 :/);
  // 默认路径仍然取全局定版配置
  assert.match(gen, /var cellSize = conf\.contactSheet\.cellSize/);
});

/* ---------- 5. 面板与名单工具 ---------- */

test("面板：插件预览只进 previews，不进 entries；生成按钮跳过插件", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  assert.match(lib, /data\/plugin_manifest\.json/);
  assert.match(lib, /data\/plugin_blacklist\.json/);
  assert.match(lib, /state\.previews\[pluginPreview\.matchName\] = pluginPreview/);
  assert.doesNotMatch(lib, /state\.entries\.push\(pluginPreview/);
  assert.match(lib, /if \(!AEV_ViewModel\.isBuiltinEffect\(effect\)\)/);
  assert.match(lib, /待离线生成/);
  assert.match(lib, /已跳过/);
});

test("离线脚本：逐条 singleCell + 心跳 + 独立索引，绝不碰主 manifest", () => {
  const jsx = read("tools/run_plugin_preview.jsx");
  assert.match(jsx, /singleCell: true/);
  assert.match(jsx, /appendLog\("BEGIN", item\.matchName/);
  assert.match(jsx, /parsed\.crashed/);
  assert.match(jsx, /plugin_manifest\.json/);
  assert.match(jsx, /plugin_previews\.tsv/);
  assert.match(jsx, /plugin_blacklist\.tsv/);
  assert.doesNotMatch(jsx, /data\/manifest\.json/);
  assert.match(jsx, /AEV_PreviewGen\.renderBatch\(\[item\.matchName\]/);
});

test("来源下拉包含「其它插件」", () => {
  assert.match(read("cep/com.dreamengine.panel/index.html"), /value="其它插件"/);
});

/* ---------- 6. 候选名单端到端 ---------- */

test("候选名单不含内置、按包轮转、遵守黑名单与限流", () => {
  const tmp = resolve(ROOT, ".workbuddy/tmp/plugin-test");
  mkdirSync(tmp, { recursive: true });
  const out = resolve(tmp, "batch.tsv");
  const black = resolve(tmp, "blacklist.tsv");
  const tool = resolve(ROOT, "tools/pick_plugin_candidates.mjs");
  const runTool = (extra) => execFileSync(process.execPath, [
    tool, "--limit", "6", "--out", out, "--blacklist", black
  ].concat(extra), { encoding: "utf8", cwd: ROOT });

  if (existsSync(black)) unlinkSync(black);
  runTool([]);
  const rows = readFileSync(out, "utf8").split(/\r?\n/)
    .filter((l) => l && l.charAt(0) !== "#")
    .map((l) => l.split("\t"));
  assert.equal(rows.length, 6, "应挑出 6 条");
  for (const row of rows) {
    assert.equal(view.isBuiltinEffect({ matchName: row[0] }), false, row[0] + " 不能是内置");
    assert.ok(Number(row[1]) > 0, "帧数必须为正");
    assert.ok(row[2], "必须带插件包");
  }
  assert.ok(new Set(rows.map((r) => r[2])).size >= 3, "首批应覆盖多个插件包");

  // 把第一条拉黑后重挑，它不应再出现
  writeFileSync(black, "matchName\treason\n" + rows[0][0] + "\tcrash\n", "utf8");
  runTool([]);
  const second = readFileSync(out, "utf8").split(/\r?\n/)
    .filter((l) => l && l.charAt(0) !== "#")
    .map((l) => l.split("\t")[0]);
  assert.ok(!second.includes(rows[0][0]), "黑名单条目不应再被挑出");
  unlinkSync(out);
  unlinkSync(black);
});

/* ---------- 运行 ---------- */

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log("[PASS] " + t.name);
  } catch (e) {
    failed++;
    console.log("[FAIL] " + t.name);
    console.log("       " + String(e.message || e).split("\n").slice(0, 6).join("\n       "));
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
