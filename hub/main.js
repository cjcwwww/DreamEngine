/* ============================================================
 * main.js —— DreamEngine Hub 主进程
 *
 * 职责边界（和 CEP 面板同样的分层）：
 *   主进程 = 文件系统 + 进程调度 + 系统对话框
 *   渲染进程 = 纯 UI，不碰 Node（contextIsolation 开着）
 *
 * 刻意不做的事：
 *   · 不自己实现渲染调度 —— 一律 spawn tools/generate_plugin_presets.ps1
 *   · 不自己实现安装 —— 一律调用 tools/install_dreamengine.ps1
 * ============================================================ */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const { createPaths } = require("./core/paths");
const { findAfterFX, bestAfterFX, isAERunning } = require("./core/ae");
const presets = require("./core/presets");
const presetSources = require("./core/preset_sources");
const presetCategories = require("./core/preset_categories");
const install = require("./core/install");
const { RenderJob } = require("./core/render");
const { PluginEffectJob } = require("./core/effect_render");
const { ManualEffectRunner } = require("./core/manual_effect");
const effectOverrides = require("./core/effect_overrides");
const catalog = require("./core/catalog");
const effects = require("./core/effects");
const effectFavorites = require("./core/effect_favorites");
const {
  importImageAsPng,
  normalizeBackgroundDirectory,
  isPngFile,
} = require("./core/backgrounds");

let mainWindow = null;
let paths = null;
let job = null;
let pluginJob = null;
let manualRunner = null;

/** 开发态用仓库里的 tools/；打包后随包走 resources/tools/ */
function toolsDir() {
  const packed = path.join(process.resourcesPath || "", "tools");
  if (
    fs.existsSync(path.join(packed, "generate_plugin_presets.ps1")) &&
    fs.existsSync(path.join(packed, "generate_plugin_effects.ps1"))
  ) {
    return packed;
  }
  return path.join(__dirname, "..", "tools");
}

function buildPaths() {
  // 必须用 Electron 的 documents 路径：Windows 上它可能被 OneDrive 重定向，
  // os.homedir()+"Documents" 在这种情况下会指向一个空目录。
  return createPaths({ docsDir: app.getPath("documents") });
}

/**
 * 记住当前 Hub 可执行文件位置，供 AE 面板“打开 Hub”直接启动。
 * 安装目录允许用户修改，所以不能把路径硬编码进 CEP 面板。
 */
function rememberHubPath(currentPaths) {
  try {
    if (path.basename(process.execPath).toLowerCase() !== "dreamengine hub.exe") return;
    const dir = path.join(currentPaths.docsDir, "DreamEngine");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hub-path.txt"), process.execPath + "\n", "utf8");
  } catch {
    /* 标记失败不影响 Hub 启动；面板仍会查开始菜单和默认路径 */
  }
}

function snapshot() {
  const versions = findAfterFX();
  return {
    ae: {
      running: isAERunning(),
      installed: versions.map((v) => ({ name: v.name, version: v.version, exe: v.exe })),
      exe: bestAfterFX(),
    },
    ext: install.status(paths),
    paths: {
      presets: paths.presets,
      backgrounds: paths.backgrounds,
      extDir: paths.extDir,
      probe: paths.probe,
      docs: paths.docsDir,
    },
    render: job ? { running: job.isRunning(), state: job.snapshot() } : { running: false, state: null },
    pluginEffects: pluginJob
      ? { running: pluginJob.isRunning(), mode: pluginJob.getMode(), state: pluginJob.snapshot() }
      : { running: false, mode: "", state: null },
  };
}

/** 上一轮任务异常退出后可能留下选择/扫描标记，启动新任务前统一清掉。 */
function cleanupJobMarkers(paths) {
  for (const key of ["pluginSelectionMarker", "pluginForceMarker", "pluginCatalogOnlyMarker"]) {
    try {
      fs.rmSync(paths[key], { force: true });
    } catch {
      /* 标记清理失败不影响任务 */
    }
  }
}

