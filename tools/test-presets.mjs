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
  // 只选目标层，不留别的选区
  assert.match(src, /comp\.selectedLayers = \[target\]/);
  // 按类型顺序重试：纯色 → 文本 → 素材 → 调整层
  assert.match(src, /LAYER_ORDER = \["solid", "text", "footage", "adjustment"\]/);
  // 调用后要比对效果数与关键帧数，才知道有没有真的生效
  assert.match(src, /addedEffects/);
  assert.match(src, /addedKeys/);
  // 自动新建的图层用 remove() 删掉（不依赖撤销）
  assert.match(src, /comp\.layer\(i\)\.remove\(\)/);
  // 没有选中层时预设会自己建层，所以必须先记录调用前的图层数
  assert.match(src, /before = snapshot\(comp\)/);
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
