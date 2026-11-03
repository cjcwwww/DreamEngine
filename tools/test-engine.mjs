#!/usr/bin/env node
/* ============================================================
 * engine 层测试
 *
 * 覆盖范围：
 *   · render_config 与仓库根 config/render_params.jsxinc 的数值一致性（防漂移）
 *   · recipe 的启发式取值与 no-preview 判定（纯函数，可在 node 内实跑）
 *   · previewgen 的容量规划与失败策略（源码契约 + 纯函数）
 *   · store 的写权限自检必须走 app.preferences，不得再用不存在的 app.settings
 *   · bridge 的 engine 加载顺序（依赖必须先于依赖方）
 *   · queue 的状态机与持久化格式
 *
 * 这些都不是"跑一遍看有没有报错"，而是把 M0 的实测结论与设计约束固化成断言。
 * ============================================================ */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const ENGINE = "cep/com.dreamengine.panel/engine";

function read(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

/** 剥掉注释后再做"代码里不得出现 X"类断言。
 *  否则注释里提到 copyToComp / app.settings 这类词会造成误报。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** 在同一 context 内按顺序求值多个 ES3 模块，返回该 context */
function loadModules(relativePaths, extra) {
  const context = vm.createContext(Object.assign({}, extra || {}));
  for (const rel of relativePaths) {
    vm.runInContext(read(rel), context, { filename: rel });
  }
  return context;
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

/* ---------- 1. 定版参数一致性 ---------- */

function numericField(source, field) {
  const match = source.match(new RegExp(field + ":\\s*(\\d+)"));
  return match ? Number(match[1]) : null;
}

test("render_config 与 config/render_params.jsxinc 数值一致", () => {
  const shipped = read("config/render_params.jsxinc");
  const embedded = read(`${ENGINE}/render_config.jsx`);
  const fields = [
    "columns",
    "cellSize",
    "width",
    "height",
    "effectsPerSheet",
    "frameCount",
    "fps",
    "totalEffects",
    "staticEffects",
    "animatedEffects",
    "aerenderConcurrency",
  ];
  for (const field of fields) {
    assert.equal(
      numericField(embedded, field),
      numericField(shipped, field),
      `字段 ${field} 在扩展副本与仓库配置之间不一致`,
    );
  }
  assert.match(embedded, /pngOutputTemplate: "DreamEngine PNG Sequence"/);
});

/* ---------- 2. recipe 纯函数 ---------- */

test("recipe 的启发式只处理语义明确的四类属性", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipe = ctx.AEV_Recipe;

  const color = recipe.heuristicValue("color");
  assert.equal(color.length, 3);

  // TwoD 实测会触发 AE 内部脚本异常（CC 系列 Center 是 0–1 归一化坐标），必须跳过
  assert.equal(recipe.heuristicValue("twoD", null, null, 256), undefined);
  assert.equal(recipe.heuristicValue("checkbox"), true);
  assert.equal(recipe.heuristicValue("oneD", 0, 100), 50);
  assert.equal(recipe.heuristicValue("oneD", null, 100), undefined);
  assert.equal(recipe.heuristicValue("other"), undefined);
});

test("recipe 把表达式控件族与音频族判为不渲图", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipe = ctx.AEV_Recipe;
  assert.equal(recipe.isNoPreview("Expression Controls"), true);
  assert.equal(recipe.isNoPreview("表达式控制"), true);
  assert.equal(recipe.isNoPreview("Audio"), true);
  assert.equal(recipe.isNoPreview("音频"), true);
  assert.equal(recipe.isNoPreview("Blur & Sharpen"), false);
  assert.equal(recipe.isNoPreview("模糊和锐化"), false);
});

test("recipe 展示时点取合成中点", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  assert.equal(ctx.AEV_Recipe.presentationTime({ duration: 2 }), 1);
});

/* ---------- 3. previewgen ---------- */

