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

test("空间多维：速度按路径模长解释", () => {
  const keys = [
    key(0, [100, 900], { os: [400, 400], oi: [60, 60], sp: true }),
    key(1, [900, 200], { os: [0, 0], oi: [33.33, 33.33], sp: true })
  ];
  const seg = C.segmentOf(keys, 0);
  const chordMag = Math.sqrt(800 * 800 + (-700) * (-700)) / 1;
  assert.ok(Math.abs(seg.chordMag - chordMag) < 1e-6, "模长速度算错");
  assert.ok(Math.abs(seg.mOut - 400 / chordMag) < 1e-6, "m 应按模长归一，实际 " + seg.mOut);
});

test("非空间多维（缩放）按主导维的弦解释，不是模长", () => {
  // 实机矩阵：缩放是 [x,y,z]，AE 要求 ease 数组长度 3；各维有自己的 speed，
  // 所以基准只能是某一维的弦，不能是模长（否则读出来的 m 与写回去的对不上）。
  const keys = [
    key(0, [100, 900], { os: [400, 400], oi: [60, 60] }),
    key(1, [900, 200], { os: [0, 0], oi: [33.33, 33.33] })
  ];
  const seg = C.segmentOf(keys, 0);
  assert.equal(seg.spatial, false, "样例不该被当成空间属性");
  // 主导维是 x（800/1 > 700/1）
  assert.equal(seg.dominant, 0, "主导维应为 x");
  assert.ok(Math.abs(seg.mOut - 400 / 800) < 1e-6, "非空间多维应按主导维弦归一，实际 " + seg.mOut);
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

test("只收数值属性：路径/文本吃不进 ease，不能进快照", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  assert.ok(code.includes("function isNumericValue("), "缺少 isNumericValue");
  assert.ok(code.includes("if (typeof v === \"number\") return true;"), "没把裸数字算数值");
  assert.ok(code.includes("if (!isNumericValue(prop)) {"), "push 没有过滤非数值属性");
  // 过滤要计数，面板才能区分「没选中」与「选中的不支持缓动」
  assert.ok(code.includes("filtered++;"), "没有统计被过滤的属性");
  assert.ok(code.includes('jfield("filtered", String(lastFiltered))'), "快照没带 filtered");
});

test("选中的属性不支持缓动时，不再退回「遍历整层」", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  // fallback 的判据必须是「有没有选中」，不是「收上来几条」
  assert.ok(code.includes("var hadSelection = false;"), "缺少 hadSelection");
  assert.ok(code.includes("if (sp && sp.length > 0) {"), "没按选中数量判断");
  assert.ok(!/if \(!list\.length\) \{\s*var layers/.test(code),
    "还在用「list 为空」当 fallback 判据（会把用户没选的属性一起改掉）");
});

test("单条写失败降级成跳过，不许拖垮整批", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  const body = code.slice(code.indexOf("function writeSide("), code.indexOf("function writeLinear("));
  assert.ok(body.includes("try {"), "writeSide 里没有 try");
  assert.ok(/try \{\s*prop\.setTemporalEaseAtKey\(aeIndex, inArr, outArr\);\s*\} catch \(e5\) \{[\s\S]*?return "failed";/.test(body),
    "setTemporalEaseAtKey 没有包 try/catch，抛出来就是整批 write_failed");
  // 异常文本必须留下来，否则面板只能报一个 "failed" 代号
  assert.ok(body.includes("lastWriteError ="), "写失败时没有记下 AE 的原话");
});

test("写入被拒时把 AE 的原始异常与属性位置一起报出来", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const send = code.slice(code.indexOf("function send("), code.indexOf("function skipNote("));
  assert.ok(send.includes("data.detail"), "没有显示 AE 的异常详情");
  assert.ok(send.includes("shortLoc(data.loc)"), "没有指出是哪条属性");
  // 一条都没写成时按失败处理，不能显示「已应用 0 处」
  assert.ok(send.includes("if (!applied)"), "全部跳过时没有按失败处理");
});

test("跳过原因按类别归并成一句人话", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const note = code.slice(code.indexOf("function skipNote("), code.indexOf("function describeScope("));
  for (const key of ["failed", "roving", "edge", "loc_missing", "key_out_of_range"]) {
    assert.ok(note.includes("counts." + key), "没有归类 " + key);
  }
  assert.ok(note.includes("不支持缓动"), "failed 没有说明是「不支持缓动」");
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
  assert.ok(panelSrc.includes("function buildText("), "缺少 buildText（预设与拖拽共用的写回出口）");
});

