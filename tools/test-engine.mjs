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

test("配方覆盖常用内置效果，每条都带参数名与值", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipes = ctx.AEV_Recipe.recipes;
  const keys = Object.keys(recipes);
  assert.ok(keys.length >= 45, `配方数量应 ≥ 45，实际 ${keys.length}`);
  for (const key of keys) {
    const steps = recipes[key];
    assert.ok(Array.isArray(steps) && steps.length > 0, `${key} 配方为空`);
    for (const step of steps) {
      assert.ok(step.names && step.names.length >= 1, `${key} 缺参数名`);
      assert.notEqual(step.value, undefined, `${key} 缺参数值`);
      for (const name of step.names) {
        assert.equal(typeof name, "string");
        assert.ok(name.length > 0, `${key} 有空白参数名`);
      }
    }
  }

  // 参数名必须与本机真实名字一致：
  //   ADBE 内置效果在中文界面下返回中文，CC 系列是第三方插件风格、始终返回英文。
  assert.ok(recipes["ADBE Gaussian Blur 2"][0].names.includes("模糊度"));
  assert.ok(recipes["CC Radial Blur"][0].names.includes("Amount"));
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

test("两层输入类效果单独识别，不能落到 footage-2d", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipe = ctx.AEV_Recipe;
  // 这些效果在单层合成里「加上了但画面不变」，必须补第二图层
  for (const matchName of [
    "ADBE Displacement Map",
    "ADBE Compound Blur",
    "ADBE Set Matte3",
    "ADBE Calculations",
    "CC Composite",
    "CC Vector Blur",
    "ADBE Gradient Wipe",
  ]) {
    assert.equal(recipe.sceneFor(matchName), "two-layer-input", `${matchName} 应判为两层输入`);
  }
  // 只生成部分内容、留白要露出下层画面的
  for (const matchName of ["ADBE Fill", "ADBE Ramp", "ADBE 4ColorGradient", "ADBE Scribble Fill"]) {
    assert.equal(recipe.sceneFor(matchName), "adjustment", `${matchName} 应判为调整层`);
  }
});

test("场景布局描述准确：两层输入要背景+图案，调整层只要背景", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipe = ctx.AEV_Recipe;

  const two = recipe.layoutFor("two-layer-input");
  assert.equal(two.needBg, true);
  assert.equal(two.needSource, true);
  assert.equal(two.base, "photo");

  const adj = recipe.layoutFor("adjustment");
  assert.equal(adj.needBg, true);
  assert.equal(adj.needSource, false);

  const plain = recipe.layoutFor("footage-2d");
  assert.equal(plain.needBg, false);
  assert.equal(plain.needSource, false);

  // 未知场景必须退化成最保守的单层布局，不能返回 undefined
  const unknown = recipe.layoutFor("no-such-scene");
  assert.equal(unknown.base, "photo");
  assert.equal(unknown.needBg, false);
});

test("bindLayers 只碰图层选择器，不动其它参数", () => {
  const types = { LAYER_INDEX: 6413, OneD: 6410, COLOR: 6411, CHECKBOX: 6416, TWO_D: 6412 };
  const ctx = loadModules([`${ENGINE}/recipe.jsx`], { PropertyValueType: types });
  const recipe = ctx.AEV_Recipe;

  const touched = [];
  function prop(name, type) {
    return {
      name,
      propertyValueType: type,
      numProperties: 0,
      setValue: (v) => touched.push(name + "=" + v),
    };
  }
  const group = {
    numProperties: 2,
    property: (i) =>
      [
        prop("置换图层", types.LAYER_INDEX),
        prop("最大水平置换", types.OneD),
      ][i - 1],
  };

  const bound = recipe.bindLayers(group, 2);
  assert.equal(bound, 1, "只应绑定 1 个图层选择器");
  assert.deepEqual(touched, ["置换图层=2"]);
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
  const a = recipe.cacheKey("ADBE Glo2", "photo-v3", 256, 6);
  const b = recipe.cacheKey("ADBE Glo2", "photo-v3", 256, 6);
  const c = recipe.cacheKey("ADBE Glo2", "photo-v3", 256, 12);
  const d = recipe.cacheKey("ADBE Glo2", "photo-v4", 256, 6);
  assert.equal(a, b, "同输入必须同指纹");
  assert.notEqual(a, c, "帧数变化要换指纹");
  assert.notEqual(a, d, "素材版本变化要换指纹");
  assert.match(a, /^[0-9a-z]+$/);
});

