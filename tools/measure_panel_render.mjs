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
window.__SIM_IMPORTS = [];
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
      } else if (expr.indexOf("AEV_Presets.importOneJson") === 0) {
        window.__SIM_IMPORTS.push(expr);
        out = '{"status":"ok","name":"sim"}';
      } else if (expr.indexOf("AEV_Presets.libraryJson") === 0) {
        out = '{"status":"ok","count":2,"folder":"C:/sim","items":[' +
          '{"path":"C:/sim/a.ffx","name":"静态预设","folder":"C:/sim"},' +
          '{"path":"C:/sim/b.ffx","name":"动画预设","folder":"C:/sim"},' +
          '{"path":"C:/sim/c.ffx","name":"插件预设","folder":"C:/sim"}]}';
      } else if (expr.indexOf("AEV_PresetPreview.backgroundsJson") === 0) {
        out = '{"status":"ok","items":[' +
          '{"id":"photo","name":"标准","builtin":true},' +
          '{"id":"text","name":"文字","builtin":true},' +
          '{"id":"solid","name":"纯色","builtin":true},' +
          '{"id":"shape","name":"形状","builtin":true},' +
          '{"id":"pattern","name":"条纹","builtin":true}]}';
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

/* 只数真正看得见的卡片：被隐藏的祖先（display:none）不算 */
function countVisibleCards() {
  var cards = document.querySelectorAll(".effect-card");
  var n = 0;
  for (var i = 0; i < cards.length; i++) {
    var r = cards[i].getBoundingClientRect();
    if (r.width > 0 && r.height > 0) n++;
  }
  return n;
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
        // 卡片是否「可见」：隐藏的元素不算。
        // countCards() 统计 DOM 节点数，隐藏的元素也算 —— 那是另一个问题
        // （DOM 里留着卡片不影响显示，但会让「还剩多少效果」这类统计失真）。
        result.cardsInPresetView = countVisibleCards();
        result.cardsTotalInDom = countCards();
        result.presetCards = document.querySelectorAll(".preset-card").length;
        result.presetThumbs = document.querySelectorAll(".preset-thumb").length;
        result.presetBadges = [].map.call(
          document.querySelectorAll(".preset-badge"),
          function (b) { return String(b.textContent); }
        );
        result.presetThumbImages = [].map.call(
          document.querySelectorAll(".preset-thumb"),
          function (t) { return String(t.style.backgroundImage || "").slice(0, 90); }
        );
        var bgSelect = document.getElementById("presetBackground");
        result.backgroundOptions = bgSelect ? bgSelect.options.length : 0;
        result.presetSummaryText = String(document.getElementById("presetSummary").textContent);

        /* --- 搜索框：点图标展开、再点收起 --- */
        var toggle = document.getElementById("searchToggle");
        var field = document.getElementById("searchField");
        result.searchHiddenInitially = field ? field.hidden : null;
        toggle.click();
        result.searchOpenAfterClick = field ? !field.hidden : null;
        toggle.click();
        result.searchHiddenAfterSecondClick = field ? field.hidden : null;

        /* --- 设置页：齿轮展开 / 收起，四个按钮都搬进去了 --- */
        var settingsBtn = document.getElementById("btnSettings");
        var drawer = document.getElementById("settingsDrawer");
        var topActions = document.querySelector(".top-actions");
        result.settingsHiddenInitially = drawer ? drawer.hidden : null;
        result.settingsButtonsInTopbar = ["langZh", "langEn", "btnGenerate", "btnRefresh", "btnRetry"]
          .filter(function (id) {
            var el = document.getElementById(id);
            return el && topActions && topActions.contains(el);
          });
        settingsBtn.click();
        result.settingsOpenAfterClick = drawer ? !drawer.hidden : null;
        result.settingsVisible = drawer ? drawer.getBoundingClientRect().width > 0 : null;
        result.settingsActions = ["langZh", "langEn", "btnGenerate", "btnRefresh", "btnOpenQueue"]
          .map(function (id) {
            var el = document.getElementById(id);
            return el
              ? { id: id, visible: el.getBoundingClientRect().height > 0 }
              : { id: id, missing: true };
          });
        settingsBtn.click();
        result.settingsHiddenAfterSecondClick = drawer ? drawer.hidden : null;

        /* --- 底栏：塞进最长文案，高度仍必须恒定（不能被撑成两行/竖排）--- */
        var bar = document.querySelector(".statusbar");
        var st = document.getElementById("statusText");
        var qc = document.getElementById("queueCounts");
        var oldStatus = st.textContent;
        var oldQueue = qc.textContent;
        result.statusbarHeightNormal = bar.getBoundingClientRect().height;
        st.textContent = "索引写入失败：在需要数字、数组或属性的位置找到类型为 Error 的对象（很长的错误详情很长的错误详情很长的错误详情）";
        qc.textContent = "0 待渲染 / 0 失败";
        result.statusbarHeightWorst = bar.getBoundingClientRect().height;
        result.queueCountsHeightWorst = qc.getBoundingClientRect().height;
        result.statusHeightWorst = st.getBoundingClientRect().height;
        st.textContent = oldStatus;
        qc.textContent = oldQueue;

        /* --- 添加预设：模拟 CEF 文件框选中「1 个 .ffx + 1 个 .txt」 --- */
        var fileInput = document.getElementById("presetFileInput");
        result.presetFileInputFound = !!fileInput;
        result.presetImportsBefore = window.__SIM_IMPORTS.length;
        if (fileInput) {
          var fake = [
            { name: "夜视.ffx", path: "C:////Users////me////夜视.ffx" },
            { name: "notes.txt", path: "C:////Users////me////notes.txt" }
          ];
          Object.defineProperty(fileInput, "files", { value: fake, configurable: true });
          var ev2 = document.createEvent("HTMLEvents");
          ev2.initEvent("change", true, false);
          fileInput.dispatchEvent(ev2);
        }
        setTimeout(function () {
          result.presetImports = window.__SIM_IMPORTS.slice();
          result.presetStatus = String(document.getElementById("statusText").textContent);
          document.getElementById("out").textContent = JSON.stringify(result);
        }, 600);
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

/* 模拟「已经生成过预览」：一条静态（1 帧）、一条动态（6 帧覆盖关键帧区间）。
   跑完立刻恢复现场，不污染用户真实的预设索引。 */
const presetIndexPath = resolve(runtimeData, "preset_manifest.json");
const hadPresetIndex = existsSync(presetIndexPath);
const originalPresetIndex = hadPresetIndex ? readFileSync(presetIndexPath, "utf8") : null;
const baseEntry = {
  sliceColumns: 1, sliceCellSize: 128, sliceWidth: 128, sliceHeight: 128,
  x: 0, y: 0, width: 128, height: 128, background: "photo", truncated: false,
};
writeFileSync(presetIndexPath, JSON.stringify({
  version: 1,
  items: [
    Object.assign({}, baseEntry, {
      name: "静态预设", path: "C:/sim/a.ffx", sheet: 0,
      src: "thumbs/preset_000_0000.png", frameSrc: "thumbs/preset_000_%04d.png",
      frames: 1, animated: false, keyStart: 0, keyEnd: 0,
    }),
    Object.assign({}, baseEntry, {
      name: "动画预设", path: "C:/sim/b.ffx", sheet: 1,
      src: "thumbs/preset_001_0000.png", frameSrc: "thumbs/preset_001_%04d.png",
      frames: 6, animated: true, keyStart: 0, keyEnd: 2.5,
    }),
  ],
}), "utf8");

const pluginIndexPath = resolve(runtimeData, "preset_plugin_manifest.json");
const hadPluginIndex = existsSync(pluginIndexPath);
const originalPluginIndex = hadPluginIndex ? readFileSync(pluginIndexPath, "utf8") : null;
writeFileSync(pluginIndexPath, JSON.stringify({
  version: 1,
  items: [Object.assign({}, baseEntry, {
    name: "插件预设", path: "C:/sim/c.ffx", sheet: 1000,
    src: "thumbs/preset_1000_0000.png", frameSrc: "thumbs/preset_1000_%04d.png",
    frames: 6, animated: true, keyStart: 0, keyEnd: 2.0,
    plugins: ["S_Glow"], plugin: true,
  })],
}), "utf8");

let dom;
try {
  dom = execFileSync(
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
} finally {
  try { unlinkSync(SIM); } catch (e) {}
  try {
    if (hadPresetIndex) writeFileSync(presetIndexPath, originalPresetIndex, "utf8");
    else unlinkSync(presetIndexPath);
  } catch (e2) {}
  try {
    if (hadPluginIndex) writeFileSync(pluginIndexPath, originalPluginIndex, "utf8");
    else unlinkSync(pluginIndexPath);
  } catch (e3) {}
}

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

check("预设视图里看不到任何效果卡片", () => {
  assert.equal(data.cardsInPresetView, 0, `预设视图里还看得见 ${data.cardsInPresetView} 张效果卡片`);
});

check("切到预设视图时效果卡片已从 DOM 摘掉", () => {
  assert.equal(data.cardsTotalInDom, 0, `DOM 里还留着 ${data.cardsTotalInDom} 张效果卡片`);
});

check("搜索框点图标展开、再点收起", () => {
  assert.equal(data.searchHiddenInitially, true, "初始应是收起的");
  assert.equal(data.searchOpenAfterClick, true, "点一次图标应展开");
  assert.equal(data.searchHiddenAfterSecondClick, true, "再点一次应收起");
});

check("顶栏只剩设置入口，四个按钮都搬进了设置页", () => {
  assert.equal(data.settingsHiddenInitially, true, "设置页初始应该是收起的");
  assert.deepEqual(data.settingsButtonsInTopbar, [], "顶栏里还留着" + JSON.stringify(data.settingsButtonsInTopbar));
  const missing = (data.settingsActions || []).filter((a) => a.missing);
  assert.equal(missing.length, 0, "设置页里缺按钮：" + JSON.stringify(missing));
});

check("设置页能展开、按钮可见、再点一次能收起", () => {
  assert.equal(data.settingsOpenAfterClick, true, "点齿轮没展开");
  assert.equal(data.settingsVisible, true, "设置页展开了但不可见（hidden 被 CSS 盖掉？）");
  for (const a of data.settingsActions || []) {
    assert.equal(a.visible, true, a.id + " 在设置页里不可见");
  }
  assert.equal(data.settingsHiddenAfterSecondClick, true, "再点齿轮没收回");
});

check("底栏在最长文案下高度恒定、内容不竖排", () => {
  assert.equal(data.statusbarHeightNormal, 26, "底栏初始高度不是 26：" + data.statusbarHeightNormal);
  assert.equal(data.statusbarHeightWorst, 26, "长文案把底栏撑高了：" + data.statusbarHeightWorst);
  assert.ok(data.queueCountsHeightWorst <= 20, "队列计数被压成竖排：" + data.queueCountsHeightWorst);
  assert.ok(data.statusHeightWorst <= 20, "状态文字被压成竖排：" + data.statusHeightWorst);
});

check("添加预设：选中的 .ffx 真正走入库，非 .ffx 被过滤", () => {
  assert.equal(data.presetFileInputFound, true, "面板里没有 CEF 文件选择框");
  const imports = data.presetImports || [];
  assert.equal(imports.length - data.presetImportsBefore, 1, "应该只入库 1 个 .ffx，实际：" + JSON.stringify(imports));
  assert.match(imports[0], /夜视\.ffx/, "入库的不是那个 .ffx");
  assert.doesNotMatch(imports[0], /notes\.txt/, ".txt 不该被入库");
  // Windows 反斜杠路径要归一成正斜杠，否则 ExtendScript 侧会当转义符
  assert.doesNotMatch(imports[0], /\\\\Users/, "路径里的反斜杠没归一化：" + imports[0]);
  assert.match(data.presetStatus, /已加入 1 个预设/, "状态栏没报结果：" + data.presetStatus);
});

check("预设预览：静态/动态卡片都显示缩略图，背景可选", () => {
  assert.equal(data.presetCards, 3, "预设卡片数不对：" + data.presetCards);
  assert.equal(data.presetThumbs, 3, "缩略图数量不对：" + data.presetThumbs);
  const badges = data.presetBadges || [];
  assert.ok(badges.some((b) => /静态/.test(b)), "没有静态角标：" + JSON.stringify(badges));
  assert.ok(badges.some((b) => /动态/.test(b)), "没有动态角标：" + JSON.stringify(badges));
  assert.ok(badges.some((b) => /离线生成/.test(b)), "离线插件预设没合并进来：" + JSON.stringify(badges));
  const images = data.presetThumbImages || [];
  assert.equal(images.length, 3);
  assert.ok(images.some((i) => /preset_1000_/.test(i)), "离线条目的帧没挂上：" + JSON.stringify(images));
  for (const img of images) {
    // 面板生成的编号是 3 位，离线通道从 1000 起（4 位）
    assert.match(img, /preset_\d+_\d{4}\.png/, "缩略图没挂上预览帧：" + img);
  }
  assert.ok(data.backgroundOptions >= 5, "背景下拉少于 5 项：" + data.backgroundOptions);
  assert.match(data.presetSummaryText, /已生成 3 张预览/, "统计没更新：" + data.presetSummaryText);
});

console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}`);
if (failed > 0) process.exitCode = 1;
