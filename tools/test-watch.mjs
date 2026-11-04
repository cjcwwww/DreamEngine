#!/usr/bin/env node
/* ============================================================
 * test-watch.mjs —— 面板「外部变更监视」实测
 *
 * 背景：面板之外还有三条路径会改数据 ——
 *   · DreamEngine Hub 导入预设
 *   · 一键 bat 渲完写回索引与图片
 *   · 用户直接在资源管理器里往预设库丢 .ffx
 * 以前这些改完只能关掉面板重开。library.js 里加了 3 秒一次的
 * mtime 组合戳轮询，本测试验证三件事：
 *
 *   1. 戳变了 → 面板真的重载（状态栏给出同步提示）
 *   2. 戳没变 → 一次都不重载（不能每 3 秒把 1000+ 张卡片重建一遍）
 *   3. 全程零 JS 错误
 *
 * 做法：无头 Chrome 加载真实 index.html + 真实 library.js，
 * 只把 Bridge.watchStamp 换成可控戳，其余走面板自己的代码路径。
 *
 * 用法：node tools/test-watch.mjs
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
const SIM = resolve(RUNTIME_PANEL, "__sim_watch.html");

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
if (!existsSync(resolve(RUNTIME_PANEL, "data/manifest.json"))) {
  console.error("运行时没有索引，先装 L1（node tools/install_l1.mjs）");
  process.exit(1);
}

/* ---------- 桩：可控的变更戳 ----------
   第 1 次调用建立基线（A），第 2 次仍是 A（不该刷新），
   第 3 次起变 B（应刷新一次），之后一直 B（不该再刷新）。 */
const stub = `
<script>
window.__SIM_ERRORS = [];
window.__SIM_WATCH_CALLS = 0;
window.__SIM_REFRESHES = 0;
window.__STAMP = "A";
window.addEventListener("error", function (e) { window.__SIM_ERRORS.push(String(e.message)); });

(function () {
  Bridge.isCEP = function () { return true; };
  Bridge.watchStamp = function (path, cb) {
    var n = ++window.__SIM_WATCH_CALLS;
    if (n >= 3) window.__STAMP = "B";
    if (cb) setTimeout(function () { cb(window.__STAMP); }, 0);
  };
})();
</script>
`;

const catalog = {
  count: 3,
  effects: [
    { matchName: "ADBE Gaussian Blur 2", category: "模糊", builtin: true },
    { matchName: "ADBE Glo2", category: "风格化", builtin: true },
    { matchName: "ADBE Tint", category: "颜色校正", builtin: true },
  ],
};

const stubEngine = `
<script>
window.__SIM_CATALOG = ${JSON.stringify(catalog)};
(function () {
  Bridge.getExtensionPath = function (cb) { cb(${JSON.stringify(RUNTIME_PANEL.replace(/\\/g, "/"))}); };
  Bridge.evalAE = function (jsx, cb) { if (cb) cb("__NOT_CEP__"); };
  Bridge.runEngine = function (path, expr, cb) {
    var out = "";
    try {
      if (expr.indexOf("AEV_Catalog.getCatalogJson") === 0) {
        // refresh 每跑一次都会问一次目录，用它当「重载次数」的代理
        window.__SIM_REFRESHES++;
        // evalScript 真实返回的是字符串，这里必须同构，否则 parseEngineResult 会拿到对象
        out = JSON.stringify(window.__SIM_CATALOG);
      }
      else if (expr.indexOf("AEV_PreviewGen.staleList") === 0) out = '{"stale":[]}';
      else if (expr.indexOf("AEV_Queue.stats") === 0) out = '{"total":0,"pending":0,"rendering":0,"cached":0,"failed":0}';
      else if (expr.indexOf("AEV_Queue.listJson") === 0) out = '{"total":0,"items":[]}';
      else if (expr.indexOf("AEV_Presets.libraryJson") === 0) out = '{"status":"ok","count":0,"folder":"C:/sim","items":[]}';
      else if (expr.indexOf("AEV_PresetPreview.backgroundsJson") === 0) out = '{"status":"ok","items":[{"id":"photo","name":"标准","builtin":true}]}';
      else out = '{"status":"ok"}';
    } catch (e) { out = "ERR:" + e; }
    if (cb) setTimeout(function () { cb(out); }, 0);
  };
})();
</script>
`;

const probe = `
<script>
function statusText() {
  var el = document.getElementById("statusText");
  return el ? String(el.textContent) : "";
}
(function () {
  var tries = 0;
  var initialCards = 0;
  function tick() {
    tries++;
    var now = document.querySelectorAll(".effect-card").length;
    // 记录重载前的卡片数：重载后必须恢复到同一批，不能变成空墙
    if (initialCards === 0 && now > 0) initialCards = now;
    var done = /已同步|Synced/.test(statusText()) && window.__SIM_WATCH_CALLS >= 4;
    if (done || tries > 40) {
      document.getElementById("out").textContent = JSON.stringify({
        watchCalls: window.__SIM_WATCH_CALLS,
        refreshes: window.__SIM_REFRESHES,
        status: statusText(),
        cards: now,
        initialCards: initialCards,
        errors: window.__SIM_ERRORS
      });
      return;
    }
    setTimeout(tick, 300);
  }
  setTimeout(tick, 800);
})();
</script>
`;

const html = readFileSync(resolve(PANEL, "index.html"), "utf8").replace(
  "</body>",
  `<pre id="out"></pre>\n${stub}\n${stubEngine}\n${probe}\n</body>`,
);
writeFileSync(SIM, html, "utf8");

let dom;
try {
  dom = execFileSync(
    browser,
    [
      "--headless",
      "--disable-gpu",
      "--allow-file-access-from-files",
      "--dump-dom",
      // 轮询间隔 3 秒，要跑够 4 轮以上
      "--virtual-time-budget=20000",
      "file:///" + SIM.replace(/\\/g, "/"),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
} finally {
  try { unlinkSync(SIM); } catch (e) {}
}

const block = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
if (!block) {
  console.error("没拿到结果（面板脚本可能报错了）");
  process.exit(1);
}
const data = JSON.parse(block[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("[PASS] " + name);
  } catch (error) {
    failed++;
    console.error("[FAIL] " + name + "\n       " + error.message);
  }
}

check("轮询真的在跑（至少 4 次）", () => {
  assert.ok(data.watchCalls >= 4, "轮询次数不足：" + data.watchCalls);
});

check("戳变化后重载了一次", () => {
  // 初次 refresh 1 次 + 戳变化后 1 次 = 2；若每轮都刷会是 4 次以上
  assert.equal(data.refreshes, 2, "重载次数不对：" + data.refreshes);
});

check("戳没变时不重载", () => {
  assert.ok(
    data.refreshes < data.watchCalls,
    "监视次数 " + data.watchCalls + " 与重载次数 " + data.refreshes + " 相同，说明每轮都在重建",
  );
});

check("状态栏给出同步反馈", () => {
  assert.match(data.status, /已同步|Synced/, "状态栏没有同步提示：" + data.status);
});

check("重载后卡片数量不变（不是空墙）", () => {
  assert.ok(data.initialCards > 0, "重载前就没有卡片：" + data.initialCards);
  assert.equal(data.cards, data.initialCards, "重载后卡片数变了：" + data.initialCards + " → " + data.cards);
});

check("全程零 JS 错误", () => {
  assert.deepEqual(data.errors, [], "出现 JS 错误：" + JSON.stringify(data.errors));
});

console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}`);
if (failed > 0) process.exitCode = 1;
