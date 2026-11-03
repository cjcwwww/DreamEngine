#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");

function read(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("M1 names data is a unique matchName map", () => {
  const data = readJson("cep/com.dreamengine.panel/data/names.json");
  assert.ok(Array.isArray(data.items));
  assert.ok(data.items.length >= 500);
  const keys = data.items.map((item) => item.matchName);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("ADBE Gaussian Blur 2"));
  assert.ok(keys.includes("ScriptEP"));
});

test("M1 manifest contains 20 previews on a 2048 sheet", () => {
  const manifest = readJson("cep/com.dreamengine.panel/data/manifest.json");
  assert.equal(manifest.cellSize, 256);
  assert.equal(manifest.columns, 8);
  assert.equal(manifest.width, 2048);
  assert.equal(manifest.height, 2048);
  assert.equal(manifest.items.length, 20);
  assert.ok(
    existsSync(
      resolve(PANEL, "data", manifest.sheets[0].src),
    ),
  );
});

function loadViewModel() {
  const source = read("cep/com.dreamengine.panel/js/viewmodel.js");
  const context = {};
  vm.runInNewContext(
    source + "\nthis.AEV_ViewModel = AEV_ViewModel;",
    context,
  );
  return context.AEV_ViewModel;
}

test("M1 bilingual name resolution falls back to English", () => {
  const view = loadViewModel();
  assert.equal(
    view.resolveName(
      { nameZh: "高斯模糊", nameEn: "Gaussian Blur", displayName: "本机名" },
      "zh",
    ),
    "高斯模糊",
  );
  assert.equal(
    view.resolveName(
      { nameZh: null, nameEn: "BCC Glow", displayName: "BCC Glow" },
      "zh",
    ),
    "BCC Glow",
  );
});

test("M1 plugin inference distinguishes builtin, BCC and Sapphire", () => {
  const view = loadViewModel();
  assert.equal(
    view.inferPlugin({ matchName: "ADBE Glo2", category: "风格化" }),
    "内置",
  );
  assert.equal(
    view.inferPlugin({ matchName: "BCC Glow", category: "BCC Lights" }),
    "BCC",
  );
  assert.equal(
    view.inferPlugin({ matchName: "S_Glow", category: "Sapphire Lighting" }),
    "Sapphire",
  );
});

test("M1 search matches localized names and filters plugins", () => {
  const view = loadViewModel();
  const items = [
    {
      matchName: "ADBE Glo2",
      displayName: "发光",
      nameZh: "发光",
      nameEn: "Glow",
      category: "风格化",
      categoryZh: "风格化",
      categoryEn: "Stylize",
      plugin: "内置",
      hasPreview: true,
    },
    {
      matchName: "BCC Glow",
      displayName: "BCC Glow",
      nameZh: null,
      nameEn: "BCC Glow",
      category: "BCC Lights",
      categoryZh: "BCC Lights",
      categoryEn: "BCC Lights",
      plugin: "BCC",
      hasPreview: false,
    },
  ];
  assert.deepEqual(
    Array.from(
      view.filterItems(items, { lang: "zh", query: "发光", plugin: "内置" }),
      (item) => item.matchName,
    ).join(","),
    "ADBE Glo2",
  );
  assert.deepEqual(
    Array.from(
      view.filterItems(items, { lang: "en", query: "bcc", plugin: "全部" }),
      (item) => item.matchName,
    ).join(","),
    "BCC Glow",
  );
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed++;
    console.error(`[FAIL] ${name}`);
    console.error(String(error?.stack || error));
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
