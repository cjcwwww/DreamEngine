/* ============================================================
 * paths.js —— 全项目唯一的路径定义
 *
 * 这里的每个常量都必须和另外两处**完全一致**：
 *   · tools/generate_plugin_presets.ps1（离线渲染脚本）
 *   · cep/com.dreamengine.panel/engine/store.jsx（面板数据层）
 * 三边不一致的后果是「Hub 导入了，面板看不见」这类最难查的问题。
 *
 * 不依赖 electron：可以脱离 GUI 单独跑（tools/test-hub.mjs 就是这么测的）。
 * ============================================================ */

const path = require("node:path");
const os = require("node:os");

/**
 * @param {{docsDir?: string, appData?: string}} [opts]
 */
function createPaths(opts = {}) {
  const docsDir = opts.docsDir || path.join(os.homedir(), "Documents");
  const appData =
    opts.appData || process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");

  const extDir = path.join(appData, "Adobe", "CEP", "extensions", "com.dreamengine.panel");
  const userRoot = path.join(docsDir, "DreamEngine");
  const probe = path.join(docsDir, "DreamEngineProbe");
  const dataDir = path.join(extDir, "data");

  return {
    docsDir,
    appData,
    extDir,
    dataDir,
    userRoot,

    /* 用户资产：升级安装时绝不能被覆盖（install_dreamengine.ps1 也认这两个目录） */
    presets: path.join(userRoot, "presets"),
    backgrounds: path.join(userRoot, "backgrounds"),
    presetCategories: path.join(userRoot, "preset_categories.json"),

    /* 离线渲染的约定目录 */
    probe,
    hubState: path.join(probe, "hub_state.json"),
    runLog: path.join(probe, "preset_plugin_run.log"),
    entries: path.join(probe, "preset_plugin_previews.tsv"),
    todo: path.join(probe, "next_preset_plugin_batch.tsv"),
    pluginEffectState: path.join(probe, "plugin_effect_state.json"),
    pluginEffectLog: path.join(probe, "plugin_run.log"),

    /* 面板读的三份索引 */
    presetManifest: path.join(dataDir, "preset_manifest.json"),
    presetPluginManifest: path.join(dataDir, "preset_plugin_manifest.json"),
    pluginManifest: path.join(dataDir, "plugin_manifest.json"),
    manifestXml: path.join(extDir, "CSXS", "manifest.xml"),
  };
}

module.exports = { createPaths };
