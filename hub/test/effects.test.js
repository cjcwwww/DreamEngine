/* ============================================================
 * effects.js / effect_favorites.js 纯逻辑断言
 *
 * 全部使用临时目录构造四份数据文件，不读写真实用户目录，
 * 也不需要 Electron 或 After Effects：
 *   · 内置（L1 manifest）+ 插件（plugin_manifest）合并顺序与计数
 *   · 目录里待渲染 / 黑名单条目显示为占位（hasPreview:false）
 *   · 扫描启发式漏判的 AE 自带效果归回「AE 内置」分组
 *   · 收藏按 matchName 读写
 *   · clearPreview：删索引行与专属帧、保留共用拼图、回到待渲染
 *
 * 运行：npm test（或 node --test test/effects.test.js）
 * ============================================================ */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const effects = require("../core/effects");
const effectFavorites = require("../core/effect_favorites");
const { createPaths } = require("../core/paths");

const CATALOG_HEADER = "matchName\tdisplayName\tcategory\tplugin\texcluded\treason\tnoPreview";

function writeJson(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 1), "utf8");
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effects-"));
  const docs = path.join(root, "docs");
  const appData = path.join(root, "appdata");
  const paths = createPaths({ docsDir: docs, appData });
  fs.mkdirSync(path.join(paths.dataDir, "frames"), { recursive: true });
  fs.mkdirSync(paths.probe, { recursive: true });

  /* 内置效果：L1 8x8 整网的两个条目（一个 2 帧动图、一个单帧静图） */
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 1,
    cellSize: 64,
    columns: 2,
    width: 128,
    height: 64,
    sheets: [
      { index: 0, src: "frames/builtin_%04d.png" },
      { index: 1, src: "frames/static_%04d.png" },
    ],
    items: [
      { matchName: "ADBE Gaussian Blur", sheet: 0, x: 0, y: 0, frames: 2 },
      { matchName: "ADBE Ramp", sheet: 1, x: 0, y: 0, frames: 1 },
    ],
  });
  for (const file of ["builtin_0000.png", "builtin_0001.png", "static_0000.png"]) {
    fs.writeFileSync(path.join(paths.dataDir, "frames", file), "png");
  }

  /* 双语名字表：pluginHint=内置 的分类用于把 Keylight 等归回 AE 内置 */
  writeJson(path.join(paths.dataDir, "names.json"), {
    version: 1,
    items: [
      { matchName: "ADBE Gaussian Blur", nameZh: "高斯模糊", nameEn: "Gaussian Blur", categoryZh: "模糊和锐化", categoryEn: "Blur & Sharpen", pluginHint: "内置" },
      { matchName: "ADBE Ramp", nameZh: "渐变", nameEn: "Ramp", categoryZh: "生成", categoryEn: "Generate", pluginHint: "内置" },
      { matchName: "BCC_GLOW", nameZh: "BCC 发光", nameEn: "BCC Glow", categoryZh: "光效", categoryEn: "Glow", pluginHint: "BCC" },
    ],
  });

  /* Hub 已生成的插件预览：两条共用同一张拼图 */
  writeJson(paths.pluginManifest, {
    version: 1,
    items: [
      { matchName: "BCC_GLOW", frames: 2, sliceCellSize: 64, sliceColumns: 2, x: 0, y: 0, src: "frames/bcc_sheet.png", frameSrc: "frames/bcc_%04d.png" },
      { matchName: "BCC_OTHER", frames: 1, sliceCellSize: 64, sliceColumns: 1, x: 64, y: 0, src: "frames/bcc_sheet.png", frameSrc: "frames/other_0000.png" },
    ],
  });
  for (const file of ["bcc_sheet.png", "bcc_0000.png", "bcc_0001.png", "other_0000.png"]) {
    fs.writeFileSync(path.join(paths.dataDir, "frames", file), "png");
  }

  /* AE 扫描目录：已渲染、待渲染、黑名单、以及被启发式误判成第三方的 AE 自带效果 */
  fs.writeFileSync(
    paths.pluginCatalog,
    [
      CATALOG_HEADER,
      "BCC_GLOW\tBCC Glow\t光效\tBCC\t0\t\t0",
      "BCC_PENDING\tBCC Pending\t光效\tBCC\t0\t\t0",
      "BCC_BLOCKED\tBCC Blocked\t光效\tBCC\t0\t\t0",
      "Keylight 906\tKeylight\t生成\t其它插件\t0\t\t0",
    ].join("\r\n") + "\r\n",
    "utf8",
  );
  writeJson(path.join(paths.dataDir, "plugin_blacklist.json"), {
    version: 1,
    items: [{ matchName: "BCC_BLOCKED", reason: "crash" }],
  });

  return { root, paths };
}