test("previewgen 的容量规划按 8x8 网格与 6 帧计算", () => {
  const ctx = loadModules([
    `${ENGINE}/render_config.jsx`,
    `${ENGINE}/previewgen.jsx`,
  ]);
  const gen = ctx.AEV_PreviewGen;

  const full = gen.plan(64);
  assert.equal(full.sheets, 1);
  assert.equal(full.totalRenders, 6);

  const overshoot = gen.plan(80);
  assert.equal(overshoot.sheets, 2);
  assert.equal(overshoot.totalRenders, 12);

  assert.equal(gen.plan(0).sheets, 0);
});

test("previewgen 只接受 PNG 模板，找不到就失败", () => {
  const ctx = loadModules([`${ENGINE}/previewgen.jsx`]);
  const gen = ctx.AEV_PreviewGen;
  assert.equal(gen.pngTemplate({ templates: ["Lossless", "PNG Sequence"] }), "PNG Sequence");
  assert.equal(gen.pngTemplate({ templates: ["无损", "高品质"] }), null);

  const source = read(`${ENGINE}/previewgen.jsx`);
  assert.match(source, /throw new Error\("no_png_template"\)/);
  // 不允许回退到非 PNG 模板
  assert.doesNotMatch(source, /return fallback/);
});

test("previewgen 的临时合成清理不依赖 undo", () => {
  const code = stripComments(read(`${ENGINE}/previewgen.jsx`));
  assert.doesNotMatch(code, /\.copyToComp\(/);
  assert.match(code, /finally \{/);
  assert.match(code, /cells\[c\]\.remove\(\)/);
  assert.match(code, /queueItem\.remove\(\)/);
});

test("previewgen 用合成帧率换算渲染时长，不用面板播放帧率", () => {
  const code = stripComments(read(`${ENGINE}/previewgen.jsx`));
  // 6 帧按 12fps 算成 0.5 秒，在 30fps 合成上会渲出 15 帧（AE 2021 实测踩过）
  assert.match(code, /var CELL_FPS = 30;/);
  assert.match(code, /var durationSeconds = frames \/ CELL_FPS;/);
  assert.match(code, /queueItem\.timeSpanDuration = durationSeconds;/);
  assert.doesNotMatch(code, /timeSpanDuration = frames \/ fps/);
});

test("previewgen 渲染前清掉同名历史帧", () => {
  const code = stripComments(read(`${ENGINE}/previewgen.jsx`));
  assert.match(code, /getFiles\(baseName \+ "_\*\.png"\)/);
});

test("previewgen 的标准素材尺寸必须是整数（AE 2021 addSolid 硬要求）", () => {
  const code = stripComments(read(`${ENGINE}/previewgen.jsx`));
  // addSolid(color, name, width, height, pixelAspect)：宽高不能是小数
  assert.doesNotMatch(
    code,
    /addSolid\([^)]*,\s*size \*/,
    "addSolid 的尺寸参数不得直接乘以比例，必须先 Math.round",
  );
  assert.match(code, /Math\.round\(size \* 0\.59\)/);
  assert.match(code, /Math\.round\(size \* 0\.23\)/);
});

test("manifest v2 同时支持单文件与帧序列", () => {
  const source = read(`${ENGINE}/previewgen.jsx`);
  assert.match(source, /"version":2/);
  assert.match(source, /"frameSrc":/);
  assert.match(source, /"src":/);
});

/* ---------- 4. store ---------- */

test("store 的写权限自检走 app.preferences，不再使用不存在的 app.settings", () => {
  const code = stripComments(read(`${ENGINE}/store.jsx`));
  assert.doesNotMatch(code, /app\.settings/);
  assert.match(code, /app\.preferences\.getPrefAsLong/);
  assert.match(code, /Pref_SCRIPTING_FILE_NETWORK_SECURITY/);
});

/** 最小内存文件系统，用来在 node 里跑 store.jsx 的写探测 */
function makeFsMock(allowWrite) {
  const written = new Set();
  class FileMock {
    constructor(path) {
      this.path = path;
      this.exists = written.has(path);
    }
    get fsName() {
      return this.path;
    }
    get parent() {
      return new (class {
        constructor(p) {
          this.fsName = p;
          this.exists = true;
        }
        create() {
          return true;
        }
      })(this.path.replace(/\/[^/]*$/, ""));
    }
    open() {
      if (!allowWrite) return false;
      written.add(this.path);
      this.exists = true;
      return true;
    }
    write() {}
    close() {}
    remove() {
      written.delete(this.path);
      this.exists = false;
      return true;
    }
  }
  class FolderMock {
    constructor(path) {
      this.fsName = path;
      this.exists = true;
    }
    create() {
      return true;
    }
  }
  FolderMock.myDocuments = { fsName: "C:/docs" };
  return { File: FileMock, Folder: FolderMock, written };
}

test("store 写权限以实际写文件为准，首选项只做快速否决", () => {
  const cases = [
    { pref: -1, allowWrite: true, expected: 1, label: "首选项读不到但能写" },
    { pref: 0, allowWrite: true, expected: 0, label: "首选项明确关闭" },
    { pref: 1, allowWrite: false, expected: 0, label: "首选项开着但写不进去" },
    { pref: null, allowWrite: false, expected: null, label: "两层都无法判定" },
  ];
  for (const item of cases) {
    const fs = makeFsMock(item.allowWrite);
    const app =
      item.pref === null
        ? {}
        : { preferences: { getPrefAsLong: () => item.pref } };
    const ctx = loadModules([`${ENGINE}/store.jsx`], {
      app,
      File: fs.File,
      Folder: fs.Folder,
    });
    assert.equal(
      ctx.AEV_Store.writePermission(),
      item.expected,
      `${item.label} 应返回 ${item.expected}`,
    );
  }
});

test("store 把所有数据写在 我的文档/DreamEngine 下", () => {
  const source = read(`${ENGINE}/store.jsx`);
  assert.match(source, /var ROOT_NAME = "DreamEngine";/);
  assert.match(source, /Folder\.myDocuments\.fsName/);
});

/* ---------- 5. bridge 加载顺序 ---------- */

test("bridge 的 engine 加载顺序满足依赖关系", () => {
  const source = read("cep/com.dreamengine.panel/js/bridge.js");
  const order = ["render_config", "store", "names", "assets", "recipe", "previewgen", "queue", "catalog"].map(
    (name) => source.indexOf(`engine/${name}.jsx`),
  );
  for (const index of order) assert.notEqual(index, -1, "加载清单缺少模块");
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], "engine 模块顺序必须满足依赖（config → store → names → assets → recipe → previewgen → queue）");
  }
});

