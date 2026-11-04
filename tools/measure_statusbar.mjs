#!/usr/bin/env node
/* ============================================================
 * measure_statusbar.mjs —— 底部栏多比例实测
 *
 * 用户反馈：面板拖到某些比例时，底栏里的「0 待渲染 / 0 失败」「显示 211」
 * 会被 flex 压成逐字竖排，整条底栏被撑高好几倍。
 *
 * 用无头 Chrome 加载**真实的 style.css**，在 7 种面板宽度下塞进最坏情况的
 * 文案（超长状态 + 长队列计数），量底栏与每个子项的高度。
 * 静态断言只能证明 CSS 写了规则，这里证明规则在真实浏览器里真的生效。
 *
 * 为什么用 iframe：Chrome 的 --window-size 最小宽度被限制在 500px 左右，
 * 面板实际可以比这更窄。iframe 内的媒体查询按 iframe 自身宽度计算，
 * 可以精确模拟 220px 这种极窄比例。
 *
 * 用法：node tools/measure_statusbar.mjs
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const RUNTIME_PANEL = resolve(
  process.env.APPDATA || "",
  "Adobe/CEP/extensions/com.dreamengine.panel",
);
const SIM = resolve(RUNTIME_PANEL, "__sim_statusbar.html");
const FRAME = resolve(RUNTIME_PANEL, "__sim_statusbar_frame.html");

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
if (!existsSync(resolve(RUNTIME_PANEL, "css/style.css"))) {
  console.error("运行时扩展目录里没有 style.css");
  process.exit(1);
}

const WIDTHS = [1200, 800, 620, 460, 360, 280, 220];

/* 最坏情况：状态文案很长，队列计数故意用旧的长格式 */
const framePage = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<link rel="stylesheet" href="css/style.css"/></head>
<body>
<footer class="statusbar">
  <span id="statusText">索引写入失败：在需要数字、数组或属性的位置找到类型为 Error 的对象（很长的错误详情很长的错误详情很长的错误详情）</span>
  <span class="size-slider">
    <label for="thumbSize">预览大小</label>
    <input id="thumbSize" type="range" min="48" max="180" step="2" value="132"/>
    <output id="thumbSizeValue">132</output>
  </span>
  <span id="selectionStats">显示 211</span>
  <button class="queue-toggle" id="btnQueue" type="button">队列 <span id="queueCounts">0 待渲染 / 0 失败</span></button>
</footer>
<pre id="out"></pre>
<script>
var bar = document.querySelector(".statusbar");
var h = function (sel) {
  var el = document.querySelector(sel);
  if (!el) return null;
  var r = el.getBoundingClientRect();
  return { h: r.height, w: r.width, shown: r.width > 0 && r.height > 0 };
};
document.getElementById("out").textContent = JSON.stringify({
  viewport: window.innerWidth,
  bar: bar.getBoundingClientRect().height,
  barScroll: bar.scrollHeight,
  status: h("#statusText"),
  slider: h(".size-slider"),
  selection: h("#selectionStats"),
  queue: h("#queueCounts"),
  toggle: h(".queue-toggle")
});
</script>
</body></html>`;

const hostPage = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>body{margin:0}iframe{border:0;display:block;height:80px}</style></head>
<body><pre id="finalOut"></pre>
<script>
var widths = ${JSON.stringify(WIDTHS)};
var out = new Array(widths.length);
var done = 0;
widths.forEach(function (w, i) {
  var f = document.createElement("iframe");
  f.style.width = w + "px";
  f.onload = function () {
    try {
      out[i] = JSON.parse(f.contentDocument.getElementById("out").textContent);
    } catch (e) {
      out[i] = { viewport: w, error: String(e) };
    }
    done++;
    if (done === widths.length) {
      document.getElementById("finalOut").textContent = JSON.stringify(out);
    }
  };
  f.src = "__sim_statusbar_frame.html";
  document.body.appendChild(f);
});
</script>
</body></html>`;

writeFileSync(FRAME, framePage, "utf8");
writeFileSync(SIM, hostPage, "utf8");

let results = [];
try {
  const dom = execFileSync(
    browser,
    [
      "--headless",
      "--disable-gpu",
      "--allow-file-access-from-files",
      "--dump-dom",
      "--virtual-time-budget=4000",
      "file:///" + SIM.replace(/\\/g, "/"),
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
  const block = dom.match(/<pre id="finalOut">([\s\S]*?)<\/pre>/);
  if (!block || !block[1].trim()) {
    console.error("没拿到测量结果（iframe 可能没加载完）");
    process.exit(1);
  }
  results = JSON.parse(block[1].replace(/&quot;/g, '"'));
} finally {
  try { unlinkSync(SIM); } catch (e) {}
  try { unlinkSync(FRAME); } catch (e) {}
}

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("[PASS] " + name);
  } catch (e) {
    failed++;
    console.log("[FAIL] " + name + " — " + String(e.message || e));
  }
}

console.log("宽度     视口   底栏   状态   滑块   显示N   队列计数   队列按钮");
for (const r of results) {
  console.log(
    String(r.viewport).padStart(6) +
      String(r.bar).padStart(8) +
      String(r.status.h.toFixed(0)).padStart(8) +
      String(r.slider.shown ? r.slider.h.toFixed(0) : "隐藏").padStart(8) +
      String(r.selection.shown ? r.selection.h.toFixed(0) : "隐藏").padStart(8) +
      String(r.queue.h.toFixed(0)).padStart(10) +
      String(r.toggle.h.toFixed(0)).padStart(10),
  );
}

check("每种宽度都拿到了真实测量结果", () => {
  assert.equal(results.length, WIDTHS.length);
  for (const r of results) assert.ok(!r.error, JSON.stringify(r));
});

check("iframe 宽度确实各不相同（否则测的是同一个比例）", () => {
  const set = new Set(results.map((r) => r.viewport));
  assert.equal(set.size, WIDTHS.length, `只测到 ${set.size} 种视口：${[...set].join(",")}`);
});

check("所有宽度下底栏高度恒定为 26px", () => {
  for (const r of results) {
    assert.equal(r.bar, 26, `视口 ${r.viewport} 下底栏高 ${r.bar}`);
  }
});

check("所有宽度下底栏没有垂直溢出（内容没换行）", () => {
  for (const r of results) {
    assert.ok(r.barScroll <= 28, `视口 ${r.viewport} 下 scrollHeight=${r.barScroll}`);
  }
});

check("状态文字、队列计数、队列按钮在任何宽度下都不竖排", () => {
  for (const r of results) {
    for (const key of ["status", "queue", "toggle"]) {
      assert.ok(r[key].h <= 22, `视口 ${r.viewport} 下 ${key} 高 ${r[key].h}（竖排了）`);
    }
  }
});

check("窄比例下按顺序隐藏次要项，而不是硬挤", () => {
  const narrow = results.filter((r) => r.viewport <= 460);
  assert.ok(narrow.length > 0, "没有覆盖到 460px 以下的宽度");
  for (const r of narrow) {
    assert.equal(r.selection.shown, false, `视口 ${r.viewport} 下「显示 N」还在`);
  }
  const tiny = results.filter((r) => r.viewport <= 360);
  assert.ok(tiny.length > 0, "没有覆盖到 360px 以下的宽度");
  for (const r of tiny) {
    assert.equal(r.slider.shown, false, `视口 ${r.viewport} 下尺寸滑块还在`);
  }
});

console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}（${WIDTHS.length} 种宽度）`);
process.exitCode = failed === 0 ? 0 : 1;
