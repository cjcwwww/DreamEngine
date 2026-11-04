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
    tin: 2, tout: 2,
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
    key(0, [0], { tin: 1, tout: 1, os: [100], is: [100] }),
    key(1, [100], { tin: 1, tout: 1, os: [100], is: [100] })
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
    key(0, [10], { tout: 3 }),
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
    key(0, [0], { tin: 1, tout: 1, os: [50], is: [50] }),
    key(2, [100], { tin: 1, tout: 1 })
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

test("一维速度是带符号的值速度：正 speed 在下降段会过冲", () => {
  // 实机教训：100→30 的段上设 speed=+100 / influence=50，AE 会先冲高到 ~110。
  // 如果按「模长」算基准，符号会被吃掉，曲线反而往下走（偏差 41px）。
  const keys = [
    key(0, [100], { os: [100], oi: [50], is: [100], ii: [50] }),
    key(1, [30], { os: [0], oi: [33.33], is: [0], ii: [33.33] })
  ];
  const seg = C.segmentOf(keys, 0);
  assert.ok(seg.mOut < 0, "下降段的正 speed 应得到负斜率倍率，实际 " + seg.mOut);
  const v = C.sampleValue(seg, 0, 0.25);
  assert.ok(v > 100, "应该向上过冲，实际 " + v);
});

test("多维速度按路径模长解释：各维把手与各自 Δ 成比例", () => {
  const keys = [
    key(0, [100, 900], { os: [400, 400], oi: [60, 60] }),
    key(1, [900, 200], { os: [0, 0], oi: [33.33, 33.33] })
  ];
  const seg = C.segmentOf(keys, 0);
  const chordMag = Math.sqrt(800 * 800 + (-700) * (-700)) / 1;
  assert.ok(Math.abs(seg.chordMag - chordMag) < 1e-6, "模长速度算错");
  assert.ok(Math.abs(seg.mOut - 400 / chordMag) < 1e-6, "m 应按模长归一，实际 " + seg.mOut);
});

test("空间路径按弧长推进，而不是按贝塞尔参数", () => {
  // 实机对照：参数法偏差 70px，弧长法 3.5px。这里造一条明显弯曲的路径，
  // 断言「进度 0.5」取到的点不等于「参数 0.5」的点。
  const keys = [
    // 两端切线长度不等，弧长中点才会与参数中点错开（对称路径两者相等）
    key(0, [0, 0], { os: [0, 0], oi: [33.33, 33.33], ot: [0, 800] }),
    key(1, [1000, 0], { os: [0, 0], oi: [33.33, 33.33], it: [0, 100] })
  ];
  const seg = C.segmentOf(keys, 0);
  assert.equal(seg.spatial, false, "样例没带 sp 标记时应按非空间处理");
  seg.spatial = true; // 手工标记：这个用例就是要测空间分支
  const u = M.uAtProgress ? M.uAtProgress(seg, 0.5) : 0.5;
  const byArc = M.pathPoint(seg, u)[1];
  const byParam = M.pathPoint(seg, 0.5)[1];
  assert.notEqual(byArc.toFixed(3), byParam.toFixed(3), "弧长与参数应该不同");
  const v = C.sampleValue(seg, 1, 0.5);
  assert.ok(Math.abs(v - byArc) < 1e-6, "采样应走弧长映射");
});

