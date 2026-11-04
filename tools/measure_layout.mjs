#!/usr/bin/env node
/* ============================================================
 * measure_layout.mjs —— 用无头浏览器实测面板布局
 *
 * 背景：面板布局的问题（侧栏滚动条过长、格子随面板比例变形、
 * 窄面板把主区挤没）靠肉眼很难判断在不同比例下是否成立。
 *
 * 这里用 Chrome 无头模式加载**真实的 style.css**，
 * 在多个容器宽度 × 多个滑块档位下测量卡片实际渲染宽度，
 * 断言两件事：
 *   1. 格子宽度由滑块决定，不随面板宽度变（滑块必须真的有用）
 *   2. 任何组合下都不横向溢出（预览不能被挤没）
 *
 * 用法：node tools/measure_layout.mjs
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const ROOT = resolve(import.meta.dirname, "..");
const TMP = resolve(ROOT, ".workbuddy/layout-test");
const PANEL_WIDTHS = [200, 260, 320, 420, 600, 900, 1400, 2000];
const THUMB_SIZES = [96, 132, 180, 240, 280];

/* ---- 找浏览器 ---- */
function findChrome() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
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

mkdirSync(TMP, { recursive: true });

/* ---- 生成测量页：真实 style.css + 真实网格结构 ---- */
const cards = Array.from(
  { length: 12 },
  (_, i) =>
    `<button class="effect-card"><div class="thumb"></div><div class="card-copy"><span class="card-name">E${i}</span></div></button>`,
).join("");

const page = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<link rel="stylesheet" href="../../cep/com.dreamengine.panel/css/style.css"/>
<style>body{overflow:visible;height:auto}.workspace{height:auto}</style>
</head><body>
<div class="workspace" id="probe">
  <aside class="sidebar"><ul class="category-list">
    <li><button class="category-item active"><span class="category-label">全部分类</span><span class="category-count">211</span></button></li>
  </ul></aside>
  <main id="main"><div class="grid" id="grid">${cards}</div></main>
</div>
<pre id="out"></pre>
<script>
/* 复刻面板侧的滑块限制逻辑（library.js 的 setThumbSize），
   验证「滑块标多少、格子就是多少」。 */
function availableWidth() {
  const main = document.getElementById("main");
  const style = getComputedStyle(main);
  const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const w = main.clientWidth - pad;
  return (!w || w <= 0) ? 280 : Math.floor(w);
}
function applyThumb(requested) {
  const limit = Math.max(96, Math.min(280, availableWidth()));
  const value = Math.max(96, Math.min(requested, limit));
  document.documentElement.style.setProperty("--thumb-size", value + "px");
  return { value, limit };
}