test("Flow 布局：曲线 + 应用 + 预设网格，没有「读取选中」入口", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  for (const id of ["curveStage", "curveCanvas", "curveReadout", "curveApply", "curvePresets"]) {
    assert.ok(html.includes('id="' + id + '"'), "缺少 " + id);
  }
  // 手动读取与属性下拉都取消了：读 AE 只发生在按「应用」时
  for (const gone of ["btnCurveRead", "curveProp", "curvePreset", "curveDim"]) {
    assert.ok(!html.includes('id="' + gone + '"'), "不该再有 " + gone);
  }
  const css = read("cep/com.dreamengine.panel/css/style.css");
  for (const sel of [".curve-apply", ".curve-presets", ".preset-chip", ".curve-readout"]) {
    assert.ok(css.includes(sel), "缺少样式 " + sel);
  }
});

test("曲线是常驻模板：进入视图不读 AE", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const enter = code.slice(code.indexOf("function enter("), code.indexOf("function snapshot("));
  assert.ok(enter.length > 20, "没找到 enter");
  assert.ok(!enter.includes("snapshotJson"), "enter() 还在读快照");
  assert.ok(!enter.includes("engine("), "enter() 还在过桥");
  // 读快照只应出现在 apply / refreshSnap 里
  assert.equal((code.match(/snapshotJson/g) || []).length, 2,
    "snapshotJson 只应在 apply 与 refreshSnap 各出现一次");
});

test("值图只有一组把手，拖拽只改本地曲线、绝不过桥", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  for (const fn of ["handleAt", "applyDrag", "drawHandles", "bezierPoint"]) {
    assert.ok(code.includes("function " + fn + "("), "缺少 " + fn);
  }
  const drag = code.slice(code.indexOf("function applyDrag("), code.indexOf("function onMouseUp("));
  assert.ok(drag.length > 100, "没找到 applyDrag");
  assert.ok(!drag.includes("send("), "拖拽里调用了写回");
  assert.ok(!drag.includes("engine("), "拖拽里过了桥");
  assert.ok(drag.includes("st.curve.x1 = nx"), "拖拽没有更新本地曲线");
  // 松手也不写：写入只由「应用」触发
  const up = code.slice(code.indexOf("function onMouseUp("), code.indexOf("function onKeyDown("));
  assert.ok(!up.includes("send("), "松手还在写回");
});

test("应用时才读快照：expect + out/in 覆盖每条属性的每一段", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const build = code.slice(code.indexOf("function buildText("), code.indexOf("function apply("));
  assert.ok(build.includes('"expect') && build.includes("p.loc") && build.includes("p.sig"), "缺少 expect 行");
  assert.ok(build.includes('["out", p.loc, String(s)'), "缺少 out 侧");
  assert.ok(build.includes('["in", p.loc, String(s + 1)'), "缺少 in 侧");
  assert.ok(build.includes("segs++"), "没有累计段数");
  assert.ok(build.includes("keys.length < 2"), "不足两把关键帧的属性没有跳过");

  const apply = code.slice(code.indexOf("function apply("), code.indexOf("function send("));
  assert.ok(apply.includes('engine("AEV_Curve.snapshotJson()"'), "apply 没有读快照");
  assert.ok(apply.includes("st.snap = data"), "apply 没有留下快照");
  assert.ok(apply.includes("buildText(data.props, st.curve)"), "apply 没有用模板曲线");

  const send = code.slice(code.indexOf("function send("), code.indexOf("function describeScope("));
  assert.ok(send.includes("AEV_Curve.applyText"), "send 没调写回");
  assert.ok(send.includes("refreshSnap()"), "写成功后没有重读对齐");
});

