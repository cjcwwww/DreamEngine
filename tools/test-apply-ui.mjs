#!/usr/bin/env node
/* ============================================================
 * test-apply-ui.mjs —— 「双击加效果 / 顶部切换栏 / 静态预览不闪」的回归
 *
 * 这三件事都踩过实机坑，所以固化成断言：
 *   · 双击加效果：引擎侧必须只读选中层（AE 2021 上给 comp.selectedLayers
 *     赋值会崩 AE）、插件效果一个参数都不能碰（碰了整条效果废掉）
 *   · 顶部切换栏：效果预览与预设预览同级，预设不再是抽屉
 *   · 静态预览：各帧内容相同的条目不能播（播起来只会闪）
 *
 * 用法：node tools/test-apply-ui.mjs
 * ============================================================ */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

/** 剥掉注释，避免注释里提到的写法被当成代码 */
function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------- 1. 引擎侧：加效果到选中图层 ---------- */

test("apply.jsx 只读选中层，绝不给 comp.selectedLayers 赋值", () => {
  const src = read("cep/com.dreamengine.panel/engine/apply.jsx");
  const code = codeOf(src);
  // AE 2021 上给合成写 selectedLayers 数组会直接把 AE 弄崩
  assert.doesNotMatch(code, /selectedLayers\s*=/);
  assert.match(code, /comp\.selectedLayers/);
  // 读不到时逐层看 layer.selected
  assert.match(code, /layer\.selected/);
  // 也不许用「按名字取 item」的 API（实测会抛异常甚至崩 AE）
  assert.doesNotMatch(code, /getItemByName/);
});

test("apply.jsx 插件效果一个参数都不碰", () => {
  const src = read("cep/com.dreamengine.panel/engine/apply.jsx");
  const code = codeOf(src);
  // 内置才套显式配方
  assert.match(code, /applyRecipe\(effect, name\)/);
  // 插件走 plugin-default 分支，全程不写参数
  assert.match(code, /mode = "plugin-default"/);
  // 绝不能出现启发式赋值（那会改颜色/模糊值，污染用户工程）
  assert.doesNotMatch(code, /applyHeuristics/);
  assert.doesNotMatch(code, /animate/);
});

test("apply.jsx 不打关键帧，只挂效果", () => {
  const src = read("cep/com.dreamengine.panel/engine/apply.jsx");
  const code = codeOf(src);
  // 关键帧是缩略图用来「演一遍」的，落到用户图层上会污染时间线
  assert.doesNotMatch(code, /setValueAtTime/);
  assert.match(code, /addProperty\(name\)/);
});

test("bridge 的 engine 清单包含 apply.jsx，且排在 recipe 之后", () => {
  const src = read("cep/com.dreamengine.panel/js/bridge.js");
  const applyAt = src.indexOf("engine/apply.jsx");
  const recipeAt = src.indexOf("engine/recipe.jsx");
  assert.notEqual(applyAt, -1, "加载清单缺少 apply.jsx");
  assert.ok(applyAt > recipeAt, "apply.jsx 依赖 recipe，必须排在它后面");
});

/* ---------- 2. 面板：双击添加 ---------- */

test("面板卡片绑 dblclick，单击不加效果", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const code = codeOf(lib);
  assert.match(code, /addEventListener\("dblclick"/);
  // 单击不做任何事：误加效果会污染用户工程
  assert.doesNotMatch(code, /addEventListener\("click", function \(\) \{\s*applyToSelectedLayer/);
  assert.match(code, /function applyToSelectedLayer\(item\)/);
  assert.match(code, /AEV_Apply\.addToSelectedJson/);
});

test("面板用引擎的 apply 模块，且提示用户先选中图层", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const code = codeOf(lib);
  assert.match(code, /no_layer/);
  assert.match(code, /请先在 AE 里选中一个图层/);
});

/* ---------- 3. 顶部切换栏 ---------- */

test("index.html 顶部有效果/预设切换栏，预设不再是抽屉", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  // 切换栏在文件最上方（header 之前）
  const switchAt = html.indexOf('class="view-switch"');
  const headerAt = html.indexOf('class="topbar"');
  assert.notEqual(switchAt, -1, "缺少顶部切换栏");
  assert.ok(switchAt < headerAt, "切换栏必须在顶栏之上");
  assert.match(html, /id="tabEffects"/);
  assert.match(html, /id="tabPresets"/);
  // 两个视图同级
  assert.match(html, /id="viewEffects"/);
  assert.match(html, /id="viewPresets"/);
  // 旧的抽屉没了
  assert.doesNotMatch(html, /presetDrawer/);
  assert.doesNotMatch(html, /id="btnPresets"/);
});

