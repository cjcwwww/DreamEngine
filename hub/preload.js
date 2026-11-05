/* ============================================================
 * preload.js —— 渲染进程能看到的全部能力，只有这一个白名单
 *
 * 渲染进程不开 nodeIntegration，所有文件与进程操作都必须经过这里。
 * 将来把 UI 迁到 Tauri / 别的壳，只需要换掉这一层的实现，
 * app.js 一行不用改（和 CEP 那边 transport 解耦是同一个思路）。
 * ============================================================ */

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("hub", {
  /* 环境快照：AE 是否运行、扩展装没装、各目录在哪 */
  snapshot: () => ipcRenderer.invoke("hub:snapshot"),

  /* 预设库 */
  listPresets: () => ipcRenderer.invoke("presets:list"),
  pickPresets: () => ipcRenderer.invoke("presets:pick"),
  importPaths: (files) => ipcRenderer.invoke("presets:importPaths", files),
  deletePreset: (target) => ipcRenderer.invoke("presets:delete", target),
  loadPresetCategories: () => ipcRenderer.invoke("categories:load"),
  createPresetCategory: (name) => ipcRenderer.invoke("categories:create", name),
  renamePresetCategory: (id, name) => ipcRenderer.invoke("categories:rename", id, name),
  deletePresetCategory: (id) => ipcRenderer.invoke("categories:delete", id),
  assignPresetCategory: (target, id) => ipcRenderer.invoke("categories:assign", target, id),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  reveal: (target) => ipcRenderer.invoke("shell:reveal", target),
  listBackgrounds: () => ipcRenderer.invoke("backgrounds:list"),
  addBackground: () => ipcRenderer.invoke("backgrounds:add"),

  /* 渲染 */
  startRender: (options) => ipcRenderer.invoke("render:start", options),
  stopRender: () => ipcRenderer.invoke("render:stop"),
  renderSnapshot: () => ipcRenderer.invoke("render:snapshot"),
  logTail: (lines) => ipcRenderer.invoke("log:tail", lines),

  /* 主进程推送 */
  onRenderState: (callback) => {
    ipcRenderer.on("render:state", (_event, state) => callback(state));
  },
  onRenderExit: (callback) => {
    ipcRenderer.on("render:exit", (_event, info) => callback(info));
  },
});
