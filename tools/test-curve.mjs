#!/usr/bin/env node
/* ============================================================
 * test-curve.mjs —— M4 曲线编辑的回归
 *
 * 两类断言：
 *   1. 数学：用真实数值验证换算恒等式（线性/缓动/极值/往返/路径）
 *   2. 契约：把「踩过的坑」固化成源码断言
 *      · 写回必须包 undo 组（且成对）
 *      · 写之前必须关掉自动贝塞尔（否则 AE 重算把手，白写）
 *      · 绝不写 comp.selectedLayers（AE 2021 会崩）
 *      · 拖拽过程中不许过桥，松手才写（否则每个 mousemove 一次 evalScript）
 *      · 面板与引擎的预设 id 必须一一对应
 *
 * 用法：node tools/test-curve.mjs
 * ============================================================ */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");
const ENGINE = "cep/com.dreamengine.panel/engine";

function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}

/** 按 AE 侧的顺序加载：先纯数学，再读写层 */
function loadEngine() {
  const context = vm.createContext({});
  vm.runInContext(read(`${ENGINE}/curve_math.js`), context, { filename: "curve_math.js" });
  vm.runInContext(read(`${ENGINE}/curvelib.jsx`), context, { filename: "curvelib.jsx" });
  return { C: context.AEV_Curve, M: context.AEV_CurveMath, context };
}

const { C, M } = loadEngine();

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const EPS = 1e-6;

function key(t, v, extra) {
  const dims = v.length;
  const fill = (n) => v.map(() => n);
  return Object.assign({
    t, v,
    in: 2, out: 2,
    os: fill(0), oi: fill(33.33),
    is: fill(0), ii: fill(33.33),
    ot: fill(0), it: fill(0)
  }, extra || {});
}

/* ============================================================
 * 一、数学恒等式
 * ============================================================ */

test("线性段：采样值等于等分插值", () => {
  const keys = [
    key(0, [0], { in: 1, out: 1, os: [100], is: [100] }),
    key(1, [100], { in: 1, out: 1, os: [100], is: [100] })
  ];
  const seg = C.segmentOf(keys, 0);
  for (const [t, expect] of [[0, 0], [0.25, 25], [0.5, 50], [0.75, 75], [1, 100]]) {
    assert.ok(Math.abs(C.sampleValue(seg, 0, t) - expect) < 1e-6, `t=${t}`);
  }
});

test("缓动段（speed 0 / influence 33.33）：端点准确、中点 50、单调", () => {
  const keys = [key(0, [0]), key(1, [100])];
  const seg = C.segmentOf(keys, 0);
  assert.ok(Math.abs(C.sampleValue(seg, 0, 0)) < EPS);
  assert.ok(Math.abs(C.sampleValue(seg, 0, 1) - 100) < EPS);
  assert.ok(Math.abs(C.sampleValue(seg, 0, 0.5) - 50) < 1e-4);
  let prev = -1;
  for (let i = 0; i <= 40; i++) {
    const v = C.sampleValue(seg, 0, i / 40);
    assert.ok(v >= prev - 1e-9, `非单调于 i=${i}`);
    prev = v;
  }
});

test("缓动曲线对称：v(0.25) + v(0.75) = 100", () => {
  const seg = C.segmentOf([key(0, [0]), key(1, [100])], 0);
  const a = C.sampleValue(seg, 0, 0.25);
  const b = C.sampleValue(seg, 0, 1 - 0.25);
  assert.ok(Math.abs(a + b - 100) < 1e-4, `${a} + ${b}`);
  // 缓入缓出的标志：25% 处明显慢于线性（< 25）
  assert.ok(a < 25, "25% 处的值应低于线性的 25");
});

test("influence=100：把手铺满区间，中点仍是 50", () => {
  const keys = [
    key(0, [0], { oi: [100] }),
    key(1, [100], { ii: [100] })
  ];
  const seg = C.segmentOf(keys, 0);
  assert.ok(Math.abs(C.sampleValue(seg, 0, 0.5) - 50) < 1e-4);
  // 端点斜率为 0
  assert.ok(Math.abs(C.speedAt(seg, 0, 1e-6)) < 1e-2);
});

test("定格插值：区间内值恒为起点值", () => {
  const keys = [
    key(0, [10], { out: 3 }),
    key(1, [90])
  ];
  const seg = C.segmentOf(keys, 0);
  assert.equal(C.sampleValue(seg, 0, 0.3), 10);
  assert.equal(C.sampleValue(seg, 0, 0.99), 10);
});