/** 只读文件系统的 mock，用于在 node 里跑 previewgen.staleList */
function makeReadFs(text) {
  class FileMock {
    constructor(p) {
      this.path = p;
      this.exists = true;
      this.encoding = "";
      this._lines = text.split(/\r?\n/);
      this._cursor = 0;
    }
    get fsName() {
      return this.path;
    }
    open() {
      return true;
    }
    get eof() {
      return this._cursor >= this._lines.length;
    }
    readln() {
      const line = this._lines[this._cursor];
      this._cursor++;
      return line;
    }
    close() {}
  }
  return FileMock;
}

test("staleList 用指纹判定过期，无指纹的旧条目视为有效", () => {
  const header = "matchName\tsheet\tcell\tframes\tframeTemplate\tkey";
  // 先算出一条「当前配方下仍然有效」的真指纹
  const seed = loadModules([
    `${ENGINE}/render_config.jsx`,
    `${ENGINE}/recipe.jsx`,
    `${ENGINE}/previewgen.jsx`,
  ]);
  const cellSize = seed.AEV_PreviewGen.config().contactSheet.cellSize;
  const goodKey = seed.AEV_PreviewGen.itemKey("CC Lens", cellSize, 6);
  assert.ok(goodKey && goodKey.length > 0, "指纹不应为空");

  const tsv = [
    header,
    `CC Lens\t1\t0\t6\tthumbs/batch_001_%04d.png\t${goodKey}`,
    "ADBE Glo2\t1\t1\t6\tthumbs/batch_001_%04d.png\tdeadbeef",
    "ADBE Twirl\t1\t2\t6\tthumbs/batch_001_%04d.png\t",
  ].join("\n");

  const ctx = loadModules(
    [`${ENGINE}/render_config.jsx`, `${ENGINE}/recipe.jsx`, `${ENGINE}/previewgen.jsx`],
    { File: makeReadFs(tsv) },
  );
  const report = JSON.parse(ctx.AEV_PreviewGen.staleList("X:/ext"));
  assert.equal(report.checked, 3);
  assert.deepEqual(report.stale, ["ADBE Glo2"], "只应把指纹对不上的那条判为过期");
});

test("writeManifest 同步写 previews.tsv，供 AE 侧校验缓存", () => {
  const code = stripComments(read(`${ENGINE}/previewgen.jsx`));
  // ExtendScript 没有 JSON.parse，校验只能在 AE 侧读 TSV 做
  assert.match(code, /data\/previews\.tsv/);
  assert.match(code, /indexRows/);
  assert.match(code, /function itemKey/);
  assert.match(code, /function staleList/);
});

test("L1 包里的 manifest 与 previews.tsv 条目一致，且都带指纹", () => {
  const manifest = JSON.parse(read("dist/L1/manifest.json"));
  const lines = read("dist/L1/previews.tsv").trim().split(/\r?\n/);
  const header = lines.shift().split("\t");
  assert.deepEqual(header, [
    "matchName",
    "sheet",
    "cell",
    "frames",
    "frameTemplate",
    "key",
  ]);
  assert.equal(lines.length, manifest.items.length, "两份索引的条目数必须一致");

  const byName = new Map(manifest.items.map((item) => [item.matchName, item]));
  let renderFrameKept = 0;
  for (const item of manifest.items) {
    assert.ok(item.key && item.key.length > 0, `${item.matchName} 缺指纹`);
  }
  for (const line of lines) {
    const cells = line.split("\t");
    const item = byName.get(cells[0]);
    assert.ok(item, `previews.tsv 里的 ${cells[0]} 不在 manifest 中`);
    assert.ok(cells[5] && cells[5].length > 0, `${cells[0]} 在 previews.tsv 里缺指纹`);
    assert.equal(cells[5], item.key, `${cells[0]} 两份索引的指纹必须一致`);

    // frames 列是**渲染帧数**，manifest 的 frames 是存储帧数。
    // 打包把静态格子从 6 帧压成 1 帧后，渲染帧数必须保留下来——
    // 否则 staleList 会拿 1 帧去比对按 6 帧算的指纹，把有效预览全判成过期。
    const renderFrames = Number(cells[3]);
    const storedFrames = item.frames || 1;
    assert.ok(renderFrames >= storedFrames, `${cells[0]} 渲染帧数不应小于存储帧数`);
    if (renderFrames > 1) renderFrameKept++;
  }
  assert.ok(renderFrameKept > 0, "previews.tsv 里应当记着渲染帧数（多帧渲染的条目）");
});

