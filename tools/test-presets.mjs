#!/usr/bin/env node
/* ============================================================
 * test-presets.mjs —— M3 预设库的静态回归
 *
 * 预设库最要紧的不是「能不能扫到文件」，而是**应用预设不能把用户的工程弄脏**：
 * T0.4 实测结论——applyPreset 对图层类型不匹配时静默无效，没有选中层时
 * 会自己新建图层。所以安全措施（清空选区、只选目标层、调用后比对、
 * 按类型顺序重试、remove() 删掉自动新建的图层）必须一直在。
 *
 * 用法：node tools/test-presets.mjs
 * ============================================================ */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/** 只看代码行：注释里常会提到被禁用的写法（说明「不要用它」） */
function codeOf(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, "").replace(/^\s*\*.*$/, ""))
    .join("\n");
}

/* presets.jsx 顶层只是定义函数，不碰 app/File/Folder，可以直接在 vm 里加载 */
function loadPresets() {
  const ctx = vm.createContext({});
  vm.runInContext(read("cep/com.dreamengine.panel/engine/presets.jsx"), ctx);
  return ctx.AEV_Presets;
}

test(".ffx 判定只看后缀", () => {
  const p = loadPresets();
  assert.equal(p.isPresetFile("夜视.ffx"), true);
  assert.equal(p.isPresetFile("Night Vision.FFX"), true);
  assert.equal(p.isPresetFile("工程.aep"), false);
  assert.equal(p.isPresetFile("ffx"), false);
});

test("预设分类取所在目录名", () => {
  const p = loadPresets();
  assert.equal(p.categoryOf("C:/Presets/Text/3D Text/夜视.ffx"), "3D Text");
  assert.equal(p.categoryOf("C:\\Presets\\Image - Special Effects\\夜视.ffx"), "Image - Special Effects");
});

