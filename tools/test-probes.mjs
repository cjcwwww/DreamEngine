#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");

function read(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

function loadPickPngTemplate() {
  const source = read("probes/T0_2_渲染耗时探针.jsx");
  const match = source.match(/function pickPngTemplate\(om\) \{[\s\S]*?\n    \}/);
  assert.ok(match, "T0_2 must define pickPngTemplate()");

  const context = {};
  vm.runInNewContext(
    match[0] + "\nthis.pickPngTemplate = pickPngTemplate;",
    context,
  );
  return context.pickPngTemplate;
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("T0_2 selects a PNG output template", () => {
  const pickPngTemplate = loadPickPngTemplate();
  assert.equal(
    pickPngTemplate({
      templates: ["Multi-Machine Sequence", "PNG Sequence"],
    }),
    "PNG Sequence",
  );
});

test("T0_2 refuses to fall back to a non-PNG template", () => {
  const pickPngTemplate = loadPickPngTemplate();
  assert.equal(
    pickPngTemplate({
      templates: ["多机序列", "Photoshop"],
    }),
    null,
  );
});

test("T0_2 uses the real Colorama matchName", () => {
  const source = read("probes/T0_2_渲染耗时探针.jsx");
  assert.match(source, /"APC Colorama"/);
  assert.doesNotMatch(source, /"ADBE CC Colorama"/);
});

test("T0_2 defaults to the 8x8 target render profile", () => {
  const source = read("probes/T0_2_渲染耗时探针.jsx");
  assert.match(source, /var GRID_COLS = 8;/);
  assert.match(source, /var GRID_CELL = 256;/);
  assert.match(source, /var GRID_FRAMES = 6;/);
});

test("T0_2 places 16 effects in the contact sheet", () => {
  const source = read("probes/T0_2_渲染耗时探针.jsx");
  const listMatch = source.match(/var SINGLE_LIST = \[([\s\S]*?)\];/);
  assert.ok(listMatch, "T0_2 must define SINGLE_LIST");
  const effectNames = [...listMatch[1].matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.equal(effectNames.length, 16);
  assert.equal(new Set(effectNames).size, 16);
});

test("T0_2 fills every contact sheet cell", () => {
  const source = read("probes/T0_2_渲染耗时探针.jsx");
  assert.match(source, /var cellCount = GRID_COLS \* GRID_COLS;/);
  assert.match(
    source,
    /var effectName = SINGLE_LIST\[gi % SINGLE_LIST\.length\];/,
  );
  assert.match(source, /for \(var gi = 0; gi < cellCount; gi\+\+\)/);
});

test("T0_2 clears stale outputs before measuring mode A", () => {
  const source = read("probes/T0_2_渲染耗时探针.jsx");
  assert.match(
    source,
    /clearTmp\(tmpDir\);\s*\n\s*\/\/ ---------- 模式 A/,
  );
});

test("T0_2 measures only PNG output files", () => {
  const source = read("probes/T0_2_渲染耗时探针.jsx");
  assert.match(source, /dir\.getFiles\("\*\.png"\)/);
});

test("T0_2 writes its report as UTF-8", () => {
  const source = read("probes/T0_2_渲染耗时探针.jsx");
  assert.match(source, /outFile\.encoding = "UTF-8";/);
});

test("T0_7 records that AE 2021 aerender has no -r option", () => {
  const doc = read("T0_7_aerender命令行说明.md");
  assert.match(doc, /aerender 18\.4\.1 不支持 `-r`/);
});

test("T0_4 keeps distinct Chinese preset names in output files", () => {
  const source = read("probes/T0_4_预设应用探针.jsx");
  assert.doesNotMatch(source, /replace\(\/\[\^A-Za-z0-9_\\-\\\]\/g, ""\)/);
  assert.match(source, /var presetSafe = preset\.name\.replace/);
  assert.match(source, /T0_4_预设应用_" \+ presetSafe/);
  assert.match(source, /outFile\.encoding = "UTF-8";/);
});

test("T0_6 writes its import report as UTF-8", () => {
  const source = read("probes/T0_6_导入入口探针.jsx");
  assert.match(source, /outFile\.encoding = "UTF-8";/);
});

test("M0 render parameters match the finalized 8x8 profile", () => {
  const source = read("config/render_params.jsxinc");
  assert.match(source, /var DREAM_ENGINE_RENDER_CONFIG =/);
  assert.match(source, /columns: 8,/);
  assert.match(source, /cellSize: 256,/);
  assert.match(source, /width: 2048,/);
  assert.match(source, /frameCount: 6,/);
  assert.match(source, /aerenderConcurrency: 1,/);
});

test("M0 probes and render settings use DreamEngine names", () => {
  const probeFiles = [
    "probes/T0_1_效果枚举探针.jsx",
    "probes/T0_2_渲染耗时探针.jsx",
    "probes/T0_2_prepare_aerender.jsx",
    "probes/T0_4_预设应用探针.jsx",
    "probes/T0_5_参数读取探针.jsx",
    "probes/T0_6_导入入口探针.jsx",
    "probes/T0_8_全量dump探针.jsx",
  ];
  for (const file of probeFiles) {
    assert.match(read(file), /DreamEngineProbe/);
  }

  const config = read("config/render_params.jsxinc");
  assert.match(config, /pngOutputTemplate: "DreamEngine PNG Sequence"/);
  assert.doesNotMatch(config, /legacyPngOutputTemplate/);
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