/* ---------- assets / catalog 静态契约 ---------- */

test("assets 按类型生成五套素材并复用缓存", () => {
  const code = stripComments(read(`${ENGINE}/assets.jsx`));
  assert.match(code, /var VERSION = "photo-v3";/);
  assert.match(code, /function buildPhoto/);
  assert.match(code, /function buildText/);
  assert.match(code, /function buildSolid/);
  assert.match(code, /function buildShape/);
  // 两层输入类效果需要高对比图案当第二输入
  assert.match(code, /function buildPattern/);
  assert.match(code, /resolvedKind === "pattern"/);
  assert.match(code, /cache\[key\(kind, size\)\] = \{ item: comp \};/);
});

test("两层输入场景会真的搭出两层：图案层 + 效果层", () => {
  const code = stripComments(read(`${ENGINE}/previewgen.jsx`));
  // 顺序必须是「背景 → 图案 → 效果层」，AE 里后加的在上面，
  // 于是效果层在第 1 层、图案层在第 2 层，图层选择器绑 2 才有意义。
  assert.match(code, /layout = AEV_Recipe\.layoutFor\(AEV_Recipe\.sceneFor\(matchName\)\)/);
  assert.match(code, /if \(layout\.needBg\) \{/);
  assert.match(code, /if \(layout\.needSource\) \{/);
  assert.match(code, /cell\.layers\.add\(sceneOf\("pattern"\)\)/);
  assert.match(code, /AEV_Recipe\.bindLayers\(effectGroup, 2\)/);
  // 背景层必须是纯色：遮罩吃掉上层时露出的颜色要和上层明显不同
  assert.match(code, /cell\.layers\.add\(sceneOf\("solid"\)\)/);
  // 第二输入层要隐藏，否则会盖住效果结果
  assert.match(code, /sourceLayer\.enabled = false;/);
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

test("queue 能重新打开过期条目，且与失败重试区分开", () => {
  const source = read(`${ENGINE}/queue.jsx`);
  // 过期 ≠ 失败：配方改了不是渲染出错，重开时 attempts 要归零、不记 reason 为错误
  assert.match(source, /function reopen/);
  assert.match(source, /setStatus\(queue, name, "pending", "stale"\)/);
  assert.match(source, /reopen: reopen,/);
  // 仍然保留 retryFailed 的语义
  assert.match(source, /function retryFailed/);
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
  // CC Hair 是毛发模拟：打上关键帧后每帧都要重算，AE 直接挂死
  assert.equal(view.isPoorPreviewTarget({ matchName: "CC Hair", category: "模拟" }), true);
  // 文本生成器在 addProperty 时弹模态对话框，会卡死批量渲染
  assert.equal(view.isPoorPreviewTarget({ matchName: "ADBE Numbers2", category: "文本" }), true);
  assert.equal(view.isPoorPreviewTarget({ matchName: "ADBE Timecode", category: "文本" }), true);
  // Apply Color LUT2 渲染时弹「选择 LUT 文件」对话框，整批卡死
  assert.equal(view.isPoorPreviewTarget({ matchName: "ADBE Apply Color LUT2", category: "颜色校正" }), true);
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

test("面板把过期预览排进生成队列，而不是当成已缓存", () => {
  const library = read("cep/com.dreamengine.panel/js/library.js");
  assert.match(library, /AEV_PreviewGen\.staleList/);
  assert.match(library, /AEV_Queue\.reopen/);
  // 候选过滤：有图但过期 → 仍然算候选
  assert.match(library, /state\.previews\[effect\.matchName\] && !state\.stale\[effect\.matchName\]/);
  // 已有且不过期的才标 cached
  assert.match(library, /if \(state\.stale\[key\]\) staleNames\.push\(key\);/);
});

test("viewmodel 给过期条目打标记，图仍然照常显示", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const effect = { matchName: "ADBE Glo2", displayName: "Glow", category: "风格化" };
  const preview = { matchName: "ADBE Glo2", src: "thumbs/batch_000.png", x: 0, y: 0 };
  const stale = { "ADBE Glo2": true };

  const item = view.buildItem(effect, {}, { "ADBE Glo2": preview }, stale);
  assert.equal(item.hasPreview, true, "过期也要继续显示旧图");
  assert.equal(item.stale, true);

  const fresh = view.buildItem(effect, {}, { "ADBE Glo2": preview }, {});
  assert.equal(fresh.stale, false);

  // 没有预览时谈不上过期
  const missing = view.buildItem(effect, {}, {}, stale);
  assert.equal(missing.hasPreview, false);
  assert.equal(missing.stale, false);
});

test("排序：按名称首字母（中文按拼音）", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const items = [
    { matchName: "X1", nameEn: "Zeta", nameZh: "斑马纹", category: "风格化" },
    { matchName: "X2", nameEn: "Alpha", nameZh: "爱丽丝", category: "风格化" },
    { matchName: "X3", nameEn: "Mango", nameZh: "芒果", category: "风格化" },
  ];
  const byEn = Array.from(view.sortItems(items, "name", "en"), (i) => i.matchName);
  assert.deepEqual(byEn, ["X2", "X3", "X1"], "英文按字母序");

  // 中文按拼音：爱丽丝(ai) < 斑马纹(ban) < 芒果(mang)
  const byZh = Array.from(view.sortItems(items, "name", "zh"), (i) => i.matchName);
  assert.deepEqual(byZh, ["X2", "X1", "X3"], "中文按拼音序");
});

test("排序：按分类时同分类排在一起，类内按名称", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const items = [
    { matchName: "A", nameEn: "Zed", nameZh: "泽德", category: "扭曲" },
    { matchName: "B", nameEn: "Abe", nameZh: "艾比", category: "颜色校正" },
    { matchName: "C", nameEn: "Mid", nameZh: "米德", category: "扭曲" },
  ];
  const out = Array.from(view.sortItems(items, "category", "zh"), (i) => i.matchName);
  assert.equal(out.length, 3);
  // 同分类的两条必须相邻（分类名排序：扭 n < 颜 y，所以扭曲在前）
  const categories = out.map((key) => (key === "B" ? "颜色校正" : "扭曲"));
  assert.equal(categories[0], "扭曲");
  assert.equal(categories[1], "扭曲", "同分类必须相邻");
  assert.equal(categories[2], "颜色校正");
  // 类内按名称：艾比(ai) < 泽德(zé) < 米德(mǐ) → 扭曲类内应是 B? 不，是 米德 与 泽德
  const twisted = out.filter((key) => key !== "B").map((key) => (key === "A" ? "泽德" : "米德"));
  assert.deepEqual(twisted, ["米德", "泽德"], "类内按名称排序");
});

test("分类键用 AE 原始分类名，显示名走名字表映射", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const item = {
    matchName: "ADBE Glo2",
    nameEn: "Glow",
    nameZh: "发光",
    category: "风格化",
    categoryZh: "风格化",
    categoryEn: "Stylize",
  };
  // 键取原始分类（切语言不变），显示名取本地化
  assert.equal(view.categoryKey(item), "风格化");
  assert.equal(view.categoryLabel(item, "en"), "Stylize");
  assert.equal(view.categoryLabel(item, "zh"), "风格化");

  // 没有分类的归到「未分类」
  assert.equal(view.categoryKey({ matchName: "X" }), "未分类");
});

test("分类顺序取自 catalog 首次出现顺序", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const order = Array.from(view.categoryOrder([
    { matchName: "A", category: "模糊和锐化" },
    { matchName: "B", category: "颜色校正" },
    { matchName: "C", category: "模糊和锐化" },
    { matchName: "D", category: "扭曲" },
  ]));
  assert.deepEqual(order, ["模糊和锐化", "颜色校正", "扭曲"]);
});

test("分类计数用于侧栏", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const stats = view.categoryCounts(
    [
      { matchName: "A", category: "模糊和锐化" },
      { matchName: "B", category: "模糊和锐化" },
      { matchName: "C", category: "扭曲" },
    ],
    "zh",
  );
  assert.equal(stats.counts["模糊和锐化"], 2);
  assert.equal(stats.counts["扭曲"], 1);
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