test("effects.list：内置 + 插件合并、计数与占位状态", () => {
  const { paths } = makeWorkspace();
  const lib = effects.list(paths);

  assert.equal(lib.ok, true);
  assert.equal(lib.counts.total, 7);
  assert.equal(lib.counts.builtin, 3);
  assert.equal(lib.counts.plugin, 4);
  assert.equal(lib.counts.rendered, 4);
  assert.equal(lib.counts.pending, 3);

  const byName = new Map(lib.items.map((item) => [item.matchName, item]));
  assert.deepEqual(byName.get("ADBE Gaussian Blur").name, "高斯模糊");
  assert.equal(byName.get("ADBE Gaussian Blur").frames, 2);
  assert.equal(byName.get("ADBE Gaussian Blur").animated, true);

  /* 已生成预览的插件条目 */
  const glow = byName.get("BCC_GLOW");
  assert.equal(glow.source, "plugin");
  assert.equal(glow.hasPreview, true);
  assert.equal(glow.renderable, true);
  assert.equal(glow.generated, true);

  /* 目录里还没渲染的条目：占位、可渲染、待渲染 */
  const pending = byName.get("BCC_PENDING");
  assert.equal(pending.hasPreview, false);
  assert.equal(pending.status, "pending");
  assert.equal(pending.renderable, true);
  assert.equal(pending.frames, 0);

  /* 黑名单条目：占位并带原因 */
  const blocked = byName.get("BCC_BLOCKED");
  assert.equal(blocked.status, "blacklisted");
  assert.equal(blocked.reason, "crash");

  /* 名字表标为内置的分类：Keylight 归回 AE 内置分组 */
  const keylight = byName.get("Keylight 906");
  assert.equal(keylight.source, "builtin");
  assert.equal(keylight.plugin, "内置");

  /* 内置严格按 manifest 顺序 */
  assert.deepEqual(
    lib.items.slice(0, 2).map((item) => item.matchName),
    ["ADBE Gaussian Blur", "ADBE Ramp"],
  );
});

test("effect_favorites：缺失/损坏文件退化为空，切换按 matchName 落盘", () => {
  const { paths } = makeWorkspace();
  assert.deepEqual(effectFavorites.read(paths).items, []);

  let result = effectFavorites.toggle(paths, "BCC_GLOW");
  assert.equal(result.ok, true);
  assert.equal(result.favorite, true);
  assert.deepEqual(effectFavorites.read(paths).items, ["BCC_GLOW"]);

  const lib = effects.list(paths);
  const glow = lib.items.find((item) => item.matchName === "BCC_GLOW");
  assert.equal(glow.favorite, true);

  result = effectFavorites.toggle(paths, "BCC_GLOW");
  assert.equal(result.favorite, false);
  assert.deepEqual(effectFavorites.read(paths).items, []);

  fs.writeFileSync(paths.effectFavorites, "{not json", "utf8");
  assert.deepEqual(effectFavorites.read(paths).items, []);
});

test("effects.clearPreview：删索引与专属帧、保留共用拼图、回到待渲染", () => {
  const { paths } = makeWorkspace();
  const result = effects.clearPreview(paths, "BCC_GLOW");

  assert.equal(result.ok, true);
  assert.equal(result.removed, 1);
  assert.ok(result.deleted >= 2);
  assert.equal(fs.existsSync(path.join(paths.dataDir, "frames", "bcc_0000.png")), false);
  assert.equal(fs.existsSync(path.join(paths.dataDir, "frames", "bcc_0001.png")), false);
  /* 仍被 BCC_OTHER 引用的拼图不能删 */
  assert.equal(fs.existsSync(path.join(paths.dataDir, "frames", "bcc_sheet.png")), true);
  assert.equal(fs.existsSync(path.join(paths.dataDir, "frames", "other_0000.png")), true);

  const remaining = JSON.parse(fs.readFileSync(paths.pluginManifest, "utf8")).items;
  assert.deepEqual(remaining.map((item) => item.matchName), ["BCC_OTHER"]);

  /* 清空后回到待渲染占位 */
  const lib = effects.list(paths);
  const glow = lib.items.find((item) => item.matchName === "BCC_GLOW");
  assert.equal(glow.hasPreview, false);
  assert.equal(glow.status, "pending");

  assert.equal(effects.clearPreview(paths, "BCC_GLOW").reason, "not_found");
  assert.equal(effects.clearPreview(paths, "").reason, "invalid_match_name");
});