test("solveU 反解：bezier(x(u)) = 目标 x", () => {
  const p0 = 0, p1 = 0.2, p2 = 0.85, p3 = 1;
  for (const x of [0, 0.1, 0.33, 0.5, 0.77, 1]) {
    const u = C.solveU(p0, p1, p2, p3, x);
    assert.ok(Math.abs(M.bezier1(p0, p1, p2, p3, u) - x) < 1e-6, `x=${x}`);
  }
});

test("把手 → ease 往返：把把手放回原位能还原 influence 与斜率", () => {
  const keys = [key(0, [0], { oi: [40] }), key(1, [100], { ii: [60] })];
  const seg = C.segmentOf(keys, 0);
  const h = M.handles(seg, 0);
  const out = C.easeFromHandle(seg, "out", 0, h.p1.x, h.p1.y);
  assert.ok(Math.abs(out.inf - 40) < 1e-3, `inf=${out.inf}`);
  assert.ok(Math.abs(out.m - seg.mOut) < 1e-6, `m=${out.m}`);
  const inn = C.easeFromHandle(seg, "in", 0, h.p2.x, h.p2.y);
  assert.ok(Math.abs(inn.inf - 60) < 1e-3, `infIn=${inn.inf}`);
});

test("influence 钳位：拖到区间外不会产生非单调曲线", () => {
  const seg = C.segmentOf([key(0, [0]), key(1, [100])], 0);
  const far = C.easeFromHandle(seg, "out", 0, seg.tB + 5, 0);
  assert.equal(far.inf, M.MAX_INFLUENCE);
  const near = C.easeFromHandle(seg, "out", 0, seg.tA - 5, 0);
  assert.equal(near.inf, M.MIN_INFLUENCE);
});

test("线性段的速度恒等于弦斜率", () => {
  const seg = C.segmentOf([
    key(0, [0], { in: 1, out: 1, os: [50], is: [50] }),
    key(2, [100], { in: 1, out: 1 })
  ], 0);
  for (const t of [0.1, 0.5, 1.9]) {
    assert.ok(Math.abs(C.speedAt(seg, 0, t) - 50) < 1e-6);
  }
});

test("多维：m 由主导维（弦斜率最大者）决定，各维同一条缓动", () => {
  const keys = [
    key(0, [0, 0], { os: [0, 0], is: [0, 0] }),
    key(2, [200, -50], { os: [0, 0], is: [0, 0] })
  ];
  const seg = C.segmentOf(keys, 0);
  assert.equal(seg.dominant, 0, "X 维弦斜率（100/s）大于 Y 维（-25/s），应为主导维");
  assert.equal(seg.mOut, 0);
  // X/Y 在 50% 处应同为各自的 50%
  assert.ok(Math.abs(C.sampleValue(seg, 0, 1) - 100) < 1e-4);
  assert.ok(Math.abs(C.sampleValue(seg, 1, 1) + 25) < 1e-4);
});

test("空间路径：切线为零是直线，给切线则弯曲", () => {
  const straight = C.segmentOf([
    key(0, [0, 0]), key(1, [100, 0])
  ], 0);
  const midStraight = C.pathPoint(straight, 0.5);
  assert.ok(Math.abs(midStraight[0] - 50) < 1e-6);
  assert.ok(Math.abs(midStraight[1]) < 1e-6);

  const curved = C.segmentOf([
    key(0, [0, 0], { ot: [0, 100] }),
    key(1, [100, 0], { it: [0, 100] })
  ], 0);
  const midCurved = C.pathPoint(curved, 0.5);
  // 两端切线都朝 +Y，中间必然鼓起来
  assert.ok(midCurved[1] > 50, `midY=${midCurved[1]}`);
});

test("路径与时间互不串数据：改 ease 不改路径形状", () => {
  const keys = [
    key(0, [0, 0], { ot: [0, 80] }),
    key(1, [100, 0], { it: [0, 80] })
  ];
  const a = C.segmentOf(keys, 0);
  const before = C.pathPoint(a, 0.5);
  keys[0].oi = [90];
  keys[1].ii = [90];
  const b = C.segmentOf(keys, 0);
  const after = C.pathPoint(b, 0.5);
  assert.ok(Math.abs(before[1] - after[1]) < 1e-9, "路径形状不该被 ease 影响");
});

/* ============================================================
 * 二、引擎源码契约
 * ============================================================ */

test("写回必须包在 beginUndoGroup / endUndoGroup 里", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  assert.match(code, /app\.beginUndoGroup\(/);
  assert.match(code, /app\.endUndoGroup\(\)/);
  // 一次拖拽 = 一次撤销：整批写在同一组内
  const start = code.indexOf("function applyText(");
  const end = code.indexOf("return {", start);
  const body = code.slice(start, end);
  assert.match(body, /beginUndoGroup/);
  assert.match(body, /applyTextRaw/);
  assert.match(body, /endUndoGroup/);
});

