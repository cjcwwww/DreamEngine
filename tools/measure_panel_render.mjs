#!/usr/bin/env node
/* ============================================================
 * measure_panel_render.mjs —— 面板真实渲染路径的实测
 *
 * 目的：插件预览批量生成后，面板一次要渲染几百张卡片。
 * 这里用无头 Chrome 加载**真实的 index.html + bridge.js + viewmodel.js +
 * library.js + style.css**，只把 Bridge 的 AE 通道换成桩（返回真实索引文件），
 * 于是走的是面板自己的 refresh → rebuildItems → render 全流程，
 * 量的是真实耗时与真实 DOM，而不是另写一份模拟。
 *
 * 用法：node tools/measure_panel_render.mjs
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");
const RUNTIME_PANEL = resolve(
  process.env.APPDATA || "",
  "Adobe/CEP/extensions/com.dreamengine.panel",
);
/* 模拟页必须放在**运行时扩展目录**里：面板用相对路径读 data/names.json，
   而仓库里的 data/ 只有清单，没有运行时索引。 */
const SIM = resolve(RUNTIME_PANEL, "__sim_render.html");

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

/* 运行时索引（插件预览批量生成后就绪） */
const runtimeData = resolve(RUNTIME_PANEL, "data");
if (!existsSync(resolve(runtimeData, "manifest.json"))) {
  console.error("运行时没有索引，先装 L1 或跑插件预览");
  process.exit(1);
}

/* --- 桩：把 AE 通道换成本地索引 --- */
const stub = `
<script>
window.__SIM_ERRORS = [];
window.addEventListener("error", function (e) { window.__SIM_ERRORS.push(String(e.message)); });
(function () {
  var root = ${JSON.stringify(RUNTIME_PANEL)};
  Bridge.getExtensionPath = function (cb) { cb(root); };
  Bridge.evalAE = function (jsx, cb) {
    if (cb) cb("__NOT_CEP__");
  };
  Bridge.runEngine = function (path, expr, cb) {
    var out = "";
    try {
      if (expr.indexOf("AEV_Catalog.getCatalogJson") === 0) {
        out = window.__SIM_CATALOG;
      } else if (expr.indexOf("AEV_PreviewGen.staleList") === 0) {
        out = '{"stale":[]}';
      } else if (expr.indexOf("AEV_Queue.stats") === 0) {
        out = '{"total":0,"pending":0,"rendering":0,"cached":0,"failed":0}';
      } else if (expr.indexOf("AEV_Queue.listJson") === 0) {
        out = '{"total":0,"items":[]}';
      } else {
        out = '{"status":"ok"}';
      }
    } catch (e) {
      out = "ERR:" + e;
    }
    if (cb) setTimeout(function () { cb(out); }, 0);
  };
})();
</script>
`;

/* --- 测量脚本：等 refresh 完成后统计 --- */
const probe = `
<script>
function countCards() {
  return document.querySelectorAll(".effect-card").length;
}
function firstThumbInfo() {
  var t = document.querySelector(".effect-card .thumb");
  if (!t) return null;
  return {
    image: String(t.style.backgroundImage || "").slice(0, 90),
    size: String(t.style.backgroundSize || ""),
    position: String(t.style.backgroundPosition || "")
  };
}
function finish() {
  var select = document.getElementById("pluginFilter");
  var byPlugin = {};
  var options = select ? select.getElementsByTagName("option") : [];
  for (var i = 0; i < options.length; i++) {
    byPlugin[options[i].value] = options[i].textContent;
  }
  var result = {
    cardsBuiltin: countCards(),
    firstThumb: firstThumbInfo(),
    errors: window.__SIM_ERRORS,
    byPlugin: byPlugin,
    stats: String(document.getElementById("selectionStats") ? document.getElementById("selectionStats").textContent : ""),
    status: String(document.getElementById("statusText") ? document.getElementById("statusText").textContent : ""),
    queueCounts: String(document.getElementById("queueCounts") ? document.getElementById("queueCounts").textContent : "")
  };
  // 切到第一个插件来源，再数一次
  if (select && select.options.length > 2) {
    select.value = select.options[2].value;
    var ev = document.createEvent("HTMLEvents");
    ev.initEvent("change", true, false);
    select.dispatchEvent(ev);
    setTimeout(function () {
      result.cardsPlugin = countCards();
      result.pluginThumb = firstThumbInfo();
      result.pluginStats = String(document.getElementById("selectionStats").textContent);

      /* --- 视图切换：预设视图里不能残留效果墙 --- */
      document.getElementById("tabPresets").click();
      setTimeout(function () {
        var ve = document.getElementById("viewEffects");
        var vp = document.getElementById("viewPresets");
        result.viewEffectsHidden = ve ? ve.hidden : null;
        result.viewPresetsHidden = vp ? vp.hidden : null;
        // 关键：真的不可见，而不只是 hidden 属性为 true
        // (.workspace 的 display:flex 会盖掉 [hidden] 的 display:none)
        result.effectsVisible = ve ? ve.getBoundingClientRect().height > 0 : null;
        result.presetsVisible = vp ? vp.getBoundingClientRect().height > 0 : null;
        result.cardsInPresetView = countCards();
        result.presetCards = document.querySelectorAll(".preset-card").length;

        /* --- 搜索框：点图标展开、再点收起 --- */
        var toggle = document.getElementById("searchToggle");
        var field = document.getElementById("searchField");
        result.searchHiddenInitially = field ? field.hidden : null;
        toggle.click();
        result.searchOpenAfterClick = field ? !field.hidden : null;
        toggle.click();
        result.searchHiddenAfterSecondClick = field ? field.hidden : null;

        document.getElementById("out").textContent = JSON.stringify(result);
      }, 500);
    }, 400);
    return;
  }
  document.getElementById("out").textContent = JSON.stringify(result);
}
setTimeout(finish, 2500);
</script>
`;

