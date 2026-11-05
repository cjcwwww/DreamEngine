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

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const { createPaths } = require("./core/paths");
const { findAfterFX, bestAfterFX, isAERunning } = require("./core/ae");
const presets = require("./core/presets");
const install = require("./core/install");
const { RenderJob } = require("./core/render");

let mainWindow = null;
let paths = null;
let job = null;

/** 开发态用仓库里的 tools/；打包后随包走 resources/tools/ */
function toolsDir() {
  const packed = path.join(process.resourcesPath || "", "tools");
  if (fs.existsSync(path.join(packed, "generate_plugin_presets.ps1"))) return packed;
  return path.join(__dirname, "..", "tools");
}

function buildPaths() {
  // 必须用 Electron 的 documents 路径：Windows 上它可能被 OneDrive 重定向，
  // os.homedir()+"Documents" 在这种情况下会指向一个空目录。
  return createPaths({ docsDir: app.getPath("documents") });
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
  };
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

  ipcMain.handle("presets:list", () => presets.list(paths));

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
      for (const name of fs.readdirSync(paths.backgrounds)) {
        if (!/\.(png|jpe?g|webp|bmp|tiff?)$/i.test(name)) continue;
        extra.push({
          id: path.join(paths.backgrounds, name),
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
    for (const source of result.filePaths) {
      if (!/\.(png|jpe?g|webp|bmp|tiff?)$/i.test(source)) continue;
      const ext = path.extname(source);
      const base = path.basename(source, ext);
      let target = path.join(paths.backgrounds, path.basename(source));
      let n = 1;
      while (fs.existsSync(target)) {
        target = path.join(paths.backgrounds, `${base}_${n}${ext}`);
        n++;
      }
      fs.copyFileSync(source, target);
      added.push(target);
    }
    return { added };
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
    const statePath = paths.hubState;
    // 上一轮残留的 done/failed 状态会让 UI 一上来就显示「已完成」，先清掉
    try {
      fs.rmSync(statePath, { force: true });
    } catch {
      /* 无所谓 */
    }
    return job.start(options || {});
  });

  ipcMain.handle("render:stop", () => (job ? job.stop() : { ok: false }));

  ipcMain.handle("render:snapshot", () => (job ? job.snapshot() : null));

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
              await mainWindow.webContents.executeJavaScript(
                `document.querySelector('.tab[data-view="${viewArg}"]').click()`,
              );
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
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    if (job && job.isRunning()) job.stop();
  });
}