test("快照里一维值必须是数组，且带 spatial / ease 长度字段", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  assert.match(code, /function valueArr\(/, "缺少 valueArr");
  assert.match(code, /jfield\("v", jnumArr\(valueArr\(value\)\)\)/, "快照的 v 没有数组化");
  assert.match(code, /jfield\("sp", jbool/, "快照缺少 spatial 标记");
  assert.match(code, /jfield\("ne", String\(/, "快照缺少 ease 数组长度");
});

test("插值枚举按实机值映射（6612 线性 / 6613 贝塞尔 / 6614 定格）", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  assert.match(code, /ENUM_LINEAR = 6612/);
  assert.match(code, /ENUM_BEZIER = 6613/);
  assert.match(code, /ENUM_HOLD = 6614/);
  // 快照与写回都必须过 typeCode，不能把裸枚举塞进模型
  assert.match(code, /jfield\("tin", String\(typeCode\(/);
  assert.match(code, /jfield\("tout", String\(typeCode\(/);
  assert.match(code, /tin: typeCode\(prop\.keyInInterpolationType/);
});

test("多维 ease 只写 1 个元素，空间切线写 3 个元素", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  // AE 2021 实测：多维 ease 数组长度 >1 直接报「值数组没有 1 元素」
  assert.match(code, /return \[makeEase\(/, "buildEase 应只返回 1 个 KeyframeEase");
  assert.doesNotMatch(code, /for \(d = 0; d < dims; d\+\+\) \{\s*out\.push\(makeEase/,
    "buildEase 仍在按维度展开");
  // 空间切线对 2D 属性也要求 3 个元素
  assert.match(code, /var n = dims > 3 \? dims : 3;/, "切线数组没有补到 3");
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

test("面板缓动库是合法的 cubic-bezier，且覆盖常用族", () => {
  const panelSrc = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const block = panelSrc.slice(panelSrc.indexOf("var PRESETS = ["), panelSrc.indexOf("var deps ="));
  const rows = [];
  const parts = block.split("{").slice(1);
  for (const part of parts) {
    const idAt = part.indexOf('id: "');
    const bAt = part.indexOf("b: [");
    if (idAt < 0 || bAt < 0) continue;
    const id = part.slice(idAt + 5, part.indexOf('"', idAt + 5));
    const b = part.slice(bAt + 4, part.indexOf("]", bAt)).split(",").map(Number);
    rows.push({ id, b });
  }
  assert.ok(rows.length >= 12, "预设数量不足：" + rows.length);
  const ids = rows.map((r) => r.id);
  for (const need of ["linear", "ease", "ease-in", "ease-out", "ease-in-out", "cubic-in", "back-out"]) {
    assert.ok(ids.includes(need), "缺少预设 " + need);
  }
  for (const r of rows) {
    assert.equal(r.b.length, 4, r.id + " 不是四元组");
    assert.ok(r.b[0] >= 0 && r.b[0] <= 1, r.id + " 的 x1 越界：" + r.b[0]);
    assert.ok(r.b[2] >= 0 && r.b[2] <= 1, r.id + " 的 x2 越界：" + r.b[2]);
    assert.ok(Math.abs(r.b[1]) <= 3 && Math.abs(r.b[3]) <= 3, r.id + " 的 y 超出可表达范围");
  }
  assert.ok(panelSrc.includes("function bezierToEase("), "缺少 bezierToEase");
  assert.ok(panelSrc.includes("function applyBezier("), "缺少 applyBezier");
});

test("三种图表收进小方块，读数在画布下方", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  assert.ok(html.includes('id="curveModeBtn"'), "缺少模式方块按钮");
  assert.ok(html.includes('id="curveModeMenu"'), "缺少模式菜单");
  assert.ok(html.includes('id="curveReadout"'), "缺少读数");
  for (const id of ["curveModeValue", "curveModeSpeed", "curveModePath"]) {
    assert.ok(html.includes('id="' + id + '"'), "缺少 " + id);
  }
  const toolbar = html.slice(html.indexOf('class="curve-toolbar"'), html.indexOf('class="curve-stage"'));
  assert.ok(toolbar.indexOf('class="segmented"') < 0, "工具栏里还留着并排按钮");
  const css = read("cep/com.dreamengine.panel/css/style.css");
  assert.ok(css.includes(".mode-menu[hidden]"), "缺少 .mode-menu[hidden]");
  assert.ok(css.includes(".curve-readout"), "缺少 .curve-readout");
});

test("值图是「两端各一条把手线」，且只作用于选中的段", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  for (const fn of ["segmentHandlePixels", "segmentBezier", "targetSegments"]) {
    assert.ok(code.includes("function " + fn + "("), "缺少 " + fn);
  }
  const apply = code.slice(code.indexOf("function applyBezier("), code.indexOf("function send("));
  assert.ok(apply.includes('["out", p.loc, String(s)'), "写回缺少 out 侧");
  assert.ok(apply.includes('["in", p.loc, String(s + 1)'), "写回缺少 in 侧");
  assert.ok(code.includes('indexOf(segs, dragSeg) < 0) segs = [dragSeg]'),
    "拖拽没有把范围收敛到单段");
});

test("拖拽过程中不过桥，松手才写", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const drag = code.slice(code.indexOf("function applyDrag("), code.indexOf("function writeLocal("));
  assert.ok(drag.length > 100, "没找到 applyDrag");
  assert.doesNotMatch(drag, /send\(/, "拖拽过程中调用了写回（每个 mousemove 一次 evalScript）");
  const up = code.slice(code.indexOf("function onMouseUp("), code.indexOf("function applyBezier("));
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
