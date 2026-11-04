#!/usr/bin/env node
/* ============================================================
 * test-engine-load.mjs —— 引擎加载机制的回归
 *
 * 背景：用户报「点进去弹 ERR:ReferenceError: AEV_Catalog 未定义，效果都没了」。
 *
 * 根因：`AEV_EngineStamp` 是 AE 会话里的**全局变量**。bridge 用它做
 * 「文件没变就跳过 evalFile」的缓存。但只要**有一次**加载中途失败（比如
 * 某个模块语法错、或新增模块时旧会话的 stamp 已经被写进去了），
 * 之后无论文件怎么改都会跳过加载 —— 表现就是模块未定义、整个效果库空白，
 * 而且**关掉面板重开也治不好**（AE 会话没重启，stamp 还在）。
 *
 * 修法：除了比对戳，还要校验关键模块是否真的在；缺了就强制重载。
 * 并且逐个 evalFile 各自捕获，让失败原因能明确报出来，
 * 而不是被后面的模块覆盖成「AEV_Catalog 未定义」这种误导性报错。
 *
 * 这里用 vm 模拟 AE 的 evalScript，验证 stamp 与模块缺失两种情况。
 * ============================================================ */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------- 提取 bridge 里的 jsx 字符串 ---------- */

/**
 * 把 bridge.js 里 runEngine 的 jsx 拼装代码抠出来，用一个假的 AE 环境跑。
 *
 * 假的 AE：提供 File（带 exists / modified）、$.evalFile（按模块名
 * 注入对应的全局变量）、app 等。
 */
function extractJsx(source) {
  // runEngine 里第三段 jsx（带引擎模块加载逻辑的那段）：
  // 从「var files = [...]」这一行所在的 var jsx = 开始，
  // 到 evalAE(jsx, cb) 之前结束。
  const marker = '    var files = [" + paths.join(",") + "];" +';
  const markerAt = source.indexOf(marker);
  if (markerAt === -1) throw new Error("找不到 runEngine 的引擎加载片段");

  // 往前找这一段 jsx 的起点（最近的 "var jsx ="）
  const jsxAt = source.lastIndexOf("var jsx =", markerAt);
  if (jsxAt === -1) throw new Error("找不到 jsx 赋值起点");
  const end = source.indexOf("    evalAE(jsx, cb);", markerAt);
  const snippet = source.slice(jsxAt, end);

  // 在一个带 paths 与 expr 的环境里求值，取出拼好的 jsx 字符串。
  // paths 里的每项要自带引号（真实代码里是 JSON.stringify 过的）。
  // 模块列表要与真实 ENGINE_FILES 一致，测试才验得到真实行为。
  const MODULES = [
    "render_config", "store", "names", "assets", "recipe", "apply",
    "previewgen", "queue", "plugin_state", "catalog", "presets",
  ];
  const ctx = vm.createContext({
    paths: MODULES.map((n) => `"/ext/engine/${n}.jsx"`),
    expr: "1 + 1",
  });
  vm.runInContext("var out;" + snippet.replace("var jsx =", "out ="), ctx);
  return { jsx: ctx.out, modules: MODULES };
}

/** 与 MODULES 一致的戳（每个文件一个 modified 时间） */
function stampFor(count) {
  const parts = [];
  for (let i = 0; i < count; i++) parts.push("1000:");
  return parts.join("");
}

/**
 * 构造一个假的 AE 执行环境。
 * modules: 模块名 -> 是否加载成功（失败时抛错）
 * preloaded: 事先已存在的全局变量（模拟「旧会话 stamp 已写入但模块没加载」）
 */