test("预设以曲线缩略图呈现，点选即换模板", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  for (const fn of ["renderPresets", "makeChip", "drawChip", "selectPreset"]) {
    assert.ok(code.includes("function " + fn + "("), "缺少 " + fn);
  }
  // 缩略图必须真的画曲线，不能只写文字
  const chip = code.slice(code.indexOf("function drawChip("), code.indexOf("function selectPreset("));
  assert.ok(chip.includes("bezierPoint(curve"), "缩略图没有按贝塞尔采样");
  assert.ok(chip.includes("ctx.stroke()"), "缩略图没有描边");
  // 回弹族会跑出 0..1，缩略图要按实际范围取景
  assert.ok(chip.includes("Math.min(0, curve.y1, curve.y2)"), "缩略图没有按 y 范围取景");
  const sel = code.slice(code.indexOf("function selectPreset("), code.indexOf("function updateReadout("));
  assert.ok(sel.includes("st.curve = { x1: b[0]"), "点预设没有换模板");
  assert.ok(sel.includes("st.preset = id"), "点预设没有记选中态");
  // 手动拖过之后必须取消预设高亮，否则出现「高亮着缓动、曲线已变」的假象
  const drag = code.slice(code.indexOf("function applyDrag("), code.indexOf("function onMouseUp("));
  assert.ok(drag.includes('st.preset = ""'), "手动拖拽没有取消预设高亮");
});

test("并发冲突只剩两个选项：覆盖 / 放弃", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  assert.ok(code.includes("curveConflictOverwrite"));
  assert.ok(code.includes("curveConflictDrop"));
  assert.ok(!code.includes("curveConflictReload"), "「重新载入」已随读取入口一起取消");
  // 覆盖时必须去掉 expect 行并加 force，否则会再次冲突
  assert.ok(code.includes('"force') && code.includes("overwrite"), "覆盖没有加 force");
  assert.ok(code.includes('indexOf("expect') && code.includes("!== 0"),
    "覆盖时没有过滤掉 expect 行");
});

test("Esc 取消拖拽：曲线回到按下把手时的样子", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const keydown = code.slice(code.indexOf("function onKeyDown("), code.indexOf("function buildText("));
  assert.ok(keydown.includes("st.drag.curve"), "没有记下拖拽前的曲线");
  assert.ok(keydown.includes("已取消这次拖拽"), "缺少取消反馈");
  assert.ok(!keydown.includes("send("), "Esc 不应该写回 AE");
});

test("三视图切换：表驱动 + 曲线视图进入不读 AE", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/library.js"));
  assert.ok(code.includes('var VIEW_TABS = { effects: "tabEffects", presets: "tabPresets", curve: "tabCurve" }'));
  assert.ok(code.includes('var VIEW_PANELS = { effects: "viewEffects", presets: "viewPresets", curve: "viewCurve" }'));
  assert.ok(code.includes("AEV_CurveUI.enter()"));
  assert.ok(code.includes('byId("tabCurve").addEventListener'));
});

test("index.html：第三个视图与冲突按钮齐全，且与预设视图同级", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  assert.ok(html.includes('id="tabCurve"'));
  assert.ok(/id="viewCurve"[^>]*hidden/.test(html));
  assert.ok(html.includes('id="curveCanvas"'));
  const curveAt = html.indexOf('id="viewCurve"');
  assert.ok(curveAt > 0);
  assert.ok(html.indexOf('id="viewPresets"') < curveAt);
  for (const id of ["curveConflictOverwrite", "curveConflictDrop"]) {
    assert.ok(html.includes('id="' + id + '"'), "缺少 " + id);
  }
  assert.ok(html.indexOf('src="engine/curve_math.js"') < html.indexOf('src="js/curve.js"'));

  // 三个视图必须在**同一个**顶部切换栏里（效果预览 / 预设预览 / 曲线编辑），
  // 不能把曲线做成抽屉或二级入口 —— 合并分支时最容易被拆散的一条。
  const navStart = html.indexOf('<nav class="view-switch"');
  const navEnd = html.indexOf("</nav>", navStart);
  assert.ok(navStart > 0 && navEnd > navStart, "缺少顶部切换栏");
  const nav = html.slice(navStart, navEnd);
  for (const id of ["tabEffects", "tabPresets", "tabCurve"]) {
    assert.ok(nav.includes('id="' + id + '"'), id + " 不在切换栏里");
  }
  assert.equal((html.match(/class="view-switch"/g) || []).length, 1, "切换栏只能有一个");
  assert.ok(nav.indexOf("tabEffects") < nav.indexOf("tabPresets"), "顺序应为 效果 → 预设");
  assert.ok(nav.indexOf("tabPresets") < nav.indexOf("tabCurve"), "顺序应为 预设 → 曲线");
});

test("CSS：视图与对话框的 [hidden] 都要显式覆盖", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  assert.match(css, /\.curve-view\[hidden\]\s*\{\s*display: none/);
  assert.match(css, /\.curve-conflict\[hidden\]\s*\{\s*display: none/);
  assert.match(css, /\.curve-hint\s*\{[^}]*overflow: hidden/);
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