const out = [];
for (const tw of ${JSON.stringify(THUMB_SIZES)}) {
  for (const w of ${JSON.stringify(PANEL_WIDTHS)}) {
    const p = document.getElementById("probe");
    p.style.width = w + "px";
    void p.offsetHeight;
    const applied = applyThumb(tw);
    void p.offsetHeight;

    const grid = document.getElementById("grid");
    const gw = grid.getBoundingClientRect().width;
    const sw = grid.scrollWidth;
    const card = grid.querySelector(".effect-card").getBoundingClientRect().width;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length;
    out.push([tw, w, Math.round(card * 100) / 100, Math.round(gw), cols, sw > gw + 1 ? "OVERFLOW" : "ok", applied.value].join("|"));
  }
}
document.getElementById("out").textContent = out.join("\\n");
</script></body></html>`;

const pagePath = resolve(TMP, "measure.html");
writeFileSync(pagePath, page, "utf8");

/* ---- 跑无头浏览器取结果 ---- */
const dom = execFileSync(
  browser,
  [
    "--headless",
    "--disable-gpu",
    "--dump-dom",
    "--virtual-time-budget=4000",
    "file:///" + pagePath.replace(/\\/g, "/"),
  ],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
);

const rows = [];
const block = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
if (block) {
  for (const line of block[1].split("\n")) {
    const parts = line.trim().split("|");
    if (parts.length === 7) {
      rows.push({
        thumb: Number(parts[0]),
        panel: Number(parts[1]),
        cardW: Number(parts[2]),
        gridW: Number(parts[3]),
        cols: Number(parts[4]),
        overflow: parts[5] === "OVERFLOW",
        applied: Number(parts[6]),
      });
    }
  }
}

if (!rows.length) {
  console.error("没拿到测量结果");
  process.exit(1);
}

/* ---- 断言 ---- */
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("[PASS] " + name);
  } catch (e) {
    failed++;
    console.log("[FAIL] " + name);
    console.log("       " + String(e.message || e).split("\n").slice(0, 8).join("\n       "));
  }
}

check("格子宽度由滑块决定，不随面板宽度变化", () => {
  for (const thumb of THUMB_SIZES) {
    // 挑出「滑块未被迫降档」的宽度（>=600px 时可用宽度足够放下最大档 280px）
    const wide = rows.filter(
      (r) => r.thumb === thumb && r.panel >= 600 && r.cardW > 0,
    );
    assert.ok(wide.length >= 3, "样本不足");
    const widths = new Set(wide.map((r) => r.cardW));
    assert.equal(
      widths.size,
      1,
      `thumb-size=${thumb} 时卡片宽度出现多种取值：${[...widths].join(", ")}（面板宽度 600-2000）`,
    );
    // 卡片宽度应当正好等于滑块收敛值
    for (const r of wide) {
      assert.equal(
        r.cardW,
        r.applied,
        `thumb=${thumb} 面板=${r.panel}: 应为 ${r.applied}，实际 ${r.cardW}`,
      );
    }
  }
});

check("滑块标多少，格子就是多少（不允许标 280 实际 276）", () => {
  for (const r of rows) {
    // 极窄面板下 CSS 的 min(…,100%) 兜底会进一步压缩格子（否则横向溢出），
    // 这是预期行为；只要不超过滑块值即可。
    assert.ok(
      r.cardW <= r.applied,
      `thumb=${r.thumb} 面板=${r.panel}: 格子 ${r.cardW} 超过了滑块收敛值 ${r.applied}`,
    );
    // 容器装得下时必须严格相等
    if (r.panel >= 320) {
      assert.equal(
        r.cardW,
        r.applied,
        `thumb=${r.thumb} 面板=${r.panel}: 滑块收敛到 ${r.applied}，实际格子 ${r.cardW}`,
      );
    }
  }
});

check("滑块档位越大，卡片越大", () => {
  const at = (thumb, panel) =>
    rows.find((r) => r.thumb === thumb && r.panel === panel).cardW;
  const panel = 1400;
  let prev = 0;
  for (const thumb of THUMB_SIZES) {
    const w = at(thumb, panel);
    assert.ok(w > prev, `thumb-size=${thumb} 的卡片(${w}) 应大于上一档(${prev})`);
    prev = w;
  }
});

check("面板变宽时每行卡片数增加（而不是卡片变大）", () => {
  for (const thumb of THUMB_SIZES) {
    const narrow = rows.find((r) => r.thumb === thumb && r.panel === 420);
    const wide = rows.find((r) => r.thumb === thumb && r.panel === 2000);
    assert.ok(
      wide.cols > narrow.cols,
      `thumb-size=${thumb}: 面板 420px ${narrow.cols} 列 -> 2000px ${wide.cols} 列`,
    );
    // 宽度应当跟随「滑块收敛后的值」而不是原始档位：
    // 面板不够宽时滑块会自动降档（这是预期行为）。
    assert.equal(
      wide.cardW,
      wide.applied,
      `thumb-size=${thumb}: 宽面板下卡片应为 ${wide.applied}，实际 ${wide.cardW}`,
    );
    assert.equal(
      narrow.cardW,
      narrow.applied,
      `thumb-size=${thumb}: 窄面板下卡片应为 ${narrow.applied}，实际 ${narrow.cardW}`,
    );
  }
});

check("列数符合「可用宽度 ÷ (格子宽 + 间距)」", () => {
  for (const r of rows) {
    const expected = Math.max(
      1,
      Math.floor((r.gridW + 10) / (r.cardW + 10)),
    );
    assert.equal(
      r.cols,
      expected,
      `thumb=${r.thumb} 面板=${r.panel}: 实际 ${r.cols} 列，按宽度算应为 ${expected} 列`,
    );
  }
});

check("任何组合下都不横向溢出", () => {
  const bad = rows.filter((r) => r.overflow);
  assert.equal(
    bad.length,
    0,
    "以下组合出现横向溢出：\n" +
      bad.map((r) => `  thumb=${r.thumb} panel=${r.panel}`).join("\n"),
  );
});

check("极窄面板（200px）仍能显示预览", () => {
  for (const thumb of THUMB_SIZES) {
    const r = rows.find((x) => x.thumb === thumb && x.panel === 200);
    assert.ok(r.cardW > 40, `thumb=${thumb} 在 200px 面板下卡片只剩 ${r.cardW}px`);
    assert.ok(r.cols >= 1, `thumb=${thumb} 在 200px 面板下没有可显示的列`);
  }
});

/* ---- 报告 ---- */
console.log(`\n测量：${THUMB_SIZES.length} 档滑块 × ${PANEL_WIDTHS.length} 种面板宽度 = ${rows.length} 组`);
console.log("\n各滑块档位下的卡片宽度（面板 420 → 2000px）：");
for (const thumb of THUMB_SIZES) {
  const line = PANEL_WIDTHS.filter((w) => w >= 420).map((w) => {
    const r = rows.find((x) => x.thumb === thumb && x.panel === w);
    return `${w}px:${r.cardW}px/${r.cols}列`;
  });
  console.log(`  ${String(thumb).padStart(3)}px -> ${line.join("  ")}`);
}

try {
  unlinkSync(pagePath);
} catch (e) {}

console.log(`\n${rows.length > 0 && failed === 0 ? "全部通过" : failed + " 项失败"}`);
if (failed > 0) process.exitCode = 1;
