#!/usr/bin/env node
/* ============================================================
 * measure_curve_render.mjs —— 曲线编辑视图的真渲染实测（M4）
 *
 * 用无头 Chrome 加载**真实的 index.html + curve_math.js + curve.js +
 * library.js + style.css**，只把 Bridge 的 AE 通道换成桩：
 *   · snapshotJson 返回一份真实结构的快照
 *   · applyText 记录面板下发的文本协议并返回可切换的结果
 * 然后派发真实的 mousedown/mousemove/mouseup 去拖把手 ——
 * 走的是命中测试、坐标换算、本地重绘、松手写回的全链路。
 *
 * 这样能测到静态断言测不出来的东西：画布到底画没画、坐标算错没有、
 * 拖拽过程中是不是真的没过桥、冲突对话框能不能弹出来。
 *
 * 用法：node tools/measure_curve_render.mjs
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");
/* 模拟页必须放在扩展目录里：面板用相对路径加载 js/ css/ 与 data/ */
const SIM = resolve(PANEL, "__sim_curve.html");

function findChrome() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}
const browser = findChrome();
if (!browser) {
  console.log("跳过：找不到 Chrome / Edge");
  process.exit(0);
}

/* ---------- 快照桩：结构与 curvelib 的 snapshotJson 一致 ---------- */

function keyFrame(i, t, v, opts) {
  const o = opts || {};
  const dims = v.length;
  const fill = (n) => v.map(() => n);
  return {
    i, t, v,
    tin: o.tin === undefined ? 2 : o.tin,
    tout: o.tout === undefined ? 2 : o.tout,
    is: o.is || fill(0),
    ii: o.ii || fill(33.33),
    os: o.os || fill(0),
    oi: o.oi || fill(33.33),
    it: o.it || fill(0),
    ot: o.ot || fill(0),
    ab: false, co: true, rv: false,
  };
}

const sliderProp = {
  i: 0,
  loc: "M4Sim|m4_1d|变换|滑杆",
  name: "滑杆",
  group: "变换",
  matchName: "ADBE Slider Control-0001",
  vt: 1, dims: 1, spatial: false, sep: false, n: 3,
  sig: "sig-a",
  keys: [
    keyFrame(0, 0, [0]),
    keyFrame(1, 1, [100]),
    keyFrame(2, 2, [30]),
  ],
};

const positionProp = {
  i: 1,
  loc: "M4Sim|m4_2d|变换|位置",
  name: "位置",
  group: "变换",
  matchName: "ADBE Position",
  vt: 3, dims: 2, spatial: true, sep: false, n: 3,
  sig: "sig-b",
  keys: [
    keyFrame(0, 0, [300, 800], { ot: [120, -80] }),
    keyFrame(1, 1, [900, 300], { ot: [200, -150], it: [-200, -150] }),
    keyFrame(2, 2, [1700, 800], { it: [-120, 80] }),
  ],
};

const SNAPSHOT = JSON.stringify({
  status: "ok",
  version: "1.0.0",
  ae: "21.0.0",
  comp: "M4Sim",
  time: 0.6,
  props: [sliderProp, positionProp],
});

/* ---------- 桩 ---------- */

const stub = `
<pre id="out"></pre>
<script>
window.__SIM_ERRORS = [];
window.addEventListener("error", function (e) { window.__SIM_ERRORS.push(String(e.message)); });
window.__SIM = { reads: 0, writes: [], writesDuringMove: 0, dragging: false };
window.__SIM_SNAPSHOT = ${JSON.stringify(SNAPSHOT)};
window.__SIM_APPLY = '{"status":"ok","applied":1,"skipped":[],"sigs":[]}';

Bridge.getExtensionPath = function (cb) { cb("file:///sim/panel"); };
Bridge.evalAE = function (jsx, cb) { if (cb) cb("__NOT_CEP__"); };
Bridge.getDocsPath = function (cb) { cb(""); };
Bridge.listFiles = function (dir, pat, cb) { cb("NO_DIR"); };
Bridge.runEngine = function (path, expr, cb) {
  var out = '{"status":"ok"}';
  try {
    if (expr.indexOf("AEV_Curve.snapshotJson") === 0) {
      window.__SIM.reads++;
      out = window.__SIM_SNAPSHOT;
    } else if (expr.indexOf("AEV_Curve.applyText") === 0) {
      var arg = expr.slice(expr.indexOf("(") + 1, expr.lastIndexOf(")"));
      var text = "";
      try { text = JSON.parse(arg); } catch (e) { text = String(arg); }
      if (window.__SIM.dragging) window.__SIM.writesDuringMove++;
      window.__SIM.writes.push({ text: text });
      out = window.__SIM_APPLY;
    } else if (expr.indexOf("AEV_Queue.stats") === 0) {
      out = '{"total":0,"pending":0,"rendering":0,"cached":0,"failed":0}';
    } else if (expr.indexOf("AEV_Presets.listJson") === 0) {
      out = '{"status":"ok","items":[],"folder":""}';
    } else if (expr.indexOf("AEV_PreviewGen.staleList") === 0) {
      out = '{"stale":[]}';
    }
  } catch (e) { out = "ERR:" + e; }
  if (cb) setTimeout(function () { cb(out); }, 0);
};
</script>
`;