test("写 ease 前先关掉自动贝塞尔（否则 AE 会重算把手）", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  const writer = code.slice(code.indexOf("function writeSide("), code.indexOf("function writeLinear("));
  assert.match(writer, /setTemporalAutoBezierAtKey\(aeIndex, false\)/);
  assert.match(writer, /setTemporalEaseAtKey\(aeIndex/);
  // 线性/定格关键帧不吃 ease，必须先改插值类型
  assert.match(writer, /setInterpolationTypeAtKey/);
});

test("roving 关键帧跳过写 ease（时间由 AE 排布）", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  assert.match(code, /keyRoving/);
  assert.match(code, /return "roving"/);
});

test("绝不写 comp.selectedLayers；不用会崩的 API", () => {
  for (const file of [`${ENGINE}/curvelib.jsx`, "cep/com.dreamengine.panel/js/curve.js"]) {
    const code = codeOf(read(file));
    assert.doesNotMatch(code, /selectedLayers\s*=/, `${file} 给 selectedLayers 赋值了`);
    assert.doesNotMatch(code, /getItemByName/, `${file} 用了 getItemByName`);
    assert.doesNotMatch(code, /app\.applyPreset/, `${file} 用了 app.applyPreset`);
  }
});

test("乐观并发：expect 指纹不匹配时不写，返回 conflict", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  assert.match(code, /kind === "expect"/);
  assert.match(code, /jfield\("status", jstr\("conflict"\)\)/);
  // 冲突检查必须在写循环之前
  const checkAt = code.indexOf('jstr("conflict")');
  const writeAt = code.indexOf("var applied = 0;");
  assert.ok(checkAt > 0 && checkAt < writeAt, "冲突检查必须早于任何写入");
  // force 由面板显式下发（用户点「覆盖」）
  assert.match(code, /kind === "force"/);
});

test("快照字段齐全：面板画图需要的东西一个不少", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  for (const field of ["loc", "name", "matchName", "vt", "dims", "spatial", "sep", "n", "sig", "keys"]) {
    assert.match(code, new RegExp(`jfield\\("${field}"`), `快照缺少 ${field}`);
  }
  for (const field of ["os", "oi", "is", "ii", "ot", "it", "ab", "co", "rv"]) {
    assert.match(code, new RegExp(`jfield\\("${field}"`), `关键帧缺少 ${field}`);
  }
});

test("引擎拆分：curvelib 依赖 curve_math，缺了要明确报错", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  assert.match(code, /typeof AEV_CurveMath === "undefined"/);
  assert.match(code, /需要先加载 engine\/curve_math\.js/);

  // 真跑一次：不给数学模块，必须抛错而不是静默产出半个模块
  const context = vm.createContext({});
  assert.throws(() => {
    vm.runInContext(read(`${ENGINE}/curvelib.jsx`), context, { filename: "curvelib.jsx" });
  }, /curve_math/);
});

test("面板与引擎的缓动预设 id 严格一致", () => {
  const engineSrc = codeOf(read(`${ENGINE}/curvelib.jsx`));
  const panelSrc = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const engineIds = [...engineSrc.matchAll(/id:\s*"([a-z-]+)"/g)].map((m) => m[1]);
  const block = panelSrc.slice(panelSrc.indexOf("var PRESETS = ["), panelSrc.indexOf("var deps ="));
  const panelIds = [...block.matchAll(/id:\s*"([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(panelIds.sort(), engineIds.sort(),
    `面板 ${panelIds} vs 引擎 ${engineIds}`);
  // 面板的每个 id 都要被引擎认到
  for (const id of panelIds) assert.match(engineSrc, new RegExp(`id: "${id}"`));
});

/* ============================================================
 * 三、面板源码契约
 * ============================================================ */

test("拖拽过程中不过桥，松手才写", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const drag = code.slice(code.indexOf("function applyDrag("), code.indexOf("function writeLocal("));
  assert.ok(drag.length > 100, "没找到 applyDrag");
  assert.doesNotMatch(drag, /send\(/, "拖拽过程中调用了写回（每个 mousemove 一次 evalScript）");
  const up = code.slice(code.indexOf("function onMouseUp("), code.indexOf("function numText("));
  assert.match(up, /send\(/, "松手必须写回");
});

test("Shift 拖动只改缓动幅度（斜率保持拖拽前）", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  assert.match(code, /m0:/);
  assert.match(code, /if \(drag\.shift\) m = drag\.m0/);
});

test("Esc 取消拖拽不写回 AE", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const keydown = code.slice(code.indexOf('document.addEventListener("keydown"'), code.indexOf('byId("curveConflictOverwrite")'));
  assert.match(keydown, /st\.backup/);
  assert.match(keydown, /已取消这次拖拽/);
  assert.doesNotMatch(keydown, /send\(/, "Esc 不应该写回 AE");
});

test("并发冲突对话框有三个选项：覆盖 / 重新载入 / 放弃", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  assert.match(code, /curveConflictOverwrite/);
  assert.match(code, /curveConflictReload/);
  assert.match(code, /curveConflictDrop/);
  // 覆盖时必须去掉 expect 行并加 force，否则会再次冲突
  assert.match(code, /"force\\n"/);
  assert.match(code, /indexOf\("expect\\t"\) !== 0/);
});