/* catalog 桩数据要提前塞进页面（在 stub 之前定义） */
const catalogJson = (() => {
  const tsv = resolve(ROOT, "probe-results/AE2021/T0_1_full.tsv");
  if (!existsSync(tsv)) return '{"version":1,"count":0,"effects":[]}';
  const lines = readFileSync(tsv, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split("\t");
  const iM = header.indexOf("matchName");
  const iD = header.indexOf("displayName");
  const iC = header.indexOf("category");
  const items = lines.map((line) => {
    const c = line.split("\t");
    return {
      matchName: c[iM] || "",
      displayName: c[iD] || "",
      category: c[iC] || ""
    };
  });
  return JSON.stringify({
    version: 1,
    count: items.length,
    effects: items
  });
})();

const html = readFileSync(resolve(PANEL, "index.html"), "utf8")
  .replace(
    "</body>",
    `<pre id="out"></pre>\n<script>window.__SIM_CATALOG = ${JSON.stringify(catalogJson)};</script>\n${stub}\n${probe}\n</body>`,
  );
writeFileSync(SIM, html, "utf8");

const dom = execFileSync(
  browser,
  [
    "--headless",
    "--disable-gpu",
    // 面板用 XHR 读同目录的 data/*.json；file:// 下默认被同源策略挡住
    "--allow-file-access-from-files",
    "--dump-dom",
    "--virtual-time-budget=8000",
    "file:///" + SIM.replace(/\\/g, "/"),
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
);

try {
  unlinkSync(SIM);
} catch (e) {}

const block = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
if (!block) {
  console.error("没拿到测量结果（面板脚本可能报错了）");
  process.exit(1);
}
const data = JSON.parse(block[1].replace(/&quot;/g, '"'));

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("[PASS] " + name);
  } catch (e) {
    failed++;
    console.log("[FAIL] " + name);
    console.log("       " + String(e.message || e).split("\n").slice(0, 5).join("\n       "));
  }
}

console.log(`渲染卡片：内置来源 ${data.cardsBuiltin} 张，切到插件来源 ${data.cardsPlugin} 张`);
console.log(`状态栏：${data.status} | ${data.stats} | 队列 ${data.queueCounts}`);
console.log(`来源下拉：${JSON.stringify(data.byPlugin)}`);
console.log(`首个缩略图：${JSON.stringify(data.firstThumb)}`);
console.log(`插件来源首个缩略图：${JSON.stringify(data.pluginThumb)}`);
console.log(`页面错误：${JSON.stringify(data.errors)}`);

check("面板渲染没有 JS 错误", () => {
  assert.equal((data.errors || []).length, 0, String((data.errors || []).join("; ")));
});

check("内置来源能渲染出卡片", () => {
  assert.ok(data.cardsBuiltin > 100, `只有 ${data.cardsBuiltin} 张卡片`);
});

check("插件来源能渲染出卡片", () => {
  assert.ok((data.cardsPlugin || 0) > 0, "切到插件来源后一张卡片都没有");
});

check("缩略图用了百分比切片（不是固定像素）", () => {
  assert.match(data.firstThumb.size, /%/);
  assert.match(data.firstThumb.position, /%/);
  assert.match(data.pluginThumb.size, /%/);
});

check("插件来源的切片是 1×1 单格", () => {
  // 浏览器会把 "100.0000%" 规范化成 "100%"，两种都算对
  assert.match(data.pluginThumb.size, /^100(\.0+)?% 100(\.0+)?%$/);
  assert.match(data.pluginThumb.position, /^0(\.0+)?% 0(\.0+)?%$/);
});

check("来源下拉标出了各包的预览数量", () => {
  const bcc = (data.byPlugin || {}).BCC || "";
  assert.match(bcc, /\d/, "BCC 一项应带预览数量");
});

check("切到预设视图后效果墙真的不可见", () => {
  assert.equal(data.viewEffectsHidden, true, "viewEffects 的 hidden 属性应为 true");
  assert.equal(data.viewPresetsHidden, false, "viewPresets 应该显示");
  // 关键断言：不能只是属性为 true，实际还占着位置
  // （.workspace 的 display:flex 会盖掉 [hidden] 的 display:none）
  assert.equal(data.effectsVisible, false, "效果视图仍在显示（hidden 被 CSS 盖掉了）");
  assert.equal(data.presetsVisible, true, "预设视图没有显示");
});

check("预设视图里不残留效果卡片", () => {
  assert.equal(data.cardsInPresetView, 0, `预设视图里还有 ${data.cardsInPresetView} 张效果卡片`);
});

check("搜索框点图标展开、再点收起", () => {
  assert.equal(data.searchHiddenInitially, true, "初始应是收起的");
  assert.equal(data.searchOpenAfterClick, true, "点一次图标应展开");
  assert.equal(data.searchHiddenAfterSecondClick, true, "再点一次应收起");
});

console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}`);
if (failed > 0) process.exitCode = 1;