/* ---------- 探测脚本：驱动真实交互 ---------- */

const probe = `
<script>
var R = {};
var canvas, ctx, rect;

function wait(ms, fn) { setTimeout(fn, ms); }

function paintedPixels() {
  var c = document.getElementById("curveCanvas");
  var g = c.getContext("2d");
  var img = g.getImageData(0, 0, c.width, c.height).data;
  var n = 0;
  for (var i = 3; i < img.length; i += 4) if (img[i] > 8) n++;
  return n;
}

function mouseAt(type, x, y) {
  var target = type === "mouseup" ? document : canvas;
  target.dispatchEvent(new MouseEvent(type, {
    clientX: rect.left + x,
    clientY: rect.top + y,
    bubbles: true,
    button: 0,
    buttons: type === "mouseup" ? 0 : 1
  }));
}

function drag() {
  var snap = AEV_CurveUI.snapshot();
  var key = snap.keyPoints[1];
  if (!key) { R.error = "没有第二把关键帧"; return false; }
  mouseAt("mousedown", key.x, key.y);
  mouseAt("mouseup", key.x, key.y);
  var after = AEV_CurveUI.snapshot();
  R.afterClick = { selected: after.selected, handle: after.handle, key: key };
  if (!after.handle) { R.error = "选中关键帧后没有拿到把手坐标"; return false; }
  R.handleBefore = after.handle;
  // 真正的拖拽：必须先在把手上按下，才算进入拖拽（点关键帧只是选中）
  mouseAt("mousedown", after.handle.x, after.handle.y);
  window.__SIM.dragging = true;
  mouseAt("mousemove", after.handle.x, after.handle.y + 6);
  mouseAt("mousemove", after.handle.x + 18, after.handle.y + 10);
  R.writesDuringMove = window.__SIM.writesDuringMove;
  window.__SIM.dragging = false;
  mouseAt("mouseup", after.handle.x + 18, after.handle.y + 10);
  return true;
}

function run() {
  R.errors = window.__SIM_ERRORS;

  /* 切到曲线视图 */
  document.getElementById("tabCurve").click();

  wait(400, function () {
    R.viewCurveHidden = document.getElementById("viewCurve").hidden;
    R.viewCurveVisible = document.getElementById("viewCurve").getBoundingClientRect().height > 0;
    R.effectsVisible = document.getElementById("viewEffects").getBoundingClientRect().height > 0;
    R.propOptions = document.getElementById("curveProp").options.length;
    R.readsAfterEnter = window.__SIM.reads;
    R.painted = paintedPixels();
    R.hint = String(document.getElementById("curveHint").textContent);
    R.snap = AEV_CurveUI.snapshot();
    R.keyCount = R.snap.keyPoints.length;
    R.writesBeforeDrag = window.__SIM.writes.length;

    canvas = document.getElementById("curveCanvas");
    ctx = canvas.getContext("2d");
    rect = canvas.getBoundingClientRect();

    /* 第一次拖拽：正常写回 */
    if (!drag()) { finish(); return; }

    wait(300, function () {
      R.writesAfterDrag = window.__SIM.writes.length;
      R.firstWrite = window.__SIM.writes.length ? window.__SIM.writes[0].text : "";
      R.readsAfterWrite = window.__SIM.reads;

      /* 第二次拖拽：模拟并发冲突 */
      window.__SIM_APPLY = '{"status":"conflict","reason":"changed","loc":"M4Sim|m4_1d|变换|滑杆","sig":"sig-z"}';
      if (!drag()) { finish(); return; }

      wait(200, function () {
        R.conflictVisible = !document.getElementById("curveConflict").hidden;
        R.conflictText = String(document.getElementById("curveConflictText").textContent);

        /* 点「覆盖」：应当发 force 且去掉 expect 行。
           先把桩的返回值改回 ok —— 用户选「覆盖」意味着这次写入被接受，
           否则会再次冲突，测的就不是覆盖路径了。 */
        window.__SIM_APPLY = '{"status":"ok","applied":1,"skipped":[],"sigs":[]}';
        document.getElementById("curveConflictOverwrite").click();

        wait(200, function () {
          R.writesAfterOverwrite = window.__SIM.writes.length;
          R.overwriteText = window.__SIM.writes.length > 1
            ? window.__SIM.writes[window.__SIM.writes.length - 1].text : "";
          R.conflictHiddenAfter = document.getElementById("curveConflict").hidden;

          /* 切到速度图 & 路径图 */
          document.getElementById("curveModeSpeed").click();
          R.paintedSpeed = paintedPixels();
          var pathBtn = document.getElementById("curveModePath");
          R.pathEnabledForSpatialPos = !pathBtn.disabled;
          R.modeAfterSpeed = AEV_CurveUI.snapshot().mode;

          /* 换成二维位置属性（空间）：路径图应可用 */
          var sel = document.getElementById("curveProp");
          sel.value = "1";
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          R.pathCapableOnPosition = AEV_CurveUI.snapshot().pathCapable;
          pathBtn.click();
          R.modePath = AEV_CurveUI.snapshot().mode;
          R.paintedPath = paintedPixels();

          /* 换回一维滑杆：路径图应被禁用 */
          sel.value = "0";
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          R.pathDisabledOnScalar = document.getElementById("curveModePath").disabled;
          R.modeAfterScalar = AEV_CurveUI.snapshot().mode;

          /* 收尾：选中中间那把关键帧，让截图里能看到把手 */
          var endSnap = AEV_CurveUI.snapshot();
          if (endSnap.keyPoints[1]) {
            mouseAt("mousedown", endSnap.keyPoints[1].x, endSnap.keyPoints[1].y);
            mouseAt("mouseup", endSnap.keyPoints[1].x, endSnap.keyPoints[1].y);
          }
          R.finalSelected = AEV_CurveUI.snapshot().selected;

          finish();
        });
      });
    });
  });
}

function finish() {
  R.errorsFinal = window.__SIM_ERRORS;
  document.getElementById("out").textContent = JSON.stringify(R);
}

wait(1200, run);
</script>
`;