test("面板的 setView 会切换两个视图与工具条的显隐", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const code = codeOf(lib);
  assert.match(code, /function setView\(view\)/);
  assert.match(code, /viewEffects/);
  assert.match(code, /viewPresets/);
  assert.match(code, /effectControls/);
  // 切到预设视图才去读预设库
  assert.match(code, /if \(!isEffects\) loadPresetLibrary\(\)/);
});

test("预设视图渲染成卡片网格，不再是抽屉里的列表", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const css = read("cep/com.dreamengine.panel/css/style.css");
  assert.match(lib, /createElement\("button"\)/);
  assert.match(lib, /preset-card/);
  assert.match(css, /\.preset-grid/);
  assert.match(css, /\.preset-card/);
});

/* ---------- 4. 静态预览不闪 ---------- */

test("面板对静态预览不播动画", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const code = codeOf(lib);
  // 静态名单来自独立索引 animated.json
  assert.match(code, /data\/animated\.json/);
  assert.match(code, /state\.staticPreviews\[/);
  // 静态的不挂 mouseenter 播放
  assert.match(code, /if \(isAnimated\) \{/);
  assert.match(code, /card\.addEventListener\("mouseenter", play\)/);
});

test("状态栏不再拼接插件预览数量（避免窄面板下底栏被撑大）", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const code = codeOf(lib);
  assert.doesNotMatch(code, /插件预览 " \+ state\.pluginPreviewCount/);
  // 状态栏文字单行省略，底栏高度恒定
  const css = read("cep/com.dreamengine.panel/css/style.css");
  assert.match(css, /#statusText[\s\S]*?text-overflow: ellipsis/);
});

test("切帧前先预加载，避免首次悬停闪几下", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const code = codeOf(lib);
  assert.match(code, /function preloadFrames\(/);
  // 预加载完成前不切帧
  assert.match(code, /preview\.__ready/);
  assert.match(code, /preloadFrames\(urls/);
});

/* ---------- 5. 搜索框收成图标 ---------- */

test("搜索框平时是图标，点一下才展开输入框", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const css = read("cep/com.dreamengine.panel/css/style.css");
  // 图标按钮 + 隐藏的输入框
  assert.match(html, /id="searchToggle"/);
  assert.match(html, /id="searchField"[^>]*hidden/);
  assert.match(html, /id="searchInput"/);
  // 展开逻辑
  assert.match(lib, /function setSearchOpen\(/);
  assert.match(lib, /byId\("searchToggle"\)\.addEventListener\("click"/);
  // Esc 收起
  assert.match(lib, /keyCode === 27/);
  // 收起时输入框隐藏
  assert.match(css, /\.search-field\[hidden\]\s*\{\s*display: none/);
});

test("预设视图的搜索框也是图标形态", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  assert.match(html, /id="presetSearchToggle"/);
  assert.match(html, /id="presetSearchField"[^>]*hidden/);
  assert.match(html, /id="presetSearch"/);
  assert.match(lib, /byId\("presetSearchToggle"\)\.addEventListener\("click"/);
});

test("mark_animated 工具按帧字节比对判定静态，且写独立索引", () => {
  const tool = read("tools/mark_animated.mjs");
  assert.match(tool, /createHash\("md5"\)/);
  assert.match(tool, /hashes\.size > 1/);
  // 写独立索引，不动 manifest（manifest 会被引擎整份重写）
  assert.match(tool, /animated\.json/);
  assert.doesNotMatch(tool, /writeFileSync\(path, JSON\.stringify\(manifest/);
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
    console.error(String(error?.stack || error));
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
