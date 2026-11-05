/* ============================================================
 * presets.js —— 预设库的读写（唯一入口）
 *
 * 三个必须与现有代码对齐的点：
 *   1. 库目录 = <我的文档>/DreamEngine/presets（store.jsx 的 folderAt("presets")）
 *   2. 重名规则 = base_1.ffx、base_2.ffx
 *   3. 「是否已有预览」查两份索引：面板生成的 preset_manifest.json
 *      与离线通道的 preset_plugin_manifest.json
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");

/** 统一成小写正斜杠路径做比较：Windows 下大小写与分隔符都会变 */
function norm(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase();
}

function readIndex(file) {
  const map = new Map();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return map;
  }
  let json;
  try {
    json = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return map;
  }
  for (const item of json.items || []) {
    if (item && item.path) map.set(norm(item.path), item);
  }
  return map;
}

/** 两份索引合并：面板生成的在内置预设里，含插件的在离线索引里 */
function loadPreviewIndex(paths) {
  const merged = readIndex(paths.presetManifest);
  for (const [key, item] of readIndex(paths.presetPluginManifest)) {
    merged.set(key, item);
  }
  return merged;
}

/**
 * 列出预设库。
 * @param {ReturnType<import("./paths").createPaths>} paths
 */
function list(paths) {
  const index = loadPreviewIndex(paths);
  let names = [];
  try {
    names = fs.readdirSync(paths.presets);
  } catch {
    return { folder: paths.presets, exists: false, items: [] };
  }

  const items = [];
  for (const name of names) {
    if (!/\.ffx$/i.test(name)) continue;
    const full = path.join(paths.presets, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const hit = index.get(norm(full));
    items.push({
      path: full,
      fileName: name,
      name: name.replace(/\.ffx$/i, ""),
      size: stat.size,
      mtime: stat.mtimeMs,
      rendered: !!hit,
      frames: hit ? hit.frames || 1 : 0,
      animated: hit ? !!hit.animated : false,
      offline: hit ? !!hit.plugin : false,
      thumb: hit && hit.src ? path.join(paths.dataDir, hit.src) : "",
    });
  }

  items.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return { folder: paths.presets, exists: true, items };
}

/** 重名时按 base_1、base_2 递增 */
function uniqueTarget(dir, fileName) {
  const first = path.join(dir, fileName);
  if (!fs.existsSync(first)) return first;
  const base = fileName.replace(/\.ffx$/i, "");
  let n = 1;
  for (;;) {
    const candidate = path.join(dir, `${base}_${n}.ffx`);
    if (!fs.existsSync(candidate)) return candidate;
    n++;
  }
}

/**
 * 把若干 .ffx 复制进预设库。
 * @returns {{imported: string[], skipped: {path: string, reason: string}[]}}
 */
function importFiles(files, paths) {
  const imported = [];
  const skipped = [];

  if (!fs.existsSync(paths.presets)) {
    fs.mkdirSync(paths.presets, { recursive: true });
  }

  for (const file of files || []) {
    const from = String(file || "");
    if (!/\.ffx$/i.test(from)) {
      skipped.push({ path: from, reason: "not_ffx" });
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(from);
    } catch {
      skipped.push({ path: from, reason: "missing" });
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ path: from, reason: "not_file" });
      continue;
    }

    const target = uniqueTarget(paths.presets, path.basename(from));
    try {
      fs.copyFileSync(from, target);
      imported.push(target);
    } catch (error) {
      skipped.push({ path: from, reason: String(error.message || error) });
    }
  }

  return { imported, skipped };
}

/** 删除预设库内的单个 .ffx，拒绝库目录之外的路径 */
function removePreset(target, paths) {
  const full = path.resolve(String(target || ""));
  const root = path.resolve(paths.presets);
  if (!/\.ffx$/i.test(full)) return { ok: false, reason: "not_ffx" };
  if (path.dirname(full) !== root) return { ok: false, reason: "outside_library" };
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return { ok: false, reason: "file_missing" };
  }
  if (!stat.isFile()) return { ok: false, reason: "not_file" };
  try {
    fs.unlinkSync(full);
    return { ok: true, path: full };
  } catch (error) {
    return { ok: false, reason: String(error.message || error) };
  }
}

module.exports = { list, importFiles, removePreset, loadPreviewIndex, uniqueTarget, norm };