/* ---------- names.jsx ---------- */

test("names 解析 TSV 并跳过表头", () => {
  const ctx = loadModules([`${ENGINE}/names.jsx`]);
  const names = ctx.AEV_Names;
  const tsv = [
    "matchName\tnameEn\tnameZh\tcategoryEn\tcategoryZh\tpluginHint\tnameZhSource",
    "ADBE Gaussian Blur 2\tGaussian Blur\t高斯模糊\tBlur & Sharpen\t模糊和锐化\t内置\thelpx",
    "S_Glow\tS_Glow\t\tSapphire\tSapphire\tSapphire\tcommunity",
  ].join("\n");
  const rows = names.parseTsv(tsv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].matchName, "ADBE Gaussian Blur 2");
  assert.equal(rows[0].nameZh, "高斯模糊");
  assert.equal(rows[1].nameZh, "");

  const index = names.buildIndex(rows);
  assert.equal(names.resolve(index, "ADBE Gaussian Blur 2", "x", "zh").name, "高斯模糊");
  assert.equal(names.resolve(index, "ADBE Gaussian Blur 2", "x", "en").name, "Gaussian Blur");
  // 第三方无中文时：中文模式回退英文，不机翻
  assert.equal(names.resolve(index, "S_Glow", "x", "zh").name, "S_Glow");
});

test("names 对表外效果走 L-C 兜底，显示本机名", () => {
  const ctx = loadModules([`${ENGINE}/names.jsx`]);
  const names = ctx.AEV_Names;
  const index = names.buildIndex([]);
  const resolved = names.resolve(index, "XX Unknown", "本机显示名", "zh");
  assert.equal(resolved.name, "本机显示名");
  assert.equal(resolved.level, "fallback");
  assert.equal(resolved.source, "local");
});

