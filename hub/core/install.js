/* ============================================================
 * install.js —— 安装状态自检（只读，不做安装）
 *
 * 真正的安装/升级交给 tools/install_dreamengine.ps1：
 * 那里面已经有「保护用户数据」「多版本 PlayerDebugMode」「Junction 检测」
 * 三条硬约束，Hub 再实现一遍就是重复建设。
 * 这里只回答一个问题：现在这台机器上，面板到底装没装、什么版本、有多少图。
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {ReturnType<import("./paths").createPaths>} paths
 */
function status(paths) {
  const indexFile = path.join(paths.extDir, "index.html");
  const installed = fs.existsSync(indexFile);

  let version = "";
  try {
    const xml = fs.readFileSync(paths.manifestXml, "utf8");
    const matched = xml.match(/ExtensionBundleVersion="([^"]+)"/);
    if (matched) version = matched[1];
  } catch {
    /* 没装就没有 manifest.xml */
  }

  let thumbs = 0;
  try {
    thumbs = fs
      .readdirSync(path.join(paths.dataDir, "thumbs"))
      .filter((name) => /\.png$/i.test(name)).length;
  } catch {
    /* 目录不存在 */
  }

  // data/ 下这些文件都是运行时产物，数量能反映「渲染干了多少活」
  const runtimeFiles = [
    "manifest.json",
    "plugin_manifest.json",
    "preset_manifest.json",
    "preset_plugin_manifest.json",
  ].filter((name) => fs.existsSync(path.join(paths.dataDir, name)));

  let presetsCount = 0;
  try {
    presetsCount = fs
      .readdirSync(paths.presets)
      .filter((name) => /\.ffx$/i.test(name)).length;
  } catch {
    /* 库还没建 */
  }

  return {
    installed,
    version,
    extDir: paths.extDir,
    thumbCount: thumbs,
    presetCount: presetsCount,
    indexes: runtimeFiles,
  };
}

module.exports = { status };