test("应用预设的安全措施一个都不能少", () => {
  const src = read("cep/com.dreamengine.panel/engine/presets.jsx");
  // 注释里会提到这些被禁用的写法（例如说明「不要用 app.applyPreset」），
  // 所以断言只看代码行。
  const code = codeOf(src);
  // 选层用 layer.selected，不能给 comp.selectedLayers 赋值（AE 2021 上会崩 AE）
  assert.match(code, /target\.selected = true/);
  assert.doesNotMatch(code, /comp\.selectedLayers = \[/);
  // 用图层方法应用预设，不能用 app.applyPreset（AE 2021 上会崩 AE）
  assert.match(code, /best\.layer\.applyPreset\(file\)/);
  assert.doesNotMatch(code, /app\.applyPreset\(/);
  // 试探要能回滚：只保留效果最多的那一层
  assert.match(code, /function rollback\(/);
  assert.match(code, /rollback\(comp, target, before, after\)/);
  // 按类型顺序重试：纯色 → 文本 → 素材 → 调整层
  assert.match(src, /LAYER_ORDER = \["solid", "text", "footage", "adjustment"\]/);
  // 调用后要比对效果数与关键帧数，才知道有没有真的生效
  assert.match(code, /addedEffects/);
  assert.match(code, /addedKeys/);
  // 自动新建的图层用 remove() 删掉（不依赖撤销）
  assert.match(code, /comp\.layer\(i\)\.remove\(\)/);
  // 没有选中层时预设会自己建层，所以必须先记录调用前的图层数
  assert.match(code, /before = snapshot\(comp\)/);
});

test("不能依赖 AE 的几个不稳定 API", () => {
  const src = read("cep/com.dreamengine.panel/engine/presets.jsx");
  const code = codeOf(src);
  // app.path 在 AE 2021 是 undefined（所以预设目录靠扫 Program Files 找到，
  // app.path 只能当兜底）；typeName 是本地化的；getItemByName 会崩 AE
  assert.match(code, /Support Files\/Presets/);
  assert.doesNotMatch(code, /typeName\) === "Composition"/);
  assert.doesNotMatch(code, /items\.getItemByName/);
  // 合成判定改成看有没有 numLayers
  assert.match(code, /item\.numLayers/);
  // 目录名可能是 URL 编码形式，比较时要能解码
  assert.match(code, /decodeURI/);
});

test("预设目录扫描必须递归（单层 getFiles('*.ffx') 在 AE 上返回 0）", () => {
  const src = read("cep/com.dreamengine.panel/engine/presets.jsx");
  assert.match(src, /entry instanceof Folder/);
  assert.match(src, /collect\(entry, depth \+ 1, out\)/);
});

test("依赖检查用 catalog 的 hasEffect，不重新解析整份 JSON", () => {
  const presets = read("cep/com.dreamengine.panel/engine/presets.jsx");
  assert.match(presets, /AEV_Catalog\.hasEffect/);
  assert.doesNotMatch(presets, /eval\("\("/);
});

test("catalog 的会话缓存：只枚举一次 app.effects", () => {
  let enumerations = 0;
  const ctx = vm.createContext({
    app: {
      version: "18.4.1",
      get effects() {
        enumerations++;
        return [
          { matchName: "ADBE Glo2", displayName: "发光", category: "风格化" },
          { matchName: "BCC Glow", displayName: "BCC Glow", category: "BCC Lights" }
        ];
      }
    },
    PropertyValueType: { COLOR: 6419, CHECKBOX: 6414, OneD: 6417, TWO_D: 6418 }
  });
  vm.runInContext(read("cep/com.dreamengine.panel/engine/catalog.jsx"), ctx);
  const catalog = ctx.AEV_Catalog;
  const first = catalog.getCatalogJson(false);
  const second = catalog.getCatalogJson(false);
  assert.equal(first, second, "两次取值应完全一致");
  assert.equal(enumerations, 1, "app.effects 只应枚举一次（缓存生效）");
  assert.equal(catalog.hasEffect("ADBE Glo2"), true);
  assert.equal(catalog.hasEffect("S_Glow"), false);
  const forced = catalog.getCatalogJson(true);
  assert.equal(forced, first, "同样的数据，JSON 应一致");
  assert.equal(enumerations, 2, "force=true 应重新枚举");
});

test("引擎模块列表包含 presets（面板要能调到它）", () => {
  const bridge = read("cep/com.dreamengine.panel/js/bridge.js");
  assert.match(bridge, /engine\/presets\.jsx/);
  // catalog 必须在 presets 之前：presets 的依赖检查要用 catalog.hasEffect
  const catalogAt = bridge.indexOf("engine/catalog.jsx");
  const presetsAt = bridge.indexOf("engine/presets.jsx");
  assert.ok(catalogAt > 0 && presetsAt > catalogAt, "加载顺序：catalog 先于 presets");
});

test("预设库是用户自建的：自己挑文件复制入库，不再扫 AE 目录", () => {
  const src = read("cep/com.dreamengine.panel/engine/presets.jsx");
  const code = codeOf(src);
  assert.match(code, /function pickJson\(/);
  assert.match(code, /File\.openDialog\(/);
  assert.match(code, /function importOneJson\(/);
  assert.match(code, /function libraryJson\(/);
  assert.match(code, /src\.copy\(target\)/);
  // 面板侧：读自建库、走文件选择框，不再调用扫描
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  assert.doesNotMatch(lib, /scanJson\(/);
  assert.doesNotMatch(lib, /defaultRootJson\(/);
  assert.match(lib, /AEV_Presets\.libraryJson\(\)/);
  assert.match(lib, /AEV_Presets\.pickJson\(\)/);
  assert.match(lib, /AEV_Presets\.importOneJson\(/);
});

/* ---------- 添加预设：文件选择框必须真能选到 .ffx ---------- */

test("File.openDialog 的 Windows 过滤器用 *.ffx，不再用没有冒号的错误格式", () => {
  const src = read("cep/com.dreamengine.panel/engine/presets.jsx");
  const code = codeOf(src);
  // 之前写成 "After Effects 预设 (*.ffx)" —— Windows 会把整串当描述、
  // 扩展名为空，对话框里一个 .ffx 都看不到（用户实测「根本没法选」）
  const pick = code.slice(code.indexOf("function pickJson()"), code.indexOf("function importOneJson("));
  assert.doesNotMatch(pick, /"After Effects 预设 \(\*\.ffx\)"/);
  assert.match(pick, /filter = "\*\.ffx"/);
  // 按平台分支：macOS 用函数式 filter
  assert.match(pick, /\$\.os/);
  assert.match(pick, /f instanceof Folder/);
  // 对话框过滤器可能被忽略，代码里还要按后缀再判一次
  assert.match(pick, /isPresetFile\(f\.name\)/);
});

test("添加预设主通道走 CEF 原生文件框，不走 AE 模态对话框", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const code = codeOf(lib);
  assert.match(html, /id="presetFileInput"[^>]*type="file"/);
  assert.match(html, /accept="\.ffx"/);
  assert.match(html, /multiple/);
  const add = code.slice(code.indexOf("function addPresets()"), code.indexOf("function pickPresetsViaEngine()"));
  assert.match(add, /input\.click\(\)/);
  assert.doesNotMatch(add, /AEV_Presets\.pickJson\(\)/);
  // CEF 的 File 对象带 path（T0.6b 实机验证过）
  assert.match(code, /files\[i\]\.path/);
  // 拿不到 path 时要能退回 AE 的文件框
  assert.match(code, /function pickPresetsViaEngine\(\)/);
  assert.match(code, /if \(ffxWithoutPath\) pickPresetsViaEngine\(\)/);
});

test("拖入 .ffx 也能入库；入库前过滤后缀并统一路径分隔符", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const code = codeOf(lib);
  assert.match(code, /function onPresetDrop\(event\)/);
  assert.match(code, /dataTransfer/);
  assert.match(code, /addEventListener\("drop", onPresetDrop\)/);
  assert.match(code, /function importPresetPaths\(paths\)/);
  assert.match(code, /replace\(\/\\\\\/g, "\/"\)/);
  assert.match(code, /\\\.ffx\$\/i\.test\(p\)/);
});

/* ---------- 预设预览生成（静态 / 关键帧区间 / 用户背景） ---------- */

test("预设预览引擎已接入 bridge 的加载清单", () => {
  const bridge = read("cep/com.dreamengine.panel/js/bridge.js");
  assert.match(bridge, /engine\/preset_preview\.jsx/);
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  assert.match(lib, /AEV_PresetPreview\.renderJson\(/);
  assert.match(lib, /AEV_PresetPreview\.backgroundsJson\(/);
});

test("静态预设出 1 帧；含关键帧的覆盖首末关键帧再均匀抽帧", () => {
  const src = codeOf(read("cep/com.dreamengine.panel/engine/preset_preview.jsx"));
  // 关键帧范围靠遍历属性树读 numKeys / keyTime，不读参数值（读值会崩 AE）
  assert.match(src, /function walkKeys\(/);
  assert.match(src, /p\.numKeys/);
  assert.match(src, /p\.keyTime\(1\)/);
  assert.doesNotMatch(src, /\.maxValue/);
  // 无关键帧 → 静态 1 帧
  assert.match(src, /var animated = range\.keys > 0/);
  assert.match(src, /var span = 1 \/ FPS/);
  // 有关键帧 → 渲染整个区间（timeSpanStart / Duration），再抽最多 6 帧
  assert.match(src, /queueItem\.timeSpanStart = start/);
  assert.match(src, /queueItem\.timeSpanDuration = span/);
  assert.match(src, /Math\.min\(MAX_FRAMES, rawFiles\.length\)/);
  assert.match(src, /var wanted = animated \?/);
  // comp 时长必须覆盖到最后一个关键帧
  assert.match(src, /comp\.duration = Math\.max/);
});

test("渲染在临时合成里做，插件预设跳过，临时对象全部回收", () => {
  const src = codeOf(read("cep/com.dreamengine.panel/engine/preset_preview.jsx"));
  assert.match(src, /app\.project\.items\.addComp\(\s*"DE_preset_cell_/);
  // AE 2021 上会崩的写法一个都不能用
  assert.doesNotMatch(src, /app\.applyPreset\(/);
  assert.doesNotMatch(src, /comp\.selectedLayers\s*=/);
  assert.doesNotMatch(src, /getItemByName/);
  assert.match(src, /Layer\.applyPreset\(file\)/);
  // 含第三方插件效果的预设不渲染
  assert.match(src, /function pluginMatchName\(/);
  assert.match(src, /result\("plugin_preset"/);
  // 渲染队列项 / 临时合成 / 素材 / raw 帧都要删
  assert.match(src, /queueItem\.remove\(\)/);
  assert.match(src, /comp\.remove\(\)/);
  assert.match(src, /rawFiles\[i\]\.remove\(\)/);
});

test("预览背景可选内置 5 种或用户上传，索引写独立文件", () => {
  const src = codeOf(read("cep/com.dreamengine.panel/engine/preset_preview.jsx"));
  assert.match(src, /BUILTIN_BACKGROUNDS = \[/);
  assert.match(src, /"photo"/);
  assert.match(src, /"text"/);
  assert.match(src, /"solid"/);
  assert.match(src, /"shape"/);
  assert.match(src, /"pattern"/);
  assert.match(src, /function importBackgroundJson\(/);
  assert.match(src, /function addBackground\(/);
  assert.match(src, /AEV_Assets\.getFresh\(id, size\)/);
  // 独立索引，绝不写 L1 的 manifest.json
  assert.match(src, /preset_manifest\.json/);
  assert.doesNotMatch(src, /data\/manifest\.json/);
});

test("面板有背景选择/上传/生成入口，卡片区分静态与动态", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  const lib = codeOf(read("cep/com.dreamengine.panel/js/library.js"));
  const css = read("cep/com.dreamengine.panel/css/style.css");
  assert.match(html, /id="presetBackground"/);
  assert.match(html, /id="btnBackgroundAdd"/);
  assert.match(html, /id="btnPresetPreview"/);
  assert.match(html, /id="presetBackgroundFile"[^>]*type="file"/);
  assert.match(lib, /function generatePresetPreviews\(/);
  assert.match(lib, /function loadPresetIndex\(/);
  assert.match(lib, /function savePresetIndex\(/);
  assert.match(lib, /function attachPreview\(/);
  assert.match(lib, /preview\.animated !== false/);
  assert.match(css, /\.preset-thumb\s*\{/);
  assert.match(css, /\.preset-badge/);
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