test("names 覆盖率统计命中与未命中", () => {
  const ctx = loadModules([`${ENGINE}/names.jsx`]);
  const names = ctx.AEV_Names;
  const index = names.buildIndex([{ matchName: "A", nameEn: "A" }, { matchName: "B", nameEn: "B" }]);
  const report = names.coverage(index, ["A", "B", "C", "D"]);
  assert.equal(report.total, 4);
  assert.equal(report.hit, 2);
  assert.equal(report.miss, 2);
  assert.equal(report.ratio, 50);
  assert.deepEqual(Array.from(report.missSamples), ["C", "D"]);
});

/* ---------- recipe 场景与指纹 ---------- */

test("recipe 按效果类型推断场景，文本类落 text", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipe = ctx.AEV_Recipe;
  assert.equal(recipe.sceneFor("ADBE Text Animator"), "text");
  assert.equal(recipe.sceneFor("Anything", "文本"), "text");
  assert.equal(recipe.sceneFor("ADBE 3D Tracker", "3D 通道"), "3d-camera");
  assert.equal(recipe.sceneFor("ADBE Stroke"), "shape-mask");
  assert.equal(recipe.sceneFor("CC Radial Blur", "模糊和锐化"), "footage-2d");
  assert.equal(recipe.sceneFor("Anything", "音频"), "no-preview");
  assert.equal(recipe.sceneFor("Anything", "表达式控制"), "no-preview");
});

test("recipe 场景到素材类型映射完整", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipe = ctx.AEV_Recipe;
  assert.equal(recipe.assetKindFor("text"), "text");
  assert.equal(recipe.assetKindFor("solid-2d"), "solid");
  assert.equal(recipe.assetKindFor("shape-mask"), "shape");
  // 其余场景先用复合画面顶上
  for (const scene of ["footage-2d", "adjustment", "two-layer-input", "3d-camera"]) {
    assert.equal(recipe.assetKindFor(scene), "photo");
  }
});

test("缓存指纹随配方版本与素材版本变化，且不包含 AE 版本", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipe = ctx.AEV_Recipe;
  const a = recipe.cacheKey("ADBE Glo2", "photo-v2", 256, 6);
  const b = recipe.cacheKey("ADBE Glo2", "photo-v2", 256, 6);
  const c = recipe.cacheKey("ADBE Glo2", "photo-v2", 256, 12);
  const d = recipe.cacheKey("ADBE Glo2", "photo-v3", 256, 6);
  assert.equal(a, b, "同输入必须同指纹");
  assert.notEqual(a, c, "帧数变化要换指纹");
  assert.notEqual(a, d, "素材版本变化要换指纹");
  assert.match(a, /^[0-9a-z]+$/);
});

/* ---------- assets / catalog 静态契约 ---------- */

test("assets 按类型生成四套素材并复用缓存", () => {
  const code = stripComments(read(`${ENGINE}/assets.jsx`));
  assert.match(code, /var VERSION = "photo-v2";/);
  assert.match(code, /function buildPhoto/);
  assert.match(code, /function buildText/);
  assert.match(code, /function buildSolid/);
  assert.match(code, /function buildShape/);
  assert.match(code, /cache\[key\(kind, size\)\] = \{ item: comp \};/);
});

test("catalog 参数树带深度与数量上限，且用完即删", () => {
  const code = stripComments(read(`${ENGINE}/catalog.jsx`));
  assert.match(code, /var MAX_DEPTH = 3;/);
  assert.match(code, /var MAX_PARAMS = 200;/);
  assert.match(code, /comp\.remove\(\)/);
  assert.match(code, /getParamTreeJson/);
  assert.match(code, /canVaryOverTime/);
});

/* ---------- 6. queue ---------- */

test("queue 用 TSV 持久化，避免 ExtendScript 解析 JSON", () => {
  const code = stripComments(read(`${ENGINE}/queue.jsx`));
  assert.match(code, /var QUEUE_FILE = "cache\/queue\.tsv";/);
  assert.match(code, /var SEP = "\\t";/);
  assert.doesNotMatch(code, /JSON\.parse/);
});

