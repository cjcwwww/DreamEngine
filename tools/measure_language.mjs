#!/usr/bin/env node
/* ============================================================
 * measure_language.mjs —— 语言覆盖实测
 *
 * 目标：**切到英文之后，界面上不能还剩中文。**
 *
 * 做法：无头 Chrome 加载真实 index.html + 真实脚本，只把 Bridge 换成桩，
 * 点「EN」，然后把四种视图/抽屉都打开一遍，逐个数：
 *   · 可见文本节点里的 CJK 字符
 *   · title / aria-label / placeholder 属性里的 CJK
 * 任何一处残留都会带着元素标识打出来，方便直接定位。
 *
 * 白名单只放「产品文件名」这类故意保持原样的字符串。
 *
 * 用法：node tools/measure_language.mjs
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");
const SIM = resolve(PANEL, "__sim_lang.html");

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

const stub = `
<pre id="out"></pre>
<script>
window.__SIM_ERRORS = [];
window.__SIM = { catalog: 0, lastExpr: "" };
window.addEventListener("error", function (e) { window.__SIM_ERRORS.push(String(e.message)); });

Bridge.getExtensionPath = function (cb) { cb("file:///sim/panel"); };
Bridge.evalAE = function (jsx, cb) { if (cb) cb("__NOT_CEP__"); };
Bridge.getDocsPath = function (cb) { cb(""); };
Bridge.listFiles = function (dir, pat, cb) { cb("NO_DIR"); };
Bridge.watchStamp = function (p, cb) { if (cb) cb("x"); };
Bridge.runEngine = function (path, expr, cb) {
  var out = '{"status":"ok"}';
  try {
    window.__SIM.lastExpr = expr;
    window.__SIM.lastExpr = expr;
    if (expr.indexOf("AEV_Catalog.getCatalogJson") === 0) {
      window.__SIM.catalog++;
      out = '{"status":"ok","effects":[],"categories":[]}';
    } else if (expr.indexOf("AEV_Curve.snapshotJson") === 0) {
      out = '{"status":"ok","props":[],"comp":"","time":0}';
    } else if (expr.indexOf("AEV_Queue.stats") === 0) {
      out = '{"total":0,"pending":0,"rendering":0,"cached":0,"failed":0}';
    } else if (expr.indexOf("AEV_Queue.listJson") === 0) {
      out = '{"items":[]}';
    } else if (expr.indexOf("AEV_Presets.listJson") === 0) {
      out = '{"status":"ok","items":[],"folder":""}';
    } else if (expr.indexOf("AEV_PresetPreview.backgroundsJson") === 0) {
      out = '{"items":[]}';
    } else if (expr.indexOf("AEV_PreviewGen.staleList") === 0) {
      out = '{"stale":[]}';
    }
  } catch (e) { out = "ERR:" + e; }
  if (cb) setTimeout(function () { cb(out); }, 0);
};
</script>
`;

const probe = `
<script>
var R = { steps: [] };

function wait(ms, fn) { setTimeout(fn, ms); }

var CJK = /[\\u3000-\\u303f\\u4e00-\\u9fa5\\uff00-\\uffef]/;
/* 产品文件名故意保持中文：发行包里就是这个名字 */
var ALLOW = [/生成插件预设预览\\.bat/];

function allowed(text) {
  for (var i = 0; i < ALLOW.length; i++) if (ALLOW[i].test(text)) return true;
  return false;
}

function visible(el) {
  while (el && el !== document.documentElement) {
    var style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    el = el.parentElement;
  }
  return true;
}

function describe(el) {
  if (!el) return "?";
  var tag = el.tagName ? el.tagName.toLowerCase() : "?";
  var id = el.id ? "#" + el.id : "";
  var cls = el.className && typeof el.className === "string"
    ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".")
    : "";
  return tag + id + cls;
}

function scan(label) {
  var found = [];
  var seen = {};

  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
  var node;
  while ((node = walker.nextNode())) {
    var text = String(node.nodeValue || "").trim();
    if (!text || !CJK.test(text)) continue;
    if (allowed(text)) continue;
    var el = node.parentElement;
    if (!el) continue;
    /* option 在 select 收起时也算“界面上的字”，不按可见性过滤 */
    if (el.tagName !== "OPTION" && !visible(el)) continue;
    var key = describe(el) + "|" + text.slice(0, 40);
    if (seen[key]) continue;
    seen[key] = 1;
    found.push({ where: describe(el), kind: "text", text: text.slice(0, 60) });
  }

  var attrs = ["title", "aria-label", "placeholder"];
  var nodes = document.querySelectorAll("[title],[aria-label],[placeholder]");
  for (var i = 0; i < nodes.length; i++) {
    for (var a = 0; a < attrs.length; a++) {
      var v = nodes[i].getAttribute(attrs[a]);
      if (!v || !CJK.test(v)) continue;
      if (allowed(v)) continue;
      if (!visible(nodes[i])) continue;
      var k2 = describe(nodes[i]) + "|" + attrs[a] + "|" + v.slice(0, 40);
      if (seen[k2]) continue;
      seen[k2] = 1;
      found.push({ where: describe(nodes[i]), kind: attrs[a], text: v.slice(0, 60) });
    }
  }

  R.steps.push({ label: label, found: found, count: found.length });
  return found;
}

