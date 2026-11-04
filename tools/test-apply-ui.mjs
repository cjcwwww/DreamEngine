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

/** 剥掉注释，避免注释里提到的写法被当成代码
 *  先统一换行符：Windows 检出（core.autocrlf=true）是 CRLF，
 *  按 "\n" 切完每行尾部还剩 "\r"，`//.*$` 就匹配不到行尾，
 *  注释剥不掉 → 注释里提到的 getItemByName 会被误判成代码。 */
function codeOf(source) {
  return source
    .replace(/\r\n/g, "\n")
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
  assert.match(code, /loadPresetLibrary\(\)/);
  // 离开效果墙时把几百张卡片从 DOM 摘掉（留着虽然看不见，
  // 但每次切回来都要重建，白白浪费建节点的开销）
  assert.match(code, /grid\.textContent = ""/);
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
  assert.match(lib, /function bindSearchToggle\(/);
  assert.match(lib, /bindSearchToggle\("searchToggle"/);
  // Esc 收起
  assert.match(lib, /keyCode === 27/);
  // 收起时输入框隐藏
  assert.match(css, /\.search-field\[hidden\]\s*\{\s*display: none/);
});

test("搜索框能收起：图标再点一次切换、点外部收起、Esc 收起", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const code = codeOf(lib);
  // 图标是「切换」而不是「只展开」——否则点第二次收不起来
  assert.match(code, /if \(isOpen\(\)\) \{[\s\S]*?setSearchOpen\(false/);
  // 点外部收起：监听在 document 上，用 contains 判断是否点在包装内。
  // 旧写法（wrap 上挂 click 再看 event.target === this）永远不成立：
  // 点图标时 target 是按钮、点输入框时 target 是 input，两个条件都不满足。
  assert.match(code, /document\.addEventListener\("mousedown"/);
  assert.match(code, /wrap\.contains\(target\)/);
  assert.doesNotMatch(code, /event\.target === this/);
});

test("预设视图的搜索框也是图标形态", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  assert.match(html, /id="presetSearchToggle"/);
  assert.match(html, /id="presetSearchField"[^>]*hidden/);
  assert.match(html, /id="presetSearch"/);
  assert.match(lib, /bindSearchToggle\(\s*"presetSearchToggle"/);
});

/* ---------- 6. 引擎加载：AEV_Catalog 未定义的回归 ---------- */

test("engine 加载失败时不会永久卡在坏状态", () => {
  const bridge = read("cep/com.dreamengine.panel/js/bridge.js");
  const code = codeOf(bridge);
  // AEV_EngineStamp 是 AE 会话里的全局变量：一旦某次 evalFile 中途失败，
  // 戳已经被写进去，之后文件怎么改都会跳过加载 —— 表现就是
  // 「ERR:ReferenceError: AEV_Catalog 未定义」，整个效果库空白。
  // 所以除了比对戳，还要校验关键模块是否真的在，缺了就强制重载。
  assert.match(code, /typeof AEV_Catalog === 'undefined'/);
  assert.match(code, /typeof AEV_Apply === 'undefined'/);
  assert.match(code, /missing !== ''/);
  // 逐个 evalFile 各自捕获：某一个模块挂了不影响其余模块，
  // 且失败原因能明确报出来，而不是被后面的模块覆盖成误导性报错。
  assert.match(code, /catch\(ej\)/);
  assert.match(code, /ERR:engine_load:/);
});

test("视图隐藏不会被自身的 display 规则盖掉", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  // .workspace 自带 display:flex，特异性高于 [hidden] 的默认 display:none，
  // 不显式写这条，隐藏的效果视图会一直显示 —— 预设视图里会露出整面效果墙。
  assert.match(css, /\.workspace\[hidden\]\s*\{\s*display: none/);
  assert.match(css, /\.preset-view\[hidden\]\s*\{\s*display: none/);
});

test("效果墙与预设视图的 DOM 完全分离", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  const effectsAt = html.indexOf('id="viewEffects"');
  const presetsAt = html.indexOf('id="viewPresets"');
  assert.ok(effectsAt > 0 && presetsAt > effectsAt, "两个视图节点顺序不对");
  const effectsRegion = html.slice(effectsAt, presetsAt);
  // 效果相关的东西必须都在效果视图里
  assert.match(effectsRegion, /id="previewGrid"/);
  assert.match(effectsRegion, /id="categoryList"/);
  // 预设视图里不能有效果相关的东西
  const presetsRegion = html.slice(presetsAt);
  assert.doesNotMatch(presetsRegion, /id="previewGrid"/);
  assert.doesNotMatch(presetsRegion, /id="categoryList"/);
  assert.match(presetsRegion, /id="presetList"/);
});

test("mark_animated 工具按帧字节比对判定静态，且写独立索引", () => {
  const tool = read("tools/mark_animated.mjs");
  assert.match(tool, /createHash\("md5"\)/);
  assert.match(tool, /hashes\.size > 1/);
  // 写独立索引，不动 manifest（manifest 会被引擎整份重写）
  assert.match(tool, /animated\.json/);
  assert.doesNotMatch(tool, /writeFileSync\(path, JSON\.stringify\(manifest/);
});

/* ---------- 4. 设置页与底部栏 ---------- */

test("顶栏只留设置入口，四个按钮搬进设置页", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  const topActions = html.slice(html.indexOf('class="top-actions"'), html.indexOf("</header>"));
  const settings = html.slice(html.indexOf('id="settingsDrawer"'));
  assert.match(topActions, /id="btnSettings"/);
  // 顶栏里不能再有这些按钮
  for (const id of ["langZh", "langEn", "btnGenerate", "btnRefresh", "btnRetry"]) {
    assert.doesNotMatch(topActions, new RegExp(`id="${id}"`), `${id} 还在顶栏`);
  }
  // 它们都在设置页里（id 保持原样，JS 绑定不用改）
  for (const id of ["langZh", "langEn", "btnGenerate", "btnRefresh", "btnRetry"]) {
    assert.match(settings, new RegExp(`id="${id}"`), `${id} 不在设置页`);
  }
  assert.match(settings, /id="settingsDrawer"[^>]*hidden/);
  assert.match(settings, /id="btnSettingsClose"/);
});

test("设置抽屉与隐藏按钮都显式写了 [hidden] 覆盖", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  // 带 display:flex 的容器，hidden 会被类选择器盖掉（上轮踩过）
  assert.match(css, /\.settings-drawer\[hidden\]\s*\{\s*display: none/);
  assert.match(css, /\.settings-action\[hidden\]\s*\{\s*display: none/);
});

test("设置页与队列抽屉互斥，Esc / 点外部都能关", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const code = codeOf(lib);
  assert.match(code, /function setSettingsOpen\(open\)/);
  assert.match(code, /queue\.hidden = true/);
  assert.match(code, /byId\("btnSettings"\)\.addEventListener\("click"/);
  assert.match(code, /key === "Escape"/);
  assert.match(code, /drawer\.contains\(target\)/);
  // 打开队列时也要关设置页
  const queueBinding = code.slice(
    code.indexOf('byId("btnQueue").addEventListener'),
    code.indexOf('byId("btnQueueClose")'),
  );
  assert.match(queueBinding, /setSettingsOpen\(false\)/);
});

test("底部栏固定高度、禁止换行，窄比例按顺序隐藏次要项", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  const block = css.slice(css.indexOf(".statusbar {"), css.indexOf(".statusbar .error"));
  assert.match(block, /height: 32px/);
  assert.match(block, /flex-wrap: nowrap/);
  assert.match(block, /overflow: hidden/);
  assert.match(css, /\.statusbar > \*\s*\{[^}]*white-space: nowrap/);
  assert.match(css, /#statusText\s*\{[^}]*text-overflow: ellipsis/);
  // 断点：标签 → 滑块 → 「显示 N」→ 整个滑块
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /@media \(max-width: 460px\)/);
  assert.match(css, /@media \(max-width: 360px\)/);
  assert.match(css, /\.size-slider label\s*\{\s*display: none/);
  assert.match(css, /#selectionStats\s*\{\s*display: none/);
});

test("队列计数改成紧凑数字，完整含义放 title", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const code = codeOf(lib);
  assert.match(code, /counts\.textContent = data\.pending \+ " \/ " \+ data\.failed/);
  assert.doesNotMatch(code, /" 待渲染 \/ "/);
  assert.match(code, /toggle\.title =/);
  // 长状态文案也要留完整内容
  assert.match(code, /status\.title = text/);
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