const html = readFileSync(resolve(PANEL, "index.html"), "utf8").replace("</body>", `${stub}\n${probe}\n</body>`);
writeFileSync(SIM, html, "utf8");

let dom = "";
try {
  dom = execFileSync(
    browser,
    [
      "--headless",
      "--disable-gpu",
      "--allow-file-access-from-files",
      "--dump-dom",
      "--virtual-time-budget=12000",
      "file:///" + SIM.replace(/\\/g, "/"),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
} finally {
  // KEEP_SIM=1 时留着模拟页，方便手工用浏览器打开看版式
  if (process.env.KEEP_SIM !== "1") {
    try { unlinkSync(SIM); } catch (e) {}
  } else {
    console.log("模拟页已保留：" + SIM);
  }
}

const block = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
if (!block) {
  console.error("没拿到测量结果（面板脚本可能报错了）");
  process.exit(1);
}
const data = JSON.parse(block[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("[PASS] " + name);
  } catch (e) {
    failed++;
    console.log("[FAIL] " + name);
    console.log("       " + String(e.message || e).split("\n").slice(0, 4).join("\n       "));
  }
}

console.log("=== 曲线视图真渲染实测 ===");
console.log("读数 " + data.readsAfterEnter + " 次 ｜ 画布着色像素 " +
  data.painted + "（速度图 " + data.paintedSpeed + " / 路径图 " + data.paintedPath + "）");
console.log("提示：" + data.hint);
console.log("页面错误：" + JSON.stringify(data.errorsFinal || []));
console.log("");

check("切到曲线视图后真的可见，效果墙不可见", () => {
  assert.equal(data.viewCurveHidden, false, "viewCurve 仍是 hidden");
  assert.equal(data.viewCurveVisible, true, "curve-view 不可见（[hidden] 被 CSS 盖掉？）");
  assert.equal(data.effectsVisible, false, "效果墙还占着位置");
});

check("进入视图自动读一次，属性下拉有 2 项", () => {
  assert.ok(data.readsAfterEnter >= 1, "进入视图没有读快照");
  assert.equal(data.propOptions, 2, "属性下拉项数不对：" + data.propOptions);
});

check("画布真的画出了东西", () => {
  assert.ok(data.painted > 200, "画布几乎没有着色像素：" + data.painted);
});

check("关键帧被画在画布内", () => {
  assert.equal(data.keyCount, 3, "关键帧像素坐标数量不对：" + data.keyCount);
  assert.ok(data.afterClick && data.afterClick.handle, "点关键帧后没算出把手坐标");
  assert.deepEqual(data.afterClick.selected, [1], "点关键帧没有选中它");
});

check("拖拽过程中不过桥，松手才写", () => {
  assert.equal(data.writesBeforeDrag, 0, "还没拖就已经写了");
  assert.equal(data.writesDuringMove, 0, "mousemove 期间就过桥了：" + data.writesDuringMove);
  assert.equal(data.writesAfterDrag, 1, "松手后没有写回：" + data.writesAfterDrag);
});

check("写回文本是合法的文本协议（expect + out 行）", () => {
  const lines = String(data.firstWrite || "").split("\n");
  assert.ok(lines.length >= 2, "写回文本行数不足：" + JSON.stringify(lines));
  assert.match(lines[0], /^expect\t/, "第一行不是 expect：" + lines[0]);
  assert.match(lines[1], /^out\t|^in\t/, "第二行不是 ease 操作：" + lines[1]);
  // influence / m 必须是数字
  const fields = lines[1].split("\t");
  assert.ok(Number.isFinite(Number(fields[3])), "influence 不是数字：" + fields[3]);
  assert.ok(Number.isFinite(Number(fields[4])), "m 不是数字：" + fields[4]);
});

check("写回后重新读了一次快照（显示值以 AE 为准）", () => {
  assert.ok(data.readsAfterWrite > data.readsAfterEnter, "写回后没有重读");
});

check("并发冲突会弹框，而不是静默覆盖", () => {
  assert.equal(data.conflictVisible, true, "冲突没有弹框");
  assert.match(String(data.conflictText), /修改过|找不到/, "冲突文案不对：" + data.conflictText);
});

check("点「覆盖」重发时带 force 且去掉 expect 行", () => {
  // 三次写入：第一次正常、第二次撞冲突、第三次用户点「覆盖」重发
  assert.equal(data.writesAfterOverwrite, 3,
    "覆盖没有重发写回（期望 3 次：正常 1 + 冲突 1 + 覆盖 1），实际 " + data.writesAfterOverwrite);
  const text = String(data.overwriteText || "");
  assert.match(text.split("\n")[0], /^force$/, "首行不是 force：" + text.split("\n")[0]);
  assert.doesNotMatch(text, /^expect\t/m, "覆盖时仍带 expect 行");
  assert.equal(data.conflictHiddenAfter, true, "覆盖后对话框没关");
});

check("速度图能画、路径图只对空间属性开放", () => {
  assert.ok(data.paintedSpeed > 200, "速度图没画出来：" + data.paintedSpeed);
  assert.ok(data.paintedPath > 200, "路径图没画出来：" + data.paintedPath);
  assert.equal(data.pathCapableOnPosition, true, "二维位置应支持路径");
  assert.equal(data.modePath, "path");
  assert.equal(data.pathDisabledOnScalar, true, "一维属性不该能切路径图");
});

check("全流程没有 JS 错误", () => {
  assert.equal((data.errorsFinal || []).length, 0, String((data.errorsFinal || []).join("; ")));
});

console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}`);
if (failed > 0) process.exitCode = 1;