test("queue 的状态机符合 pending → rendering → cached/failed", () => {
  const source = read(`${ENGINE}/queue.jsx`);
  for (const status of ['"pending"', '"rendering"', '"cached"', '"failed"']) {
    assert.ok(source.includes(status), `缺少状态 ${status}`);
  }
  assert.match(source, /var MAX_ATTEMPTS = 2;/);
});

test("queue 的 drain 一次只渲一张网并返回本批名单", () => {
  const source = read(`${ENGINE}/queue.jsx`);
  assert.match(source, /var limit = \(options && options\.limit\) \|\| perSheet;/);
  assert.match(source, /namesJson\.join\(","\)/);
  assert.match(source, /\\"names\\":\[/);
  assert.match(source, /renderBatch\(batch, sheetIndex, options\)/);
});

/* ---------- 7. 面板侧 ---------- */

test("manifest 的 sheets.src 指向真实存在的帧文件", () => {
  const code = stripComments(read(`${ENGINE}/previewgen.jsx`));
  // 帧序列网的实体文件是 batch_XXX_0000.png，写 batch_XXX.png 会指向不存在的文件
  assert.match(code, /_0000\.png/);
});

test("面板优先渲染看得出差异的分类，并跳过 3D 通道族", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;

  assert.equal(view.isPoorPreviewTarget({ matchName: "ADBE 3D Tracker", category: "3D Channel" }), true);
  assert.equal(view.isPoorPreviewTarget({ matchName: "ADBE 3D Glasses", category: "透视" }), true);
  // CS 前缀实测渲染报「滤镜无效」，整批会随之失败
  assert.equal(view.isPoorPreviewTarget({ matchName: "CS CrossBlur", category: "模糊和锐化" }), true);
  // CC Drizzle 实测在 2048 整网 × 6 帧下渲染挂起
  assert.equal(view.isPoorPreviewTarget({ matchName: "CC Drizzle", category: "模拟" }), true);
  assert.equal(view.isPoorPreviewTarget({ matchName: "ADBE Gaussian Blur 2", category: "模糊和锐化" }), false);

  const blur = view.previewRank({ matchName: "ADBE Gaussian Blur 2", category: "模糊和锐化" });
  const unknown = view.previewRank({ matchName: "XX Something", category: "未收录分类" });
  const poor = view.previewRank({ matchName: "ADBE 3D Tracker", category: "3D Channel" });
  assert.ok(blur < unknown, "常用分类应排在未知分类之前");
  assert.ok(unknown < poor, "未知分类应排在已排除项之前");
});

test("候选按分类轮转，首批覆盖多个类别", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const list = [
    { matchName: "A1", category: "模糊和锐化" },
    { matchName: "A2", category: "模糊和锐化" },
    { matchName: "A3", category: "模糊和锐化" },
    { matchName: "B1", category: "扭曲" },
    { matchName: "C1", category: "颜色校正" },
  ];
  // Array.from 把 vm realm 的数组转成本 realm，否则 deepStrictEqual 会因原型不同而失败
  const out = Array.from(view.interleaveByCategory(list), (item) => item.matchName);
  assert.deepEqual(out.slice(0, 3), ["A1", "C1", "B1"], "首批应各分类各取一个");
  assert.equal(out[3], "A2", "之后继续填第二轮的模糊类");
  assert.equal(out.length, 5, "不得丢条目");
});

test("viewmodel 的 no-preview 规则与 recipe 保持一致", () => {
  const viewmodel = read("cep/com.dreamengine.panel/js/viewmodel.js");
  const recipe = read(`${ENGINE}/recipe.jsx`);
  for (const token of ["expression controls", "表达式控制", "audio", "音频"]) {
    assert.ok(viewmodel.toLowerCase().includes(token.toLowerCase()), `viewmodel 缺少 ${token}`);
    assert.ok(recipe.toLowerCase().includes(token.toLowerCase()), `recipe 缺少 ${token}`);
  }
});

test("面板对多帧预览按帧序列取图，而不是依赖 sprite 的 sheet.src", () => {
  const library = read("cep/com.dreamengine.panel/js/library.js");
  assert.match(library, /frameSrc/);
  assert.match(library, /replace\("%04d", zeroPad\(index, 4\)\)/);
  assert.match(library, /setInterval/);
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
    console.error(String((error && error.stack) || error));
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