function makeAeEnv(modules, preloaded) {
  const loaded = Object.assign({}, preloaded || {});
  const evalLog = [];
  const env = {
    loaded,
    evalLog,
    File: function (path) {
      this.fsName = String(path);
      this.exists = true;
      this.modified = { getTime: () => 1000 };
    },
    $: {
      evalFile(file) {
        const name = String(file.fsName).split("/").pop().replace(".jsx", "");
        evalLog.push(name);
        if (modules[name] === "fail") {
          throw new Error("SyntaxError in " + name);
        }
        // 模拟 evalFile：模块把全局变量挂出来
        loaded["AEV_" + name.replace(/^(\w)/, (c) => c.toUpperCase())] = true;
      },
    },
    app: {},
  };
  return env;
}

/** 在假环境里执行 bridge 的 jsx */
function runBridgeJsx(jsx, env) {
  const ctx = vm.createContext(env);
  const result = vm.runInContext(jsx, ctx);
  return { result, ctx };
}

test("bridge 的 jsx 能在假 AE 环境里跑通", () => {
  const { jsx } = extractJsx(read("cep/com.dreamengine.panel/js/bridge.js"));
  const env = makeAeEnv({}, {});
  const { result } = runBridgeJsx(jsx, env);
  assert.equal(typeof result, "string");
  assert.ok(!result.startsWith("ERR:"), "不该报错：" + result);
});

test("模块缺失时会强制重载（而不是被 stamp 跳过）", () => {
  const { jsx, modules } = extractJsx(read("cep/com.dreamengine.panel/js/bridge.js"));
  // 模拟「旧会话 stamp 已写入，但模块没加载」：
  // AEV_EngineStamp 存在且等于当前戳，AEV_Catalog 不存在
  const env = makeAeEnv({});
  env.AEV_EngineStamp = stampFor(modules.length);
  const { result } = runBridgeJsx(jsx, env);
  assert.ok(!result.startsWith("ERR:"), "不该报错：" + result);
  // 关键：所有模块都重新加载了一遍
  assert.equal(env.evalLog.length, modules.length, "只加载了 " + env.evalLog.length + " 个模块");
  assert.ok(env.evalLog.includes("catalog"), "catalog 没被重新加载");
  assert.ok(env.evalLog.includes("apply"), "apply 没被重新加载");
});

test("模块齐全且戳没变时跳过重载（保留性能优化）", () => {
  const { jsx, modules } = extractJsx(read("cep/com.dreamengine.panel/js/bridge.js"));
  const env = makeAeEnv({});
  // 关键模块都在，戳也对得上 → 不该重新加载
  env.AEV_EngineStamp = stampFor(modules.length);
  env.AEV_Catalog = true;
  env.AEV_Recipe = true;
  env.AEV_Apply = true;
  env.AEV_Presets = true;
  const { result } = runBridgeJsx(jsx, env);
  assert.ok(!result.startsWith("ERR:"), "不该报错：" + result);
  assert.equal(env.evalLog.length, 0, "戳没变时不该重新加载，却加载了 " + env.evalLog.length + " 个");
});

test("某个模块加载失败时会明确报出是哪个模块", () => {
  const { jsx } = extractJsx(read("cep/com.dreamengine.panel/js/bridge.js"));
  const env = makeAeEnv({ catalog: "fail" });
  const { result } = runBridgeJsx(jsx, env);
  assert.ok(result.startsWith("ERR:"), "应该报错，实际：" + result);
  // 关键：报错要指向 catalog，而不是笼统的「AEV_Catalog 未定义」
  assert.match(result, /catalog/, "报错里应指出失败的是 catalog：" + result);
});

test("失败不影响其余模块加载", () => {
  const { jsx } = extractJsx(read("cep/com.dreamengine.panel/js/bridge.js"));
  const env = makeAeEnv({ catalog: "fail" });
  runBridgeJsx(jsx, env);
  // catalog 挂了，但 recipe / apply / presets 仍应加载成功
  assert.ok(env.evalLog.includes("recipe"), "recipe 没加载");
  assert.ok(env.evalLog.includes("apply"), "apply 没加载");
  assert.ok(env.evalLog.includes("presets"), "presets 没加载");
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
    console.error(String(error?.stack || error));
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