function click(id) {
  var el = document.getElementById(id);
  if (el) el.click();
  return !!el;
}

function run() {
  R.errors = window.__SIM_ERRORS;

  /* 切到英文 */
  click("btnSettings");
  wait(300, function () {
    R.langBefore = document.documentElement.getAttribute("lang");
    click("langEn");
    wait(300, function () {
      R.langAfter = document.documentElement.getAttribute("lang");
      R.zhActive = document.getElementById("langZh").className;
      R.enActive = document.getElementById("langEn").className;

      /* 设置抽屉：现在就应该是英文 */
      scan("设置抽屉");
      click("btnSettingsClose");

      wait(200, function () {
        /* 效果墙（默认视图） */
        document.getElementById("tabEffects").click();
        wait(250, function () {
          /* 分支里没有 data/previews.tsv，卡片渲染不出来 —— 卡片上的文案
             由主工作副本（有真实索引）跑同一个脚本覆盖。这里记数只为佐证。 */
          R.cardCount = document.querySelectorAll(".effect-card").length;
          scan("效果墙");

          /* 队列抽屉 */
          click("btnQueue");
          wait(200, function () {
            scan("队列抽屉");
            click("btnQueueClose");

            wait(200, function () {
              /* 预设视图 */
              document.getElementById("tabPresets").click();
              wait(300, function () {
                scan("预设视图");

                /* 曲线视图 */
                document.getElementById("tabCurve").click();
                wait(400, function () {
                  scan("曲线视图");

                  /* 曲线视图下再开一次设置，确认切视图后仍然英文 */
                  click("btnSettings");
                  wait(250, function () {
                    scan("曲线视图 + 设置");
                    click("btnSettingsClose");

                    wait(200, function () {
                      /* 切回中文，抽查是否恢复 */
                      click("btnSettings");
                      wait(200, function () {
                        click("langZh");
                        wait(300, function () {
                          R.backToZh = {
                            tab: document.getElementById("tabEffects").textContent.trim(),
                            settingsTitle: document.querySelector("#settingsDrawer h3").textContent.trim(),
                            apply: document.getElementById("curveApply").textContent.trim()
                          };
                          R.errorsFinal = window.__SIM_ERRORS;
                          document.getElementById("out").textContent = JSON.stringify(R);
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

wait(1000, run);
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
      "--virtual-time-budget=16000",
      "file:///" + SIM.replace(/\\/g, "/"),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
} finally {
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

console.log("=== 语言覆盖实测 ===");
console.log("<html lang> " + data.langBefore + " → " + data.langAfter);
for (const step of data.steps) {
  console.log(step.label.padEnd(14) + " 残留 " + step.count);
  for (const f of step.found) {
    console.log("    [" + f.kind + "] " + f.where + "  →  " + f.text);
  }
}
console.log("效果卡片：" + data.cardCount + " 张（分支无运行时索引时为空，卡片文案由主副本覆盖）");
console.log("切回中文：" + JSON.stringify(data.backToZh));
console.log("页面错误：" + JSON.stringify(data.errorsFinal || []));
console.log("");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("[PASS] " + name);
  } catch (e) {
    failed++;
    console.log("[FAIL] " + name);
    console.log("       " + String(e.message || e).split("\n").slice(0, 6).join("\n       "));
  }
}

const total = data.steps.reduce((n, s) => n + s.count, 0);

check("点 EN 后 <html lang> 变成 en，按钮高亮跟着走", () => {
  assert.equal(data.langAfter, "en", "<html lang> 没切到 en");
  assert.match(data.enActive, /active/, "EN 按钮没有高亮");
  assert.doesNotMatch(data.zhActive, /active/, "中文按钮还亮着");
});

check("英文模式下界面没有中文残留", () => {
  const bad = data.steps.filter((s) => s.count > 0);
  const lines = bad.map((s) => s.label + ": " + s.found
    .map((f) => "[" + f.kind + "] " + f.where + " → " + f.text).join(" | "));
  assert.equal(total, 0, "还有 " + total + " 处中文：\n       " + lines.join("\n       "));
});

check("切回中文能恢复（切换不是单向的）", () => {
  assert.equal(data.backToZh.tab, "效果预览", "tab 没恢复中文：" + data.backToZh.tab);
  assert.equal(data.backToZh.settingsTitle, "设置", "设置标题没恢复：" + data.backToZh.settingsTitle);
  assert.equal(data.backToZh.apply, "应用", "应用按钮没恢复：" + data.backToZh.apply);
});

check("全流程没有 JS 错误", () => {
  // ResizeObserver 的「loop completed」是浏览器提示级告警，不是我们的异常；
  // 真正的问题（null.addEventListener 之类）不会被这条过滤掉。
  const real = (data.errorsFinal || []).filter((e) => e.indexOf("ResizeObserver") < 0);
  assert.equal(real.length, 0, real.join("; "));
});

console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}`);
if (failed > 0) process.exitCode = 1;