test("路径图等比缩放（否则切线方向是假的）", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  assert.match(code, /function equalizeAspect\(/);
  assert.match(code, /st\.mode === "path"\) range = equalizeAspect/);
});

test("三视图切换：表驱动 + 曲线视图每次进入重读", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/library.js"));
  assert.match(code, /var VIEW_TABS = \{ effects: "tabEffects", presets: "tabPresets", curve: "tabCurve" \}/);
  assert.match(code, /var VIEW_PANELS = \{ effects: "viewEffects", presets: "viewPresets", curve: "viewCurve" \}/);
  assert.match(code, /AEV_CurveUI\.enter\(\)/);
  assert.match(code, /byId\("tabCurve"\)\.addEventListener/);
});

test("index.html：第三个视图与冲突按钮齐全，且与预设视图同级", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  assert.match(html, /id="tabCurve"/);
  assert.match(html, /id="viewCurve"[^>]*hidden/);
  assert.match(html, /id="curveCanvas"/);
  // 曲线视图必须是 viewPresets 之后的兄弟节点，不能塞在预设视图里
  const presetsEnd = html.indexOf('id="viewCurve"');
  assert.ok(presetsEnd > 0);
  assert.ok(html.indexOf('id="viewPresets"') < presetsEnd);
  for (const id of ["curveConflictOverwrite", "curveConflictReload", "curveConflictDrop"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // 数学脚本必须在 curve.js 之前
  assert.ok(html.indexOf('src="engine/curve_math.js"') < html.indexOf('src="js/curve.js"'));

  // 三个视图必须在**同一个**顶部切换栏里（效果预览 / 预设预览 / 曲线编辑），
  // 不能把曲线做成抽屉或二级入口 —— 合并分支时最容易被拆散的一条。
  const navStart = html.indexOf('<nav class="view-switch"');
  const navEnd = html.indexOf("</nav>", navStart);
  assert.ok(navStart > 0 && navEnd > navStart, "缺少顶部切换栏");
  const nav = html.slice(navStart, navEnd);
  for (const id of ["tabEffects", "tabPresets", "tabCurve"]) {
    assert.match(nav, new RegExp(`id="${id}"`), id + " 不在切换栏里");
  }
  assert.equal((html.match(/class="view-switch"/g) || []).length, 1, "切换栏只能有一个");
  assert.ok(nav.indexOf("tabEffects") < nav.indexOf("tabPresets"), "顺序应为 效果 → 预设");
  assert.ok(nav.indexOf("tabPresets") < nav.indexOf("tabCurve"), "顺序应为 预设 → 曲线");
});

test("CSS：视图与对话框的 [hidden] 都要显式覆盖", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  assert.match(css, /\.curve-view\[hidden\]\s*\{\s*display: none/);
  assert.match(css, /\.curve-conflict\[hidden\]\s*\{\s*display: none/);
  assert.match(css, /\.curve-hint\s*\{[^}]*text-overflow: ellipsis/);
});

test("bridge 先加载 curve_math 再加载 curvelib，并纳入自愈检查", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/bridge.js"));
  const mathAt = code.indexOf("engine/curve_math.js");
  const curveAt = code.indexOf("engine/curvelib.jsx");
  assert.ok(mathAt > 0 && curveAt > mathAt, "curve_math 必须排在 curvelib 之前");
  assert.match(code, /typeof AEV_Curve === 'undefined'/);
});

test("es3check 覆盖 curve_math.js（后缀是 .js 但跑在 ExtendScript 里）", () => {
  const tool = read("tools/es3check.mjs");
  assert.match(tool, /curve_math\.js/);
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
    console.error(String(error && error.stack ? error.stack : error));
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