/** 过滤用户在 Hub 勾选的预设（实现放在 core/presets.js，便于单测） */
function selectedPresetPaths(list) {
  return presets.resolveSelection(paths, list);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#0f1113",
    show: false,
    title: "DreamEngine Hub",
    icon: path.join(__dirname, "assets", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/* ---------- IPC ---------- */

function registerIpc() {
  ipcMain.handle("hub:snapshot", () => snapshot());
  ipcMain.handle("shell:openExternal", (_event, url) => {
    const allowed = new Set([
      "https://v.douyin.com/-9l_jE72QY4/",
      "https://github.com/yoanx/DreamEngine",
    ]);
    if (!allowed.has(url)) return false;
    return shell.openExternal(url).then(() => true).catch(() => false);
  });
  ipcMain.handle("clipboard:writeText", (_event, text) => {
    if (text !== "972561311") return false;
    clipboard.writeText(text);
    return true;
  });

  ipcMain.handle("presets:list", () => presets.list(paths));

  // 扫描所选 AE 的安装 Presets + User Presets，只写外部索引，不复制文件
  ipcMain.handle("presets:sync", (_event, options) => {
    const opts = options || {};
    const aeExe = String(opts.ae || "").trim() || bestAfterFX();
    if (!aeExe) return { ok: false, reason: "no_ae" };
    const result = presetSources.scanAePresets(paths, {
      aeExe,
      force: !!opts.force,
    });
    if (!result.ok) return result;
    // items 由 presets:list 从 preset_catalog.json 读取，IPC 只回摘要
    const { items, ...summary } = result;
    return summary;
  });

  ipcMain.handle("presets:pick", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 After Effects 预设",
      buttonLabel: "导入",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "After Effects 预设", extensions: ["ffx"] }],
    });
    if (result.canceled || !result.filePaths.length) return { imported: [], skipped: [] };
    const done = presets.importFiles(result.filePaths, paths);
    return done;
  });

  // 拖拽进来的路径：文件对话框之外的第二种入口（面板里也保留了这条）
  ipcMain.handle("presets:importPaths", (_event, files) => presets.importFiles(files || [], paths));
  ipcMain.handle("presets:delete", (_event, target) => presets.removePreset(target, paths));
  ipcMain.handle("presets:rename", (_event, target, name) => {
    const renamed = presets.renamePreset(target, name, paths);
    if (!renamed.ok || renamed.unchanged) return renamed;
    presetCategories.movePath(paths, renamed.previousPath, renamed.path);
    presets.remapPreviewReferences(paths, renamed.previousPath, renamed.path, renamed.name);
    return renamed;
  });
  ipcMain.handle("presets:clearRender", (_event, target) => presets.clearPreview(target, paths));
  ipcMain.handle("categories:load", () => presetCategories.read(paths));
  ipcMain.handle("categories:create", (_event, name) => presetCategories.create(paths, name));
  ipcMain.handle("categories:rename", (_event, id, name) => presetCategories.rename(paths, id, name));
  ipcMain.handle("categories:delete", (_event, id) => presetCategories.remove(paths, id));
  ipcMain.handle("categories:assign", (_event, target, id) =>
    presetCategories.assign(paths, target, id),
  );
  ipcMain.handle("categories:toggleFavorite", (_event, target) =>
    presetCategories.toggleFavorite(paths, target),
  );

  ipcMain.handle("backgrounds:list", () => {
    // 与面板的 preset_preview.backgroundsJson 保持同一组内置 id
    const builtin = [
      { id: "photo", label: "标准素材" },
      { id: "text", label: "文字" },
      { id: "solid", label: "纯色" },
      { id: "shape", label: "形状" },
      { id: "pattern", label: "条纹" },
    ];
    const extra = [];
    try {
      normalizeBackgroundDirectory({ dir: paths.backgrounds, nativeImage });
      for (const name of fs.readdirSync(paths.backgrounds)) {
        const fullPath = path.join(paths.backgrounds, name);
        if (!/\.png$/i.test(name) || !isPngFile(fullPath)) continue;
        extra.push({
          id: fullPath,
          label: name.replace(/\.[^.]+$/, "") + "（自定义）",
        });
      }
    } catch {
      /* 目录还没建 */
    }
    return [...builtin, ...extra];
  });

  ipcMain.handle("backgrounds:add", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "添加预览背景",
      buttonLabel: "添加",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"] }],
    });
    if (result.canceled || !result.filePaths.length) return { added: [] };

    fs.mkdirSync(paths.backgrounds, { recursive: true });
    const added = [];
    const errors = [];
    for (const source of result.filePaths) {
      if (!/\.(png|jpe?g|webp|bmp|tiff?)$/i.test(source)) continue;
      const imported = importImageAsPng({
        source,
        targetDir: paths.backgrounds,
        nativeImage,
      });
      if (imported.ok) added.push(imported.path);
      else errors.push({ source, reason: imported.reason || "convert_failed" });
    }
    return { added, errors };
  });

  ipcMain.handle("shell:reveal", (_event, target) => {
    if (!target) return false;
    const dir = fs.existsSync(target) && fs.statSync(target).isDirectory()
      ? target
      : path.dirname(target);
    if (!fs.existsSync(dir)) return false;
    shell.openPath(dir);
    return true;
  });

  ipcMain.handle("render:start", (_event, options) => {
    if (!job) return { ok: false, reason: "no_job" };
    if (pluginJob && pluginJob.isRunning()) return { ok: false, reason: "plugin_effects_running" };
    let opts = options || {};
    let selectedPaths = null;
    if (Array.isArray(opts.presetPaths)) {
      selectedPaths = selectedPresetPaths(opts.presetPaths);
      if (selectedPaths.length === 0) return { ok: false, reason: "nothing_to_render" };
      try {
        fs.mkdirSync(paths.probe, { recursive: true });
        fs.writeFileSync(paths.presetSelection, selectedPaths.join("\r\n") + "\r\n", "utf8");
      } catch (error) {
        return { ok: false, reason: "write_failed", detail: String(error.message || error) };
      }
      opts = {
        ...opts,
        presetList: paths.presetSelection,
        force: !!opts.force,
        limit: Math.max(selectedPaths.length, 1),
      };
    }
    // 外部 AE 预设需要靠 -AE 推导允许的 Presets 根目录；没选版本时用
    // 最近一次外部索引里的 AE，避免 ps1 把外部路径当成非法路径。
    if (!opts.ae && (opts.presetList || opts.onlyPreset)) {
      const externalCatalog = presetSources.readCatalog(paths);
      if (externalCatalog && externalCatalog.aeExe) opts.ae = externalCatalog.aeExe;
    }
    const statePath = paths.hubState;
    // 上一轮残留的 done/failed 状态会让 UI 一上来就显示「已完成」，先清掉
    try {
      fs.rmSync(statePath, { force: true });
    } catch {
      /* 无所谓 */
    }
    const result = job.start(opts);
    if (result.ok && selectedPaths) {
      return { ...result, selectedCount: selectedPaths.length };
    }
    return result;
  });

  ipcMain.handle("render:stop", () => (job ? job.stop() : { ok: false }));

  ipcMain.handle("render:snapshot", () => (job ? job.snapshot() : null));

  ipcMain.handle("plugin-effects:start", (_event, options) => {
    if (!pluginJob) return { ok: false, reason: "no_job" };
    if (job && job.isRunning()) return { ok: false, reason: "preset_render_running" };
    if (pluginJob.isRunning()) return { ok: false, reason: "already_running" };

    const opts = options || {};
    const matchNames = Array.isArray(opts.matchNames) ? opts.matchNames : [];
    cleanupJobMarkers(paths);

    if (matchNames.length > 0) {
      const cat = catalog.readCatalog(paths);
      if (!cat.ok) return { ok: false, reason: "no_catalog" };
      const { selected, skipped } = catalog.filterSelection(cat, matchNames, !!opts.force);
      if (selected.length === 0) {
        return { ok: false, reason: "nothing_to_render", skipped };
      }
      try {
        catalog.writeSelection(paths, selected);
      } catch (error) {
        return { ok: false, reason: "write_failed", detail: String(error.message || error) };
      }
      const result = pluginJob.start({
        ...opts,
        todoPath: paths.pluginSelection,
        force: !!opts.force,
      });
      if (!result.ok) return result;
      return {
        ...result,
        selectedCount: selected.length,
        skippedCount: skipped.length,
        skipped,
      };
    }

    return pluginJob.start(opts);
  });

  ipcMain.handle("plugin-effects:scan", (_event, options) => {
    if (!pluginJob) return { ok: false, reason: "no_job" };
    if (job && job.isRunning()) return { ok: false, reason: "preset_render_running" };
    if (pluginJob.isRunning()) return { ok: false, reason: "already_running" };
    cleanupJobMarkers(paths);
    return pluginJob.start({
      catalogOnly: true,
      ae: (options && options.ae) || "",
    });
  });

  ipcMain.handle("plugin-effects:catalog", () => catalog.readCatalog(paths));

  /* 效果库：内置 + 插件的合并只读视图（数据层在 core/effects.js） */
  ipcMain.handle("effects:list", () => effects.list(paths));
  ipcMain.handle("effects:toggleFavorite", (_event, matchName) =>
    effectFavorites.toggle(paths, matchName),
  );
  ipcMain.handle("effects:clearPreview", (_event, matchName) =>
    effects.clearPreview(paths, matchName),
  );

  ipcMain.handle("plugin-effects:stop", () =>
    pluginJob ? pluginJob.stop() : { ok: false, reason: "no_job" },
  );
  ipcMain.handle("plugin-effects:snapshot", () =>
    pluginJob ? pluginJob.snapshot() : null,
  );
  ipcMain.handle("plugin-effects:logTail", (_event, lines = 40) => {
    const n = lines === undefined ? 40 : Math.floor(Number(lines));
    if (!Number.isFinite(n) || n <= 0) return "";
    try {
      return fs.readFileSync(paths.pluginEffectLog, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-n)
        .join("\n");
    } catch {
      return "";
    }
  });

  ipcMain.handle("log:tail", (_event, lines = 40) => {
    const n = lines === undefined ? 40 : Math.floor(Number(lines));
    if (!Number.isFinite(n) || n <= 0) return "";
    try {
      const text = fs.readFileSync(paths.runLog, "utf8");
      return text.split(/\r?\n/).filter(Boolean).slice(-n).join("\n");
    } catch {
      return "";
    }
  });

  /* ---------- 手动调参：dump / baseline / verify / save ---------- */

  function manualBusy() {
    if (!manualRunner) return { busy: true, reason: "no_runner" };
    if (pluginJob && pluginJob.isRunning()) return { busy: true, reason: "plugin_effects_running" };
    if (manualRunner.isRunning()) return { busy: true, reason: "manual_running" };
    return null;
  }

  function validMatchName(value) {
    const name = String(value === null || value === undefined ? "" : value).trim();
    return name && !/[\t\r\n]/.test(name) ? name : "";
  }

  function comparePngFiles(baselineFile, verifyFile) {
    const baseline = nativeImage.createFromPath(baselineFile);
    const verify = nativeImage.createFromPath(verifyFile);
    if (baseline.isEmpty() || verify.isEmpty()) {
      return { ok: false, reason: "image_read_failed" };
    }
    const sizeA = baseline.getSize();
    const sizeB = verify.getSize();
    if (sizeA.width !== sizeB.width || sizeA.height !== sizeB.height) {
      return { ok: false, reason: "size_mismatch", sizeA, sizeB };
    }
    const a = baseline.getBitmap();
    const b = verify.getBitmap();
    const totalPixels = sizeA.width * sizeA.height;
    let diffPixels = 0;
    let maxChannelDiff = 0;
    for (let i = 0; i < totalPixels; i++) {
      const off = i * 4;
      const dr = Math.abs(a[off] - b[off]);
      const dg = Math.abs(a[off + 1] - b[off + 1]);
      const db = Math.abs(a[off + 2] - b[off + 2]);
      const da = Math.abs(a[off + 3] - b[off + 3]);
      const diff = Math.max(dr, dg, db, da);
      if (diff > 0) diffPixels++;
      if (diff > maxChannelDiff) maxChannelDiff = diff;
    }
    return {
      ok: true,
      identical: diffPixels === 0,
      diffPixels,
      totalPixels,
      maxChannelDiff,
      baselineDataUrl: baseline.toDataURL(),
      verifyDataUrl: verify.toDataURL(),
    };
  }

  ipcMain.handle("manual:dump", async (_event, options) => {
    const busy = manualBusy();
    if (busy) return { ok: false, reason: busy.reason };
    const matchName = validMatchName(options && options.matchName);
    if (!matchName) return { ok: false, reason: "bad_match_name" };
    const ae = (options && options.ae) || bestAfterFX();
    return manualRunner.run({ matchName, mode: "dump", ae });
  });

  ipcMain.handle("manual:baseline", async (_event, options) => {
    const busy = manualBusy();
    if (busy) return { ok: false, reason: busy.reason };
    const matchName = validMatchName(options && options.matchName);
    if (!matchName) return { ok: false, reason: "bad_match_name" };
    const ae = (options && options.ae) || bestAfterFX();
    /* 基线必须不带手动覆盖；临时移走覆盖表，结束后恢复。 */
    const file = effectOverrides.overridesPath(paths);
    const backup = file + ".manual-baseline-backup";
    let moved = false;
    try {
      if (fs.existsSync(file)) {
        fs.renameSync(file, backup);
        moved = true;
      }
      return await manualRunner.run({ matchName, mode: "baseline", ae });
    } finally {
      if (moved) {
        try { fs.renameSync(backup, file); } catch { /* 恢复失败时保留备份 */ }
      }
    }
  });

  ipcMain.handle("manual:overrides", (_event, matchName) => {
    const name = validMatchName(matchName);
    if (!name) return { ok: false, reason: "bad_match_name", items: [] };
    const doc = effectOverrides.read(paths);
    return { ok: doc.ok, items: effectOverrides.forMatchName(doc.items, name), errors: doc.errors };
  });

  ipcMain.handle("manual:verify", async (_event, options) => {
    const busy = manualBusy();
    if (busy) return { ok: false, reason: busy.reason };
    const matchName = validMatchName(options && options.matchName);
    if (!matchName) return { ok: false, reason: "bad_match_name" };
    const rows = Array.isArray(options && options.params) ? options.params : [];
    const baselinePath = String((options && options.baselinePath) || "");
    if (!baselinePath || !fs.existsSync(baselinePath)) {
      return { ok: false, reason: "baseline_missing" };
    }
    if (rows.length === 0) return { ok: false, reason: "no_params" };

    const base = effectOverrides.read(paths);
    const kept = (base.items || []).filter((item) => item && item.matchName !== matchName);
    const candidate = rows
      .filter((row) => row && row.paramIndex && row.enabled !== false)
      .map((row) => ({
        ...row,
        matchName,
        enabled: true,
        verified: row.verified === true ? true : null,
      }));
    if (candidate.length === 0) return { ok: false, reason: "no_params" };

    const wrote = effectOverrides.write(paths, kept.concat(candidate));
    if (!wrote.ok) return wrote;
    try {
      const run = await manualRunner.run({
        matchName,
        mode: "verify",
        ae: (options && options.ae) || bestAfterFX(),
      });
      if (!run.ok || !run.png) return { ...run, compare: null };
      const compare = comparePngFiles(baselinePath, run.png);
      return { ...run, compare };
    } finally {
      /* 验证只是临时写表；恢复用户原有覆盖（可能是缺失表）。 */
      if (base.missing) {
        try { fs.rmSync(effectOverrides.overridesPath(paths), { force: true }); } catch { /* ignore */ }
      } else {
        effectOverrides.write(paths, base.items || []);
      }
    }
  });

  ipcMain.handle("manual:save", (_event, options) => {
    const matchName = validMatchName(options && options.matchName);
    if (!matchName) return { ok: false, reason: "bad_match_name" };
    const rows = Array.isArray(options && options.params) ? options.params : [];
    const preset = String((options && options.preset) || "").trim();
    const base = effectOverrides.read(paths);
    const kept = (base.items || []).filter((item) => item && item.matchName !== matchName);
    const candidate = rows
      .filter((row) => row && row.paramIndex && row.enabled !== false)
      .map((row) => ({
        ...row,
        matchName,
        enabled: true,
        verified: row.verified === true ? true : row.verified === false ? false : null,
      }));
    /* .ffx 只在没有逐参数覆盖时作为兜底；两者同时存在时参数优先。 */
    if (preset && candidate.length === 0) {
      candidate.push({
        matchName,
        preset,
        scene: "",
        enabled: true,
        paramIndex: "",
        paramPath: "",
        value: null,
        valueType: "",
        verified: null,
        note: "",
      });
    }
    if (candidate.length === 0) return { ok: false, reason: "no_params" };
    const wrote = effectOverrides.write(paths, kept.concat(candidate));
    if (!wrote.ok) return wrote;
    /* 旧预览可能还带着旧参数；先清掉，UI 随后启动强制重渲。 */
    effects.clearPreview(paths, matchName);
    return wrote;
  });

  ipcMain.handle("manual:pickPreset", async () => {
    if (!mainWindow) return { ok: false, reason: "no_window" };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 .ffx 兜底预设",
      properties: ["openFile"],
      filters: [{ name: "After Effects 预设", extensions: ["ffx"] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, reason: "cancelled" };
    return effectOverrides.importPreset(paths, result.filePaths[0]);
  });

  ipcMain.handle("manual:stop", () =>
    manualRunner ? manualRunner.stop() : { ok: false, reason: "no_runner" },
  );
}

