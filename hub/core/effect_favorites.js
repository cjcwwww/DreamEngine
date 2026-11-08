/* ============================================================
 * effect_favorites.js —— 效果库收藏（按 matchName 持久化）
 *
 * 文件：<userRoot>/effect_favorites.json
 *   { "version": 1, "items": ["BCC_GLOW", "Keylight 906", ...] }
 *
 * 放在用户目录（和 preset_categories.json 同级），升级安装不清空。
 * 只做「读 / 切换」：文件缺失、损坏或字段异常都退化成空收藏，不抛异常。
 * 不依赖 electron：可脱离 GUI 用 Node 直接测。
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");

const VERSION = 1;

function favoritesPath(paths) {
  return paths.effectFavorites || path.join(paths.userRoot, "effect_favorites.json");
}

/** 读收藏：去重、忽略非字符串；缺失/损坏时返回空列表 */
function read(paths) {
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(favoritesPath(paths), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    doc = null;
  }
  const items = [];
  const seen = new Set();
  for (const raw of doc && Array.isArray(doc.items) ? doc.items : []) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    items.push(name);
  }
  return { version: Number(doc && doc.version) || VERSION, items };
}

/** 写收藏：UTF-8 无 BOM + CRLF；失败返回 false（由 toggle 转成 ok:false） */
function write(paths, items) {
  try {
    const file = favoritesPath(paths);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify({ version: VERSION, items }, null, 1).replace(/\n/g, "\r\n");
    fs.writeFileSync(file, text, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 切换一条效果的收藏状态。
 * @param {ReturnType<import("./paths").createPaths>} paths
 * @param {string} matchName
 * @returns {{ok: boolean, favorite: boolean, items: string[], reason?: string}}
 */
function toggle(paths, matchName) {
  const name = typeof matchName === "string" ? matchName.trim() : "";
  const current = read(paths);
  if (!name) {
    return { ok: false, reason: "invalid_match_name", favorite: false, items: current.items };
  }

  const set = new Set(current.items);
  const favorite = !set.has(name);
  if (favorite) set.add(name);
  else set.delete(name);
  const items = [...set];

  if (!write(paths, items)) {
    return {
      ok: false,
      reason: "write_failed",
      favorite: current.items.includes(name),
      items: current.items,
    };
  }
  return { ok: true, favorite, items };
}

module.exports = { VERSION, read, toggle };