/* ---------- 无头自检：验证路径解析、AE 检测、索引读取是否正常 ---------- */
/* 用法：npx electron . --selftest
   GUI 不好断言，但「主进程能不能拿到正确数据」是可以直接断言的。 */
const isSelftest = process.argv.includes("--selftest");
const screenshotArg = process.argv.find((arg) => arg.startsWith("--screenshot="));
const viewArg = (process.argv.find((arg) => arg.startsWith("--view=")) || "").split("=")[1];

/* ---------- 生命周期 ---------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    paths = buildPaths();
    rememberHubPath(paths);
    cleanupJobMarkers(paths);

    job = new RenderJob({
      paths,
      script: path.join(toolsDir(), "generate_plugin_presets.ps1"),
      onState: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("render:state", state);
        }
      },
      onExit: (info) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("render:exit", info);
        }
      },
    });

    pluginJob = new PluginEffectJob({
      paths,
      script: path.join(toolsDir(), "generate_plugin_effects.ps1"),
      onState: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("plugin-effects:state", state);
        }
      },
      onExit: (info) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("plugin-effects:exit", info);
          // 扫描任务结束后把新目录直接推给 UI，避免 UI 再等一次 IPC 往返
          if (pluginJob && pluginJob.getMode() === "catalog") {
            mainWindow.webContents.send("plugin-effects:catalog", catalog.readCatalog(paths));
          }
        }
      },
    });

    manualRunner = new ManualEffectRunner({
      paths,
      script: path.join(toolsDir(), "manual_probe.ps1"),
      jsx: path.join(toolsDir(), "manual_probe.jsx"),
      template: path.join(toolsDir(), "DreamEnginePNG.aep"),
      timeoutMs: 300000,
    });

    Menu.setApplicationMenu(null);
    registerIpc();

    if (isSelftest) {
      console.log(JSON.stringify(snapshot(), null, 2));
      app.quit();
      return;
    }

    createWindow();

    if (screenshotArg) {
      mainWindow.webContents.once("did-finish-load", () => {
        setTimeout(async () => {
          try {
            if (viewArg) {
              const tab = viewArg === "pluginEffects" ? "render" : viewArg;
              await mainWindow.webContents.executeJavaScript(
                `document.querySelector('.tab[data-view="${tab}"]').click()`,
              );
              if (viewArg === "pluginEffects") {
                await mainWindow.webContents.executeJavaScript(
                  `document.querySelector('.render-mode-button[data-render-mode="plugin"]').click()`,
                );
              }
              await new Promise((r) => setTimeout(r, 1200));
            }
            const image = await mainWindow.webContents.capturePage();
            fs.writeFileSync(screenshotArg.slice("--screenshot=".length), image.toPNG());
            console.log("screenshot saved");
          } catch (error) {
            console.error("screenshot failed: " + error.message);
          }
          app.quit();
        }, 2600);
      });
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    // 渲染中途关窗口：把专用 AE 实例一起收掉，别留孤儿进程
    if (job && job.isRunning()) job.stop();
    if (pluginJob && pluginJob.isRunning()) pluginJob.stop();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    if (job && job.isRunning()) job.stop();
    if (pluginJob && pluginJob.isRunning()) pluginJob.stop();
  });
}
