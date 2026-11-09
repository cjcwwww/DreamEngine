/* ============================================================
 * app.js —— 渲染进程逻辑
 *
 * 只用 window.hub（preload 暴露的白名单），不碰 Node。
 * 换壳（Tauri 等）时只需要替换 preload 那一层。
 * ============================================================ */

const $ = (id) => document.getElementById(id);
const RENDER_AE_KEY = "dreamengine.renderAePath.v1";
const PRESET_SIDEBAR_WIDTH_KEY = "dreamengine.hub.presetSidebarWidth.v1";
const PRESET_SIDEBAR_COLLAPSED_KEY = "dreamengine.hub.presetSidebarCollapsed.v1";
const EFFECT_SIDEBAR_WIDTH_KEY = "dreamengine.hub.effectSidebarWidth.v1";
const EFFECT_SIDEBAR_COLLAPSED_KEY = "dreamengine.hub.effectSidebarCollapsed.v1";
const EFFECT_GROUP_COLLAPSED_KEY = "dreamengine.hub.effectGroupCollapsed.v1";
const SIDEBAR_MIN = 150;
const SIDEBAR_MAX = 420;

const state = {
  snapshot: null,
  presets: [],
  query: "",
  view: "presets",
  renderMode: "preset",
  logKind: "preset",
  rendering: false,
  stopRequested: false,
  pluginEffectRendering: false,
  pluginEffectStopRequested: false,
  pluginCatalog: null,
  pluginCatalogScanning: false,
  pluginEffectSelection: new Map(),
  effectPicker: { query: "", plugin: "", hideRendered: true, force: false },
  effects: [],
  effectData: null,
  effectQuery: "",
  effectCategory: "all",
  effectPlugin: "all",
  effectFavorites: new Set(),
  effectFavoritesOnly: false,
  effectSelection: new Map(),
  effectGroupCollapsed: {},
  effectHoverStop: null,
  presetSelection: new Map(),
  pollTimer: null,
  pluginEffectPollTimer: null,
  logTimer: null,
  presetHoldTimer: null,
  presetHoverStop: null,
  presetDeletePath: "",
  presetDeleteName: "",
  presetRenamePath: "",
  presetOrganizer: { categories: [], assignments: {}, favorites: {} },
  presetCatalog: null,
  presetSourceFilter: "all",
  presetSyncing: false,
  presetCategory: "all",
  presetFavoritesOnly: false,
  categoryEditorMode: "create",
  categoryEditingId: "",
};

/* ---------- 工具 ---------- */

function toFileUrl(p) {
  if (!p) return "";
  const s = String(p).replace(/\\/g, "/");
  return "file:///" + encodeURI(s).replace(/#/g, "%23");
}

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function setStatus(text, isError) {
  const el = $("statusText");
  el.textContent = text;
  el.style.color = isError ? "var(--danger)" : "";
}

function pathKey(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

/* ---------- 分类栏：拖动宽度 / 收起展开（预设库、效果库共用） ---------- */

function createSidebarController(config) {
  const ids = config || {};
  let width = 200;
  let collapsed = false;

  function clampWidth(value) {
    const number = Number(value) || 200;
    return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(number)));
  }

  function readPrefs() {
    try {
      const storedWidth = parseInt(localStorage.getItem(ids.widthKey), 10);
      if (storedWidth) width = clampWidth(storedWidth);
      collapsed = localStorage.getItem(ids.collapsedKey) === "1";
    } catch {
      /* localStorage 不可用时使用默认值 */
    }
  }

  function apply() {
    const layout = $(ids.layoutId);
    const sidebar = $(ids.sidebarId);
    const handle = $(ids.resizerId);
    const expand = $(ids.expandId);
    if (!layout || !sidebar || !handle || !expand) return;
    layout.classList.toggle("sidebar-collapsed", collapsed);
    sidebar.style.width = collapsed ? "0px" : width + "px";
    handle.setAttribute("aria-valuenow", collapsed ? "0" : String(width));
    handle.tabIndex = collapsed ? -1 : 0;
    expand.hidden = !collapsed;
  }

  function persist() {
    try {
      localStorage.setItem(ids.widthKey, String(width));
      localStorage.setItem(ids.collapsedKey, collapsed ? "1" : "0");
    } catch {
      /* 持久化失败不影响本次使用 */
    }
  }

  function setCollapsed(next) {
    collapsed = !!next;
    apply();
    persist();
  }

  function init() {
    readPrefs();
    apply();

    const handle = $(ids.resizerId);
    const collapse = $(ids.collapseId);
    const expand = $(ids.expandId);
    if (collapse) collapse.addEventListener("click", () => setCollapsed(true));
    if (expand) expand.addEventListener("click", () => setCollapsed(false));
    if (!handle) return;

    let drag = null;
    const finishDrag = () => {
      if (!drag) return;
      drag = null;
      document.body.classList.remove("sidebar-resizing");
      persist();
    };
    handle.addEventListener("pointerdown", (event) => {
      if (collapsed || (event.button !== undefined && event.button !== 0)) return;
      drag = { startX: event.clientX, startWidth: width };
      document.body.classList.add("sidebar-resizing");
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* 某些环境不支持 pointer capture */
      }
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag) return;
      width = clampWidth(drag.startWidth + (event.clientX - drag.startX));
      apply();
    });
    handle.addEventListener("pointerup", finishDrag);
    handle.addEventListener("pointercancel", finishDrag);
    handle.addEventListener("lostpointercapture", finishDrag);
    handle.addEventListener("dblclick", () => setCollapsed(!collapsed));
    handle.addEventListener("keydown", (event) => {
      if (collapsed) return;
      const step = event.shiftKey ? 32 : 8;
      if (event.key === "ArrowLeft") {
        width = clampWidth(width - step);
      } else if (event.key === "ArrowRight") {
        width = clampWidth(width + step);
      } else if (event.key === "Home") {
        width = SIDEBAR_MIN;
      } else if (event.key === "End") {
        width = SIDEBAR_MAX;
      } else if (event.key === "Enter" || event.key === " ") {
        setCollapsed(true);
        return;
      } else {
        return;
      }
      event.preventDefault();
      apply();
      persist();
    });
  }

  return { init, apply, setCollapsed };
}

/* 预设库沿用原来的 localStorage 键，效果库用自己的一组键 */
const presetSidebar = createSidebarController({
  layoutId: "presetLayout",
  sidebarId: "presetSidebar",
  resizerId: "presetSidebarResizer",
  collapseId: "btnCollapseSidebar",
  expandId: "btnExpandSidebar",
  widthKey: PRESET_SIDEBAR_WIDTH_KEY,
  collapsedKey: PRESET_SIDEBAR_COLLAPSED_KEY,
});

const effectSidebar = createSidebarController({
  layoutId: "effectLayout",
  sidebarId: "effectSidebar",
  resizerId: "effectSidebarResizer",
  collapseId: "btnEffectCollapseSidebar",
  expandId: "btnEffectExpandSidebar",
  widthKey: EFFECT_SIDEBAR_WIDTH_KEY,
  collapsedKey: EFFECT_SIDEBAR_COLLAPSED_KEY,
});

/* 预设渲染、插件效果渲染、插件目录扫描共用同一套 AE 独占资源 */
function anyJobBusy() {
  return state.rendering || state.pluginEffectRendering || state.pluginCatalogScanning;
}

function hubHas(name) {
  return !!(window.hub && typeof window.hub[name] === "function");
}

/* ---------- 页签 ---------- */

function setView(name) {
  const pluginAlias = name === "pluginEffects";
  const target = pluginAlias ? "render" : name;
  state.view = target;
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.view === target);
  }
  $("viewPresets").hidden = target !== "presets";
  $("viewEffects").hidden = target !== "effects";
  $("viewRender").hidden = target !== "render";
  $("viewSettings").hidden = target !== "settings";

  if (target === "effects") loadEffects();
  else if (state.effectHoverStop) state.effectHoverStop();

  if (pluginAlias) setRenderMode("plugin");
  if (target === "render") {
    refreshAeState();
    if (state.renderMode === "plugin") {
      pullPluginEffectLog();
      window.hub.pluginEffectsSnapshot().then((last) => {
        if (last) paintPluginEffectProgress(last);
      });
    } else {
      pullLog();
    }
  } else if (!$("renderLogDialog").hidden) {
    closeRenderLog();
  }
  if (target !== "presets") closePresetDelete();
  if (target !== "presets") closePresetRename();
  if (target !== "presets") hideCategoryMenu();
  if (target !== "presets" && state.presetHoverStop) state.presetHoverStop();
  if (!(target === "render" && state.renderMode === "plugin")) closeEffectPicker();
}

function setRenderMode(mode) {
  if (anyJobBusy()) return;
  state.renderMode = mode === "plugin" ? "plugin" : "preset";
  $("presetRenderMode").hidden = state.renderMode !== "preset";
  $("pluginRenderMode").hidden = state.renderMode !== "plugin";
  for (const button of document.querySelectorAll(".render-mode-button")) {
    const active = button.dataset.renderMode === state.renderMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  }
  if (state.renderMode === "plugin") {
    refreshPluginCatalog();
  } else {
    closeEffectPicker();
  }
}

function updateRenderModeButtons() {
  const busy = anyJobBusy();
  for (const button of document.querySelectorAll(".render-mode-button")) {
    button.disabled = busy;
  }
  updatePresetSelectionUI();
}

/* ---------- 预设库 ---------- */

function categories() {
  return state.presetOrganizer.categories || [];
}

function categoryFor(target) {
  return String((state.presetOrganizer.assignments || {})[pathKey(target)] || "");
}

function categoryLabel(target) {
  const id = categoryFor(target);
  const hit = categories().find((row) => row.id === id);
  return hit ? hit.name : "";
}

function isPresetFavorite(target) {
  return !!(state.presetOrganizer.favorites || {})[pathKey(target)];
}

function renderCategories() {
  const list = $("categoryList");
  if (!list) return;
  const counts = { favorite: 0, all: state.presets.length, uncategorized: 0 };
  const aeCounts = {};
  for (const item of state.presets) {
    if (isPresetFavorite(item.path)) counts.favorite++;
    if (item.external) {
      const source = item.source || "AE 内置";
      aeCounts[source] = (aeCounts[source] || 0) + 1;
      continue;
    }
    const id = categoryFor(item.path);
    if (!id) counts.uncategorized++;
    else counts[id] = (counts[id] || 0) + 1;
  }
  list.textContent = "";
  list.appendChild(categoryRow("__favorites__", "收藏", counts.favorite));
  list.appendChild(categoryRow("all", "全部预设", counts.all));
  list.appendChild(categoryRow("__uncategorized__", "未分类", counts.uncategorized));
  if (categories().length) {
    list.appendChild(sidebarGroupTitle("我的分类"));
  }
  for (const category of categories()) {
    const row = categoryRow(category.id, category.name, counts[category.id] || 0);
    row.querySelector("button").addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openCategoryAdminMenu(category, event.clientX, event.clientY);
    });
    list.appendChild(row);
  }
  const aeSources = Object.keys(aeCounts).sort(
    (a, b) => aeCounts[b] - aeCounts[a] || a.localeCompare(b, "zh"),
  );
  if (aeSources.length) {
    list.appendChild(sidebarGroupTitle("AE 预设分类"));
    for (const source of aeSources) {
      list.appendChild(categoryRow("ae:" + source, source, aeCounts[source]));
    }
  }
}

function sidebarGroupTitle(label) {
  const li = document.createElement("li");
  li.className = "sidebar-group-title";
  li.textContent = label;
  return li;
}

function syncPresetSourceFilter() {
  const select = $("presetSourceFilter");
  if (select) select.value = state.presetSourceFilter;
}

/* 工具栏的「仅显示已收藏预设」是独立开关（与侧栏收藏分类选择分开） */
function syncPresetFavoritesOnlyButton() {
  const button = $("btnPresetFavoritesOnly");
  if (!button) return;
  button.setAttribute("aria-pressed", state.presetFavoritesOnly ? "true" : "false");
}

function categoryRow(id, label, count) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  const active = state.presetCategory === id;
  button.className =
    "category-item" + (id === "__favorites__" ? " favorite-category" : "") + (active ? " active" : "");
  const text = document.createElement("span");
  text.className = "category-label";
  text.textContent = label;
  const badge = document.createElement("span");
  badge.className = "category-count";
  badge.textContent = String(count);
  button.appendChild(text);
  button.appendChild(badge);
  button.addEventListener("click", () => {
    state.presetCategory = id;
    if (id === "__favorites__") {
      /* 收藏是「分类选择」：显示全部收藏，清掉搜索并重置来源 */
      state.presetSourceFilter = "all";
      state.query = "";
      const search = $("search");
      if (search) search.value = "";
    } else if (id.startsWith("ae:")) {
      state.presetSourceFilter = "external";
    } else if (id === "all") {
      state.presetSourceFilter = "all";
    } else {
      state.presetSourceFilter = "mine";
    }
    syncPresetSourceFilter();
    renderPresets();
  });
  li.appendChild(button);
  return li;
}

function bindFavoriteButton(thumb, item) {
  const active = isPresetFavorite(item.path);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card-favorite-toggle" + (active ? " active" : "");
  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.title = active ? "取消收藏" : "收藏";
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"/></svg>';
  button.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    cancelPresetHold();
  });
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await togglePresetFavorite(item);
  });
  button.addEventListener("dblclick", (event) => event.stopPropagation());
  thumb.appendChild(button);
}

function frameUrl(item, index) {
  if (!item.framePattern) return "";
  return toFileUrl(item.framePattern.replace("%04d", String(index).padStart(4, "0")));
}

function bindPresetHoverPreview(card, img, item) {
  if (!item.animated || item.frames <= 1 || !item.framePattern) return;
  const fps = Math.max(1, Number(item.fps) || 6);
  const delay = Math.max(40, Math.round(1000 / fps));
  const frames = [];
  let preloaded = false;
  let timer = null;
  let index = 0;

  function preload() {
    if (preloaded) return;
    preloaded = true;
    for (let i = 0; i < item.frames; i++) {
      const node = new Image();
      node.src = frameUrl(item, i);
      frames.push(node);
    }
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    index = 0;
    img.src = toFileUrl(item.thumb);
    if (state.presetHoverStop === stop) state.presetHoverStop = null;
  }

  card.addEventListener("mouseenter", () => {
    if (state.presetHoverStop && state.presetHoverStop !== stop) state.presetHoverStop();
    state.presetHoverStop = stop;
    preload();
    if (timer) clearInterval(timer);
    index = 0;
    img.src = frameUrl(item, 0) || toFileUrl(item.thumb);
    timer = setInterval(() => {
      index = (index + 1) % item.frames;
      img.src = frameUrl(item, index) || toFileUrl(item.thumb);
    }, delay);
  });
  card.addEventListener("mouseleave", stop);
}

function bindCategoryButton(thumb, item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card-category-toggle";
  button.title = "移动到分类";
  button.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v10H3z"/></svg>';
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const rect = button.getBoundingClientRect();
    openCategoryMenu(item, rect.left, rect.bottom + 4);
  });
  button.addEventListener("dblclick", (event) => event.stopPropagation());
  thumb.appendChild(button);
}

function hideCategoryMenu() {
  $("categoryMenu").hidden = true;
}

function showCategoryMenu(x, y) {
  const menu = $("categoryMenu");
  menu.hidden = false;
  const width = menu.offsetWidth || 190;
  const height = menu.offsetHeight || 0;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - width - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - height - 8)) + "px";
}

function menuTitle(text) {
  const node = document.createElement("div");
  node.className = "preset-category-menu-title";
  node.textContent = text;
  return node;
}

function menuButton(label, active, danger, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = (active ? "active" : "") + (danger ? " danger" : "");
  button.textContent = label;
  button.addEventListener("click", () => {
    hideCategoryMenu();
    action();
  });
  return button;
}

function openCategoryMenu(item, x, y) {
  const menu = $("categoryMenu");
  menu.textContent = "";
  menu.appendChild(menuTitle("移动到分类"));
  const current = categoryFor(item.path);
  menu.appendChild(menuButton("未分类", !current, false, () => assignCategory(item, "")));
  for (const category of categories()) {
    menu.appendChild(menuButton(category.name, current === category.id, false, () =>
      assignCategory(item, category.id),
    ));
  }
  showCategoryMenu(x, y);
}

function openPresetMenu(item, x, y) {
  const menu = $("categoryMenu");
  menu.textContent = "";
  menu.appendChild(menuTitle(item.name));
  const favorite = isPresetFavorite(item.path);
  if (!item.external) {
    menu.appendChild(menuButton("重命名", false, false, () => openPresetRename(item)));
  }
  menu.appendChild(menuButton(favorite ? "取消收藏" : "收藏", false, false, () =>
    togglePresetFavorite(item),
  ));
  if (item.rendered) {
    menu.appendChild(menuButton("取消渲染", false, false, () => clearPresetRender(item)));
  }
  menu.appendChild(menuButton("单独渲染", false, false, () => renderSinglePreset(item)));
  if (item.external) {
    menu.appendChild(
      menuButton("打开所在文件夹", false, false, () => window.hub.reveal(item.path)),
    );
  } else {
    menu.appendChild(menuButton("删除预设", false, true, () => openPresetDelete(item)));

    const separator = document.createElement("div");
    separator.className = "preset-category-menu-separator";
    menu.appendChild(separator);
    menu.appendChild(menuTitle("移动到分类"));
    const current = categoryFor(item.path);
    menu.appendChild(menuButton("未分类", !current, false, () => assignCategory(item, "")));
    for (const category of categories()) {
      menu.appendChild(menuButton(category.name, current === category.id, false, () =>
        assignCategory(item, category.id),
      ));
    }
  }
  showCategoryMenu(x, y);
}

function openCategoryAdminMenu(category, x, y) {
  const menu = $("categoryMenu");
  menu.textContent = "";
  menu.appendChild(menuTitle(category.name));
  menu.appendChild(menuButton("重命名", false, false, () =>
    openCategoryEditor("rename", category),
  ));
  menu.appendChild(menuButton("删除", false, true, () => deleteCategory(category)));
  showCategoryMenu(x, y);
}

function openCategoryEditor(mode, category) {
  state.categoryEditorMode = mode;
  state.categoryEditingId = category ? category.id : "";
  $("categoryEditor").hidden = false;
  $("categoryName").value = category ? category.name : "";
  $("categoryName").focus();
}

function closeCategoryEditor() {
  $("categoryEditor").hidden = true;
  $("categoryName").value = "";
  state.categoryEditingId = "";
}

async function saveCategory(event) {
  event.preventDefault();
  const name = $("categoryName").value.trim();
  if (!name) return;
  const result =
    state.categoryEditorMode === "rename"
      ? await window.hub.renamePresetCategory(state.categoryEditingId, name)
      : await window.hub.createPresetCategory(name);
  if (!result.ok) {
    setStatus("分类名称已存在", true);
    return;
  }
  state.presetOrganizer = result.doc;
  closeCategoryEditor();
  setStatus(state.categoryEditorMode === "rename" ? "分类已重命名" : "已新建分类");
  renderPresets();
}

async function assignCategory(item, id) {
  const result = await window.hub.assignPresetCategory(item.path, id);
  if (!result.ok) return;
  state.presetOrganizer = result.doc;
  renderPresets();
}

async function togglePresetFavorite(item) {
  const result = await window.hub.togglePresetFavorite(item.path);
  if (!result.ok) return;
  state.presetOrganizer = result.doc;
  setStatus(result.favorite ? `已收藏「${item.name}」` : `已取消收藏「${item.name}」`);
  renderPresets();
}

async function clearPresetRender(item) {
  if (state.rendering) {
    setStatus("请先停止当前渲染任务，再清空预设预览", true);
    return;
  }
  const result = await window.hub.clearPresetRender(item.path);
  if (!result.ok) return;
  await loadPresets();
  setStatus(`已清空「${item.name}」的预览，下次批渲会重新加入`);
}

async function deleteCategory(category) {
  const result = await window.hub.deletePresetCategory(category.id);
  if (!result.ok) return;
  state.presetOrganizer = result.doc;
  if (state.presetCategory === category.id) state.presetCategory = "all";
  setStatus(`已删除分类「${category.name}」`);
  renderPresets();
}

async function loadPresetCategories() {
  state.presetOrganizer = await window.hub.loadPresetCategories();
}

function openPresetRename(item) {
  state.presetRenamePath = item.path;
  $("presetRenameDialog").hidden = false;
  $("presetRenameInput").value = item.name;
  $("presetRenameInput").focus();
  $("presetRenameInput").select();
}

function closePresetRename() {
  state.presetRenamePath = "";
  $("presetRenameDialog").hidden = true;
  $("presetRenameInput").value = "";
}

async function savePresetRename(event) {
  event.preventDefault();
  const target = state.presetRenamePath;
  const name = $("presetRenameInput").value.trim();
  if (!target || !name) return;
  const result = await window.hub.renamePreset(target, name);
  if (!result.ok) {
    const messages = {
      invalid_name: "文件名包含不允许的字符",
      name_exists: "同名预设已经存在",
      outside_library: "只能重命名预设库内的文件",
    };
    setStatus(messages[result.reason] || "重命名失败：" + (result.reason || "未知原因"), true);
    return;
  }
  closePresetRename();
  await loadPresetCategories();
  await loadPresets();
  setStatus(`已重命名为「${result.name}」`);
}

function visiblePresets() {
  const query = state.query.trim().toLowerCase();
  return state.presets.filter((item) => {
    if (state.presetSourceFilter === "mine" && item.external) return false;
    if (state.presetSourceFilter === "external" && !item.external) return false;
    if (query) {
      const haystack = [item.name, item.fileName, item.source, item.path]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (state.presetFavoritesOnly && !isPresetFavorite(item.path)) return false;
    const cat = categoryFor(item.path);
    if (state.presetCategory === "__favorites__") {
      return isPresetFavorite(item.path);
    }
    if (state.presetCategory === "__uncategorized__") {
      return !item.external && !cat;
    }
    if (state.presetCategory.startsWith("ae:")) {
      return item.external && (item.source || "AE 内置") === state.presetCategory.slice(3);
    }
    if (state.presetCategory !== "all") {
      return !item.external && cat === state.presetCategory;
    }
    return true;
  });
}

function renderPresets() {
  const grid = $("grid");
  if (state.presetHoverStop) state.presetHoverStop();
  const items = visiblePresets();

  grid.textContent = "";
  renderCategories();
  syncPresetFavoritesOnlyButton();

  const empty = $("emptyPresets");
  empty.hidden = items.length > 0;
  grid.hidden = items.length === 0;

  for (const item of items) {
    const card = document.createElement("div");
    card.className =
      "card" + (item.external ? " external" : "") + (isPresetSelected(item.path) ? " selected" : "");
    card.dataset.path = item.path;

    const thumb = document.createElement("div");
    thumb.className = "card-thumb";

    if (item.rendered && item.thumb) {
      const img = document.createElement("img");
      img.src = toFileUrl(item.thumb);
      img.alt = item.name;
      img.loading = "lazy";
      thumb.appendChild(img);
      bindPresetHoverPreview(card, img, item);
      if (!item.animated || item.frames <= 1) {
        const dot = document.createElement("span");
        dot.className = "card-static-dot";
        dot.title = "静止帧";
        thumb.appendChild(dot);
      }
    } else {
      const ph = document.createElement("div");
      ph.className = "placeholder";
      ph.textContent = item.external ? "AE 预设 · 待渲染" : "待渲染";
      thumb.appendChild(ph);
    }
    bindPresetSelectCheckbox(thumb, item);
    bindFavoriteButton(thumb, item);
    if (!item.external) bindCategoryButton(thumb, item);

    const body = document.createElement("div");
    body.className = "card-body";

    const titleRow = document.createElement("div");
    titleRow.className = "card-title-row";
    const name = document.createElement("div");
    name.className = "card-name";
    name.textContent = item.name;
    name.title = item.name;

    const size = document.createElement("span");
    size.className = "card-size";
    size.textContent = formatSize(item.size);

    const category = document.createElement("div");
    category.className = "card-category";
    category.textContent = item.external
      ? `AE ${state.presetCatalog && state.presetCatalog.aeMajor ? state.presetCatalog.aeMajor : ""} · ${item.source || "外部预设"}`
      : categoryLabel(item.path) || "未分类";

    titleRow.appendChild(name);
    titleRow.appendChild(size);
    body.appendChild(titleRow);
    body.appendChild(category);
    card.appendChild(thumb);
    card.appendChild(body);
    if (!item.external) bindPresetLongPress(card, item);
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openPresetMenu(item, event.clientX, event.clientY);
    });
    grid.appendChild(card);
  }

  $("tabPresetCount").textContent = String(state.presets.length);
  updatePresetSelectionUI();
}

function isPresetSelected(target) {
  return state.presetSelection.has(pathKey(target));
}

function setPresetSelected(item, selected) {
  const key = pathKey(item.path);
  if (selected) state.presetSelection.set(key, item.path);
  else state.presetSelection.delete(key);
  updatePresetSelectionUI();
  setStatus(
    state.presetSelection.size
      ? `已选择 ${state.presetSelection.size} 个预设`
      : "已清空预设选择",
  );
}

function bindPresetSelectCheckbox(thumb, item) {
  const label = document.createElement("label");
  label.className = "card-select";
  label.title = "选择这个预设用于渲染";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = isPresetSelected(item.path);
  box.setAttribute("aria-label", "选择 " + item.name);
  label.appendChild(box);

  const swallow = (event) => {
    event.stopPropagation();
    cancelPresetHold();
  };
  label.addEventListener("pointerdown", swallow);
  label.addEventListener("click", swallow);
  label.addEventListener("dblclick", (event) => event.stopPropagation());
  box.addEventListener("change", () => setPresetSelected(item, box.checked));
  thumb.appendChild(label);
}

function updatePresetSelectionUI() {
  const count = state.presetSelection.size;
  const renderBtn = $("btnRenderSelected");
  renderBtn.textContent = `渲染所选 (${count})`;
  renderBtn.disabled = count === 0 || anyJobBusy();
  $("btnClearSelection").disabled = count === 0;

  for (const card of document.querySelectorAll("#grid .card")) {
    const selected = state.presetSelection.has(pathKey(card.dataset.path || ""));
    card.classList.toggle("selected", selected);
    const box = card.querySelector(".card-select input");
    if (box && box.checked !== selected) box.checked = selected;
  }

  const rendered = state.presets.filter((p) => p.rendered).length;
  const mine = state.presets.filter((p) => !p.external).length;
  const external = state.presets.length - mine;
  const parts = [];
  if (state.presets.length) {
    parts.push(`${mine} 个我的预设`);
    if (external) parts.push(`${external} 个 AE 预设`);
    parts.push(`已生成 ${rendered} 个预览`);
  }
  if (count) parts.push(`已选 ${count} 个`);
  $("presetHint").textContent = parts.join(" · ");
}

function selectUnrenderedPresets() {
  const candidates = visiblePresets().filter((item) => !item.rendered);
  if (!candidates.length) {
    setStatus("当前筛选下没有未渲染的预设", true);
    return;
  }
  for (const item of candidates) {
    state.presetSelection.set(pathKey(item.path), item.path);
  }
  updatePresetSelectionUI();
  setStatus(`已选择 ${candidates.length} 个未渲染预设`);
}

function clearPresetSelection() {
  if (!state.presetSelection.size) return;
  state.presetSelection.clear();
  updatePresetSelectionUI();
  setStatus("已清空预设选择");
}

function prunePresetSelection() {
  const alive = new Set(state.presets.map((item) => pathKey(item.path)));
  for (const key of [...state.presetSelection.keys()]) {
    if (!alive.has(key)) state.presetSelection.delete(key);
  }
}

async function renderSelectedPresets() {
  const paths = [...state.presetSelection.values()];
  if (!paths.length) return;
  if (anyJobBusy()) {
    setStatus("已有渲染任务在运行，请先等待结束或停止", true);
    return;
  }
  if (paths.length > 50) {
    const ok = window.confirm(
      `将渲染 ${paths.length} 个预设，可能需要很长时间。确定继续吗？`,
    );
    if (!ok) return;
  }
  setRenderMode("preset");
  const started = await startRender({
    presetPaths: paths,
    force: true,
    limit: paths.length,
  });
  if (started) setView("render");
}

async function loadPresets(options = {}) {
  if (!options.skipSync && hubHas("syncAePresets")) {
    const ae = $("renderAeVersion") ? $("renderAeVersion").value : "";
    try {
      const synced = await window.hub.syncAePresets({ ae, force: !!options.force });
      if (synced && synced.ok) state.presetCatalog = synced;
    } catch {
      /* 同步失败不阻塞预设库读取 */
    }
  }
  const data = await window.hub.listPresets();
  state.presets = data.items || [];
  prunePresetSelection();
  renderPresets();
  updatePresetSourceOptions();
}

function updatePresetSourceOptions() {
  const select = $("presetSourceFilter");
  if (!select) return;
  const external = state.presets.filter((item) => item.external).length;
  for (const option of select.options) {
    if (option.value === "external") {
      option.textContent = external ? `AE 预设 (${external})` : "AE 预设";
    }
  }
}

async function syncAePresets(force) {
  if (state.presetSyncing) return;
  if (!hubHas("syncAePresets")) {
    setStatus("主进程尚未提供 AE 预设同步接口", true);
    return;
  }
  state.presetSyncing = true;
  $("btnSyncAePresets").disabled = true;
  setStatus("正在同步 AE 预设（只建索引，不复制文件）…");
  try {
    const ae = $("renderAeVersion").value || "";
    const result = await window.hub.syncAePresets({ ae, force: !!force });
    if (!result || !result.ok) {
      const reason = (result && result.reason) || "";
      setStatus(
        reason === "no_ae" ? "没有找到可用的 After Effects" : "同步 AE 预设失败：" + reason,
        true,
      );
      return;
    }
    await loadPresets({ skipSync: true });
    const suffix = result.cached ? "（缓存）" : "";
    setStatus(`已同步 ${result.count} 个 AE ${result.aeMajor || ""} 预设${suffix}`);
  } finally {
    state.presetSyncing = false;
    $("btnSyncAePresets").disabled = false;
  }
}

function bindPresetLongPress(card, item) {
  if (item.external) return;
  card.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    cancelPresetHold();
    state.presetHoldTimer = setTimeout(() => {
      state.presetHoldTimer = null;
      openPresetDelete(item);
    }, 650);
  });
  card.addEventListener("pointerup", cancelPresetHold);
  card.addEventListener("pointerleave", cancelPresetHold);
  card.addEventListener("pointercancel", cancelPresetHold);
}

function cancelPresetHold() {
  if (!state.presetHoldTimer) return;
  clearTimeout(state.presetHoldTimer);
  state.presetHoldTimer = null;
}

function openPresetDelete(item) {
  if (item.external) {
    setStatus("AE 外部预设不能从预设库删除，请到 AE 预设目录中管理", true);
    return;
  }
  state.presetDeletePath = item.path;
  state.presetDeleteName = item.name;
  $("presetDeleteText").textContent =
    `确定删除预设「${item.name}」？对应的 .ffx 文件会从预设库中移除。`;
  const confirm = $("presetDeleteConfirm");
  confirm.disabled = false;
  $("presetDeleteDialog").hidden = false;
}

function closePresetDelete() {
  cancelPresetHold();
  state.presetDeletePath = "";
  state.presetDeleteName = "";
  $("presetDeleteDialog").hidden = true;
}

async function confirmPresetDelete() {
  const target = state.presetDeletePath;
  const name = state.presetDeleteName;
  if (!target) return;
  const confirm = $("presetDeleteConfirm");
  confirm.disabled = true;
  const result = await window.hub.deletePreset(target);
  if (!result || !result.ok) {
    confirm.disabled = false;
    setStatus("删除预设失败：" + ((result && result.reason) || "未知原因"), true);
    return;
  }
  closePresetDelete();
  setStatus(`已删除预设「${name}」`);
  await loadPresets();
}

async function finishAddPresets(result) {
  const imported = result.imported || [];
  const skipped = result.skipped || [];
  if (imported.length) {
    setStatus(`已添加 ${imported.length} 个预设`);
    await loadPresets();
  } else if (skipped.length) {
    setStatus("没有添加任何文件（只接受 .ffx）", true);
  }
}

async function addPresets() {
  await finishAddPresets(await window.hub.pickPresets());
}

async function addDroppedPresets(files) {
  const paths = [];
  for (const file of files) {
    try {
      const path = window.hub.getPathForFile(file);
      if (path) paths.push(path);
    } catch {
      /* 非文件拖拽不进入导入流程 */
    }
  }
  if (!paths.length) {
    setStatus("没有读取到可添加的文件", true);
    return;
  }
  await finishAddPresets(await window.hub.importPaths(paths));
}

/* ---------- 效果库 ---------- */

/* 效果库只读展示 AE 扫描结果：分类栏按插件分组（内置统一显示为「AE 内置」），
 * 不支持新建/重命名/右键菜单，分类会跟着「同步 AE 分类」自动更新。 */
const EFFECT_GROUP_BUILTIN = "AE 内置";
const EFFECT_GROUP_FALLBACK = "其它插件";

function effectGroupLabel(item) {
  if (!item || item.source === "builtin") return EFFECT_GROUP_BUILTIN;
  return String(item.plugin || EFFECT_GROUP_FALLBACK);
}

function effectGroupFromKey(key) {
  return String(key || "").split("\u0000")[0];
}

function effectCategoryKey(item) {
  return String((item && item.category) || "");
}

function effectCategoryLabel(item) {
  return effectCategoryKey(item) || "未分类";
}

/* hasPreview 由数据层给出；老数据没有该字段时退回看 framePattern */
function effectHasPreview(item) {
  if (item && typeof item.hasPreview === "boolean") return item.hasPreview;
  return !!(item && item.framePattern);
}

function effectStatusLabel(item) {
  if (item && item.status === "pending") return "待渲染";
  if (item && item.status === "blacklisted") return "已跳过";
  return "暂无预览";
}

/* ---------- 效果库：收藏 / 选择 ---------- */

function effectIsFavorite(matchName) {
  return state.effectFavorites.has(String(matchName || ""));
}

function applyEffectFavorites(list) {
  state.effectFavorites = new Set();
  for (const name of list || []) {
    const key = String(name || "");
    if (key) state.effectFavorites.add(key);
  }
}

/* 就地更新星标状态，避免收藏一次就重建 1000+ 张卡片 */
function updateEffectFavoriteButtons() {
  const grid = $("effectGrid");
  if (!grid) return;
  for (const card of grid.children) {
    const matchName = String((card.dataset && card.dataset.matchName) || "");
    const active = effectIsFavorite(matchName);
    const thumb = card.children[0];
    if (!thumb) continue;
    for (const child of thumb.children) {
      if (!String(child.className || "").includes("card-favorite-toggle")) continue;
      child.classList.toggle("active", active);
      child.setAttribute("aria-pressed", active ? "true" : "false");
      child.title = active ? "取消收藏" : "收藏";
    }
  }
}

function effectIsSelected(matchName) {
  return state.effectSelection.has(String(matchName || ""));
}

function effectSelectionBox(card) {
  const thumb = card && card.children && card.children[0];
  if (!thumb) return null;
  for (const child of thumb.children) {
    if (!String(child.className || "").includes("card-select")) continue;
    const box = child.children[0];
    if (box && box.type === "checkbox") return box;
  }
  return null;
}

function updateEffectSelectionUI() {
  const count = state.effectSelection.size;
  const renderBtn = $("btnEffectRenderSelected");
  if (renderBtn) {
    renderBtn.textContent = `渲染所选 (${count})`;
    renderBtn.disabled = count === 0 || anyJobBusy();
  }
  const clearBtn = $("btnEffectClearSelection");
  if (clearBtn) clearBtn.disabled = count === 0;

  const grid = $("effectGrid");
  if (!grid) return;
  for (const card of grid.children) {
    const matchName = String((card.dataset && card.dataset.matchName) || "");
    const selected = effectIsSelected(matchName);
    card.classList.toggle("selected", selected);
    const box = effectSelectionBox(card);
    if (box && box.checked !== selected) box.checked = selected;
  }
}

/* 数据刷新后丢掉已经不存在的选择项，并换成最新的条目对象 */
function pruneEffectSelection() {
  const alive = new Map();
  for (const item of state.effects) {
    if (item.renderable) alive.set(String(item.matchName || ""), item);
  }
  for (const key of [...state.effectSelection.keys()]) {
    if (!alive.has(key)) state.effectSelection.delete(key);
    else state.effectSelection.set(key, alive.get(key));
  }
}

/* 来源分组顺序：AE 内置第一，其它插件按名称排，「其它插件」最后 */
function compareEffectGroupLabels(a, b) {
  if (a === EFFECT_GROUP_BUILTIN) return -1;
  if (b === EFFECT_GROUP_BUILTIN) return 1;
  if (a === EFFECT_GROUP_FALLBACK) return 1;
  if (b === EFFECT_GROUP_FALLBACK) return -1;
  return a.localeCompare(b, "zh-CN");
}

/* 按 items 原顺序分组：组内分类按首次出现顺序，组间顺序再按来源排序 */
function effectGroups() {
  const groups = [];
  const byLabel = new Map();
  for (const item of state.effects) {
    const label = effectGroupLabel(item);
    let group = byLabel.get(label);
    if (!group) {
      group = { label, items: [], categories: [], categoryMap: new Map() };
      byLabel.set(label, group);
      groups.push(group);
    }
    group.items.push(item);
    const category = effectCategoryKey(item);
    if (!category) continue;
    let row = group.categoryMap.get(category);
    if (!row) {
      row = { category, count: 0 };
      group.categoryMap.set(category, row);
      group.categories.push(row);
    }
    row.count++;
  }
  groups.sort((a, b) => compareEffectGroupLabels(a.label, b.label));
  return groups;
}

function visibleEffects() {
  const query = state.effectQuery.trim().toLowerCase();
  return state.effects.filter((item) => {
    if (state.effectFavoritesOnly && !effectIsFavorite(item.matchName)) return false;
    if (state.effectPlugin !== "all" && effectGroupLabel(item) !== state.effectPlugin) return false;
    if (state.effectCategory !== "all") {
      const category = effectCategoryKey(item);
      if (state.effectCategory === "__favorites__") {
        if (!effectIsFavorite(item.matchName)) return false;
      } else if (state.effectCategory === "__uncategorized__") {
        if (category) return false;
      } else if (effectGroupLabel(item) + "\u0000" + category !== state.effectCategory) {
        return false;
      }
    }
    if (!query) return true;
    const haystack = [
      item.name,
      item.nameZh,
      item.nameEn,
      item.matchName,
      item.displayName,
      item.category,
      item.categoryZh,
      item.categoryEn,
      item.plugin,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function effectCategoryRow(id, label, count) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  const active = state.effectCategory === id;
  button.className =
    "category-item" + (id === "__favorites__" ? " favorite-category" : "") + (active ? " active" : "");
  const text = document.createElement("span");
  text.className = "category-label";
  text.textContent = label;
  const badge = document.createElement("span");
  badge.className = "category-count";
  badge.textContent = String(count);
  button.appendChild(text);
  button.appendChild(badge);
  button.addEventListener("click", () => {
    state.effectCategory = id;
    if (id === "__favorites__") {
      /* 收藏是「分类选择」：显示全部收藏，清掉搜索并重置来源 */
      state.effectPlugin = "all";
      state.effectQuery = "";
      const search = $("effectSearch");
      if (search) search.value = "";
    } else if (id === "all" || id === "__uncategorized__") {
      state.effectPlugin = "all";
    } else {
      state.effectPlugin = effectGroupFromKey(id);
    }
    paintEffectsLibrary();
  });
  li.appendChild(button);
  return li;
}

function renderEffectCategories(groups) {
  const list = $("effectCategoryList");
  if (!list) return;
  const available = new Set(["all", "__uncategorized__", "__favorites__"]);
  for (const group of groups) {
    for (const row of group.categories) {
      available.add(group.label + "\u0000" + row.category);
    }
  }
  if (!available.has(state.effectCategory)) state.effectCategory = "all";

  list.textContent = "";
  list.appendChild(
    effectCategoryRow(
      "__favorites__",
      "收藏",
      state.effects.filter((item) => effectIsFavorite(item.matchName)).length,
    ),
  );
  list.appendChild(effectCategoryRow("all", "全部效果", state.effects.length));
  const uncategorized = state.effects.filter((item) => !effectCategoryKey(item)).length;
  if (uncategorized) {
    list.appendChild(effectCategoryRow("__uncategorized__", "未分类", uncategorized));
  }
  for (const group of groups) {
    const collapsed = !!state.effectGroupCollapsed[group.label];
    list.appendChild(effectGroupHeaderRow(group, collapsed));
    if (collapsed) continue;
    for (const row of group.categories) {
      list.appendChild(
        effectCategoryRow(group.label + "\u0000" + row.category, row.category, row.count),
      );
    }
  }
}

/* 来源分组头：可点击折叠，箭头 ▾（展开）/ ▸（收起），状态持久化在 localStorage */
function effectGroupHeaderRow(group, collapsed) {
  const li = document.createElement("li");
  li.className = "effect-group-toggle";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "category-item category-group-head" + (collapsed ? " collapsed" : "");
  button.setAttribute("aria-expanded", collapsed ? "false" : "true");
  const rendered = group.items.filter((item) => effectHasPreview(item)).length;
  button.title =
    `共 ${group.items.length} 条` + (rendered ? `，已生成 ${rendered} 条` : "");
  const arrow = document.createElement("span");
  arrow.className = "group-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "▾";
  const label = document.createElement("span");
  label.className = "category-label";
  label.textContent = group.label;
  const count = document.createElement("span");
  count.className = "category-count";
  count.textContent = String(group.items.length);
  button.appendChild(arrow);
  button.appendChild(label);
  button.appendChild(count);
  button.addEventListener("click", () => toggleEffectGroupCollapsed(group.label));
  li.appendChild(button);
  return li;
}

function readEffectCollapsedGroups() {
  try {
    const raw = localStorage.getItem(EFFECT_GROUP_COLLAPSED_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const [label, value] of Object.entries(parsed)) {
      if (value) state.effectGroupCollapsed[label] = true;
    }
  } catch {
    /* 本地状态损坏时按全部展开处理 */
  }
}

function saveEffectCollapsedGroups() {
  try {
    const doc = {};
    for (const [label, value] of Object.entries(state.effectGroupCollapsed)) {
      if (value) doc[label] = true;
    }
    localStorage.setItem(EFFECT_GROUP_COLLAPSED_KEY, JSON.stringify(doc));
  } catch {
    /* 持久化失败不影响本次使用 */
  }
}

function toggleEffectGroupCollapsed(label) {
  if (state.effectGroupCollapsed[label]) delete state.effectGroupCollapsed[label];
  else state.effectGroupCollapsed[label] = true;
  saveEffectCollapsedGroups();
  /* 只重绘分类栏：折叠不影响网格，避免 1000+ 张卡片跟着重建 */
  renderEffectCategories(effectGroups());
}

function fillEffectPluginSelect(groups) {
  const select = $("effectPluginFilter");
  if (!select) return;
  const labels = groups.map((group) => group.label);
  if (state.effectPlugin !== "all" && !labels.includes(state.effectPlugin)) {
    state.effectPlugin = "all";
  }
  select.textContent = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "全部来源";
  select.appendChild(all);
  for (const label of labels) {
    const option = document.createElement("option");
    option.value = label;
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = state.effectPlugin;
}

function effectSpritePosition(item) {
  const cellSize = Math.max(1, Number(item.cellSize) || 128);
  const columns = Math.max(1, Number(item.columns) || 1);
  const rows = Math.max(1, Number(item.rows) || 1);
  const x = Number(item.x) || 0;
  const y = Number(item.y) || 0;
  const posX = columns > 1 ? (x / cellSize / (columns - 1)) * 100 : 0;
  const posY = rows > 1 ? (y / cellSize / (rows - 1)) * 100 : 0;
  return {
    size: `${columns * 100}% ${rows * 100}%`,
    position: `${posX.toFixed(4)}% ${posY.toFixed(4)}%`,
  };
}

/* 内置是 8×8 整网、插件是单行 8 格：用背景百分比裁切，格子永远精确等于缩略框 */
function applyEffectPreview(preview, item, frameIndex) {
  if (!preview) return;
  const slice = effectSpritePosition(item);
  preview.style.backgroundSize = slice.size;
  preview.style.backgroundPosition = slice.position;
  const url = frameUrl(item, frameIndex);
  if (url) preview.style.backgroundImage = `url("${url}")`;
}

function bindEffectHoverPreview(card, preview, item) {
  if (!item.animated || Number(item.frames) <= 1 || !item.framePattern) return;
  const frames = Math.max(1, Number(item.frames) || 1);
  const fps = Math.max(1, Number(item.fps) || 12);
  const delay = Math.max(40, Math.round(1000 / fps));
  const stillFrame = Math.min(frames - 1, Math.max(0, Number(item.stillFrame) || 0));
  const frameNodes = [];
  let preloaded = false;
  let timer = null;

  function preload() {
    if (preloaded) return;
    preloaded = true;
    for (let i = 0; i < frames; i++) {
      const node = new Image();
      node.src = frameUrl(item, i);
      frameNodes.push(node);
    }
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    applyEffectPreview(preview, item, stillFrame);
    if (state.effectHoverStop === stop) state.effectHoverStop = null;
  }

  card.addEventListener("mouseenter", () => {
    if (state.effectHoverStop && state.effectHoverStop !== stop) state.effectHoverStop();
    state.effectHoverStop = stop;
    preload();
    if (timer) clearInterval(timer);
    let index = 0;
    applyEffectPreview(preview, item, index);
    timer = setInterval(() => {
      index = (index + 1) % frames;
      applyEffectPreview(preview, item, index);
    }, delay);
  });
  card.addEventListener("mouseleave", stop);
}

function bindEffectFavoriteButton(thumb, item) {
  const active = effectIsFavorite(item.matchName);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card-favorite-toggle" + (active ? " active" : "");
  button.dataset.matchName = String(item.matchName || "");
  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.title = active ? "取消收藏" : "收藏";
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"/></svg>';
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await toggleEffectFavorite(item);
  });
  button.addEventListener("dblclick", (event) => event.stopPropagation());
  thumb.appendChild(button);
}

function bindEffectSelectCheckbox(thumb, item) {
  if (!item.renderable) return;
  const label = document.createElement("label");
  label.className = "card-select";
  label.title = "选择这个效果用于渲染";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = effectIsSelected(item.matchName);
  box.setAttribute("aria-label", "选择 " + effectDisplayName(item));
  label.appendChild(box);
  const swallow = (event) => event.stopPropagation();
  label.addEventListener("pointerdown", swallow);
  label.addEventListener("click", swallow);
  label.addEventListener("dblclick", swallow);
  box.addEventListener("change", () => {
    const matchName = String(item.matchName || "");
    if (box.checked) state.effectSelection.set(matchName, item);
    else state.effectSelection.delete(matchName);
    updateEffectSelectionUI();
    paintEffectHint(visibleEffects().length);
    setStatus(
      state.effectSelection.size
        ? `已选择 ${state.effectSelection.size} 个效果`
        : "已清空效果选择",
    );
  });
  thumb.appendChild(label);
}

async function toggleEffectFavorite(item) {
  const matchName = String((item && item.matchName) || "");
  if (!matchName) return;
  if (!hubHas("toggleEffectFavorite")) {
    setStatus("主进程尚未提供效果收藏接口", true);
    return;
  }
  let result = null;
  try {
    result = await window.hub.toggleEffectFavorite(matchName);
  } catch {
    result = null;
  }
  if (!result || !result.ok) {
    setStatus("收藏失败：" + ((result && result.reason) || "未知原因"), true);
    return;
  }
  applyEffectFavorites(result.items);
  if (state.effectFavoritesOnly || state.effectCategory === "__favorites__") {
    paintEffectsLibrary();
  } else {
    updateEffectFavoriteButtons();
    renderEffectCategories(effectGroups());
    paintEffectHint(visibleEffects().length);
  }
  setStatus(
    result.favorite
      ? `已收藏「${effectDisplayName(item)}」`
      : `已取消收藏「${effectDisplayName(item)}」`,
  );
}

function selectUnrenderedEffects() {
  const candidates = visibleEffects().filter(
    (item) => item.renderable && !item.hasPreview && item.status === "pending",
  );
  if (!candidates.length) {
    setStatus("当前筛选下没有待渲染的插件效果", true);
    return;
  }
  for (const item of candidates) {
    state.effectSelection.set(String(item.matchName || ""), item);
  }
  updateEffectSelectionUI();
  paintEffectHint(visibleEffects().length);
  setStatus(`已选择 ${candidates.length} 个待渲染效果`);
}

function clearEffectLibrarySelection() {
  if (!state.effectSelection.size) return;
  state.effectSelection.clear();
  updateEffectSelectionUI();
  paintEffectHint(visibleEffects().length);
  setStatus("已清空效果选择");
}

/* 与渲染页「选择效果」共用同一个 startPluginEffects 接口 */
async function startEffectRender(matchNames, force, progressMessage) {
  const names = (matchNames || []).map((name) => String(name || "")).filter(Boolean);
  if (!names.length) return false;
  if (anyJobBusy()) {
    setStatus("已有渲染任务在运行，请先等待结束或停止", true);
    return false;
  }
  if (!hubHas("startPluginEffects")) {
    setStatus("主进程尚未提供插件效果渲染接口", true);
    return false;
  }
  setRenderMode("plugin");
  let result = null;
  try {
    result = await window.hub.startPluginEffects({
      matchNames: names,
      force: !!force,
      ae: $("pluginEffectAeVersion").value,
      background: $("pluginEffectBackground").value || "",
      limit: Math.max(8, names.length),
      rounds: Math.max(20, names.length * 2),
    });
  } catch {
    result = null;
  }
  if (!result || !result.ok) {
    const reason = (result && result.reason) || "";
    const messages = {
      nothing_to_render: "所选条目均已生成或已跳过；勾选强制重渲后再试",
      no_catalog: "还没有插件目录，请先扫描插件目录",
      already_running: "已有渲染任务在运行，请稍后再试",
      preset_render_running: "预设渲染进行中，结束后才能生成插件效果",
      write_failed: "写入效果选择文件失败，请重试",
    };
    setStatus(messages[reason] || "启动失败：" + (reason || "未知原因"), true);
    return false;
  }
  const selected = Number(result.selectedCount) || names.length;
  const skipped = Number(result.skippedCount) || 0;
  beginPluginEffectRun(
    skipped
      ? `已开始渲染所选 ${selected} 条插件效果（跳过 ${skipped} 条）`
      : `已开始渲染所选 ${selected} 条插件效果`,
    progressMessage || `正在渲染所选 ${selected} 条插件效果…`,
  );
  setView("render");
  return true;
}

async function renderSelectedEffects() {
  const items = [...state.effectSelection.values()];
  if (!items.length) return;
  const force = items.some((item) => item.hasPreview || item.status === "blacklisted");
  await startEffectRender(items.map((item) => item.matchName), force);
}

async function renderSingleEffect(item) {
  if (!item || !item.renderable) {
    setStatus("这个效果不能单独渲染", true);
    return;
  }
  await startEffectRender([item.matchName], true, `正在单独渲染「${effectDisplayName(item)}」…`);
}

async function clearEffectRender(item) {
  if (!item || !item.generated) return;
  if (!hubHas("clearEffectRender")) {
    setStatus("主进程尚未提供取消渲染接口", true);
    return;
  }
  let result = null;
  try {
    result = await window.hub.clearEffectRender(item.matchName);
  } catch {
    result = null;
  }
  if (!result || !result.ok) {
    setStatus("取消渲染失败：" + ((result && result.reason) || "未知原因"), true);
    return;
  }
  await loadEffects();
  const deleted = Number(result.deleted) || 0;
  setStatus(
    `已取消「${effectDisplayName(item)}」的预览渲染` + (deleted ? `，清理 ${deleted} 个文件` : ""),
  );
}

/* 效果库右键菜单：复用预设库的 #categoryMenu 容器与 menuButton 帮助函数 */
function openEffectMenu(item, x, y) {
  const menu = $("categoryMenu");
  if (!menu) return;
  menu.textContent = "";
  menu.appendChild(menuTitle(effectDisplayName(item)));
  const favorite = effectIsFavorite(item.matchName);
  menu.appendChild(menuButton(favorite ? "取消收藏" : "收藏", favorite, false, () =>
    toggleEffectFavorite(item),
  ));
  if (item.renderable) {
    menu.appendChild(menuButton("单独渲染", false, false, () => renderSingleEffect(item)));
  }
  if (item.source === "plugin" || item.manual) {
    menu.appendChild(menuButton("手动调参…", false, false, () => openManualDialog(item)));
  }
  if (item.generated) {
    menu.appendChild(menuButton("取消渲染", false, true, () => clearEffectRender(item)));
  }
  showCategoryMenu(x, y);
}

/* ---------- 手动调参：dump / 基线 / 验证 / 保存 ---------- */

let manualContext = null;
let manualBusyFlag = false;

function manualEl(id) {
  return $(id);
}

function manualDeriveBaseline(item) {
  if (!item || !item.framePattern) return "";
  return String(item.framePattern).replace("%04d", "0000");
}

function manualSetStatus(text, kind) {
  const node = manualEl("manualStatus");
  if (!node) return;
  node.textContent = text;
  node.className = "manual-status" + (kind ? " " + kind : "");
}

function manualSetBusy(busy, text) {
  manualBusyFlag = !!busy;
  for (const id of ["manualDump", "manualBaseline", "manualVerify", "manualPickPreset", "manualSave"]) {
    const button = manualEl(id);
    if (button) button.disabled = !!busy;
  }
  const stop = manualEl("manualStop");
  if (stop) stop.hidden = !busy;
  if (text) manualSetStatus(text, busy ? "busy" : "");
  if (!busy) manualRefreshActions();
}

function manualRefreshActions() {
  if (!manualContext) return;
  const checked = document.querySelectorAll(".manual-row-check:checked").length;
  const save = manualEl("manualSave");
  if (save) save.disabled = manualBusyFlag || (checked === 0 && !manualContext.preset);
}

function manualExistingFor(indexPath) {
  if (!manualContext) return null;
  return (manualContext.existing || []).find((item) => String(item.paramIndex) === String(indexPath)) || null;
}

function manualValueText(value, valueType) {
  if (value === null || value === undefined) return "";
  if (valueType === "boolean") return value ? "true" : "false";
  if (valueType === "array") return JSON.stringify(value);
  return String(value);
}

function manualEditable(params) {
  if (!params) return false;
  if (params.type === "OneD") return true;
  if (params.type === "Checkbox") return true;
  if (params.valueType === "array") return true;
  return false;
}

function manualRenderRows() {
  const list = manualEl("manualParamList");
  if (!list) return;
  list.textContent = "";
  if (!manualContext) return;
  const params = manualContext.params || [];
  manualRefreshActions();
  if (!params.length) {
    const empty = document.createElement("div");
    empty.className = "manual-param-empty";
    empty.textContent = manualContext.existing && manualContext.existing.length
      ? "已有覆盖表，但还没有参数列表；点「读取参数」获取完整参数。"
      : "还没有参数列表；点「读取参数」启动一次 AE 并读取参数树。";
    list.appendChild(empty);
    return;
  }

  for (const param of params) {
    const existing = manualExistingFor(param.indexPath);
    const editable = manualEditable(param);
    const row = document.createElement("div");
    row.className = "manual-param-row" + (editable ? "" : " disabled");
    row.dataset.index = param.indexPath;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "manual-row-check";
    check.disabled = !editable;
    check.checked = !!existing && editable;
    check.title = editable ? "勾选后写入此参数" : "当前类型暂不支持脚本写入";

    const name = document.createElement("div");
    name.className = "manual-param-name";
    name.textContent = param.name || param.path || "未命名参数";
    const pathNode = document.createElement("small");
    pathNode.textContent = param.path || param.indexPath;
    name.appendChild(pathNode);

    const type = document.createElement("span");
    type.className = "manual-type";
    type.textContent = param.type || "—";

    const current = document.createElement("span");
    current.className = "manual-readonly";
    current.textContent = manualValueText(param.value, param.valueType);

    let input;
    if (param.type === "Checkbox") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.className = "manual-value";
      input.checked = existing ? existing.value === true : param.value === true;
    } else if (param.valueType === "array") {
      input = document.createElement("input");
      input.type = "text";
      input.className = "manual-value";
      input.value = manualValueText(
        existing && existing.value !== null && existing.value !== undefined ? existing.value : param.value,
        "array",
      );
      input.title = "JSON 数组，例如 [1,0,0,1]";
    } else {
      input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.className = "manual-value";
      input.value = existing && existing.value !== null && existing.value !== undefined
        ? String(existing.value)
        : String(param.value);
    }
    input.disabled = !check.checked;
    input.dataset.valueType = param.valueType;
    input.addEventListener("input", manualRefreshActions);
    check.addEventListener("change", () => {
      input.disabled = !check.checked;
      manualRefreshActions();
    });

    const range = document.createElement("span");
    range.className = "manual-readonly";
    if (param.type === "OneD") {
      const min = param.hasMin ? param.min : "?";
      const max = param.hasMax ? param.max : "?";
      range.textContent = min + " … " + max;
    } else {
      range.textContent = param.canAnimate ? "可关键帧" : "—";
    }

    row.appendChild(check);
    row.appendChild(name);
    row.appendChild(type);
    row.appendChild(current);
    row.appendChild(input);
    row.appendChild(range);
    if (existing && existing.verified === false) {
      row.title = "上次验证：写入后像素无变化";
    }
    list.appendChild(row);
  }
}

function manualCollectParams() {
  const result = [];
  const rows = document.querySelectorAll(".manual-param-row");
  for (const row of rows) {
    const check = row.querySelector(".manual-row-check");
    if (!check || !check.checked) continue;
    const param = (manualContext.params || []).find((item) => String(item.indexPath) === row.dataset.index);
    if (!param) continue;
    const input = row.querySelector(".manual-value");
    if (!input) continue;
    let value;
    let valueType = param.valueType;
    if (param.type === "Checkbox") {
      value = !!input.checked;
      valueType = "boolean";
    } else if (valueType === "array") {
      try {
        value = JSON.parse(String(input.value || "").trim());
      } catch {
        throw new Error("参数「" + (param.name || param.path) + "」不是合法 JSON 数组");
      }
      if (!Array.isArray(value) || !value.length || value.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
        throw new Error("参数「" + (param.name || param.path) + "」必须是数字数组");
      }
    } else {
      const number = Number(String(input.value || "").trim());
      if (!Number.isFinite(number)) {
        throw new Error("参数「" + (param.name || param.path) + "」不是有效数字");
      }
      value = number;
      valueType = "number";
    }
    result.push({
      matchName: manualContext.item.matchName,
      paramIndex: param.indexPath,
      paramPath: param.path || param.name || "",
      value,
      valueType,
      enabled: true,
      verified: param._verified === true ? true : param._verified === false ? false : null,
    });
  }
  return result;
}

function manualMarkVerified(verified) {
  for (const row of document.querySelectorAll(".manual-param-row")) {
    const check = row.querySelector(".manual-row-check");
    if (!check || !check.checked) continue;
    const param = (manualContext.params || []).find((item) => String(item.indexPath) === row.dataset.index);
    if (param) param._verified = verified;
  }
}

async function manualReadOverrides() {
  if (!manualContext) return;
  try {
    const doc = await window.hub.readEffectOverrides(manualContext.item.matchName);
    manualContext.existing = (doc && doc.items) || [];
    const presetRow = manualContext.existing.find((item) => item.preset);
    if (presetRow && !manualContext.preset) manualContext.preset = presetRow.preset;
    if (manualContext.preset) {
      manualEl("manualPreset").textContent = "兜底预设：" + manualContext.preset;
    }
  } catch {
    manualContext.existing = [];
  }
}

async function manualDump() {
  if (!manualContext || manualBusyFlag) return;
  if (!hubHas("dumpEffectParams")) {
    manualSetStatus("主进程尚未提供手动调参接口", "error");
    return;
  }
  manualSetBusy(true, "正在启动独立 AE 读取参数…（关闭正在使用的 AE 后再试）");
  try {
    const result = await window.hub.dumpEffectParams({
      matchName: manualContext.item.matchName,
      ae: "",
    });
    if (!result || !result.ok) {
      const reason = result && result.reason;
      manualSetStatus(
        "读取失败：" + (reason === "ae_running" ? "请先关闭 After Effects" : (reason || "未知原因")),
        "error",
      );
      return;
    }
    manualContext.params = Array.isArray(result.params) ? result.params : [];
    const warning = manualEl("manualWarning");
    warning.hidden = true;
    if (manualContext.params.length === 0) {
      manualSetStatus("参数树为空；该效果可能没有可读参数。", "error");
    } else {
      manualSetStatus(
        "已读取 " + manualContext.params.length + " 个参数；勾选要覆盖的行并填写写入值。",
      );
    }
    manualRenderRows();
  } catch (error) {
    manualSetStatus("读取失败：" + String((error && error.message) || error), "error");
  } finally {
    manualSetBusy(false);
  }
}

async function manualBaseline() {
  if (!manualContext || manualBusyFlag) return;
  if (!hubHas("baselineEffectParams")) {
    manualSetStatus("主进程尚未提供基线接口", "error");
    return;
  }
  manualSetBusy(true, "正在启动独立 AE 渲染基线…（关闭正在使用的 AE 后再试）");
  try {
    const result = await window.hub.baselineEffectParams({
      matchName: manualContext.item.matchName,
      ae: "",
    });
    if (!result || !result.ok || !result.png) {
      manualSetStatus("基线渲染失败：" + ((result && result.status) || (result && result.reason) || "未知原因"), "error");
      return;
    }
    manualContext.baselinePath = result.png;
    const preview = manualEl("manualPreview");
    preview.textContent = "";
    const img = document.createElement("img");
    img.src = "file:///" + String(result.png).replace(/\\/g, "/");
    img.alt = "基线预览";
    preview.appendChild(img);
    manualSetStatus("基线已生成，可用于验证对比。");
  } catch (error) {
    manualSetStatus("基线渲染失败：" + String((error && error.message) || error), "error");
  } finally {
    manualSetBusy(false);
  }
}

async function manualVerify() {
  if (!manualContext || manualBusyFlag) return;
  if (!hubHas("verifyEffectParams")) {
    manualSetStatus("主进程尚未提供验证接口", "error");
    return;
  }
  let params;
  try {
    params = manualCollectParams();
  } catch (error) {
    manualSetStatus(String(error.message || error), "error");
    return;
  }
  if (!params.length) {
    manualSetStatus("先勾选至少一个要验证的参数。", "error");
    return;
  }
  const baselinePath = manualContext.baselinePath || manualDeriveBaseline(manualContext.item);
  if (!baselinePath) {
    manualSetStatus("没有基线图；请先单独渲染该效果或点「渲染基线」。", "error");
    return;
  }
  manualSetBusy(true, "正在启动独立 AE 验证写入…");
  try {
    const result = await window.hub.verifyEffectParams({
      matchName: manualContext.item.matchName,
      params,
      baselinePath,
      ae: "",
    });
    if (!result || !result.ok) {
      manualSetStatus("验证失败：" + ((result && result.status) || (result && result.reason) || "未知原因"), "error");
      return;
    }
    const compare = result.compare;
    if (!compare || !compare.ok) {
      manualSetStatus("验证完成，但图像对比失败：" + ((compare && compare.reason) || "未知"), "error");
      return;
    }
    const preview = manualEl("manualPreview");
    preview.textContent = "";
    const img = document.createElement("img");
    img.src = compare.verifyDataUrl;
    img.alt = "验证结果";
    preview.appendChild(img);
    const ratio = compare.totalPixels ? compare.diffPixels / compare.totalPixels : 0;
    const diff = manualEl("manualDiff");
    if (compare.identical) {
      diff.textContent = "像素完全一致：写入可能没有生效，或该参数在当前画面不可见。";
      manualMarkVerified(false);
      manualSetStatus("验证完成：像素无变化（参数可能未生效）。", "error");
    } else {
      diff.textContent =
        "差异 " + compare.diffPixels + "/" + compare.totalPixels +
        "（" + (ratio * 100).toFixed(2) + "%），最大通道差 " + compare.maxChannelDiff + "。";
      manualMarkVerified(true);
      manualSetStatus("验证完成：写入已产生可见变化。");
    }
    manualContext.verified = !compare.identical;
    manualRefreshActions();
  } catch (error) {
    manualSetStatus("验证失败：" + String((error && error.message) || error), "error");
  } finally {
    manualSetBusy(false);
  }
}

async function manualPickPreset() {
  if (!manualContext || manualBusyFlag) return;
  if (!hubHas("pickEffectPreset")) return;
  try {
    const result = await window.hub.pickEffectPreset();
    if (!result || !result.ok) {
      if (result && result.reason !== "cancelled") {
        manualSetStatus("导入 .ffx 失败：" + (result.reason || "未知原因"), "error");
      }
      return;
    }
    manualContext.preset = result.preset;
    manualEl("manualPreset").textContent = "兜底预设：" + result.preset + "（" + result.path + "）";
    manualSetStatus("已导入 .ffx 兜底预设。");
    manualRefreshActions();
  } catch (error) {
    manualSetStatus("导入 .ffx 失败：" + String((error && error.message) || error), "error");
  }
}

async function manualSave() {
  if (!manualContext || manualBusyFlag) return;
  if (!hubHas("saveEffectOverrides")) return;
  let params;
  try {
    params = manualCollectParams();
  } catch (error) {
    manualSetStatus(String(error.message || error), "error");
    return;
  }
  if (!params.length && !manualContext.preset) {
    manualSetStatus("没有可保存的覆盖：勾选参数或选择 .ffx。", "error");
    return;
  }
  manualSetBusy(true, "正在保存覆盖表…");
  try {
    const saved = await window.hub.saveEffectOverrides({
      matchName: manualContext.item.matchName,
      params,
      preset: manualContext.preset || "",
    });
    if (!saved || !saved.ok) {
      manualSetStatus("保存失败：" + ((saved && saved.reason) || "未知原因"), "error");
      return;
    }
    manualSetStatus("覆盖表已保存，正在清理旧预览并强制重渲…");
    const render = await window.hub.startPluginEffects({
      matchNames: [manualContext.item.matchName],
      force: true,
    });
    if (!render || !render.ok) {
      manualSetStatus("覆盖已保存，但启动重渲失败：" + ((render && render.reason) || "未知原因"), "error");
      return;
    }
    manualSetStatus("覆盖已保存，已启动强制重渲；完成后回到效果库查看新预览。");
    await loadEffects();
  } catch (error) {
    manualSetStatus("保存失败：" + String((error && error.message) || error), "error");
  } finally {
    manualSetBusy(false);
  }
}

async function openManualDialog(item) {
  if (!hubHas("dumpEffectParams")) {
    setStatus("主进程尚未提供手动调参接口", true);
    return;
  }
  manualContext = {
    item,
    params: [],
    existing: [],
    preset: item.manualPreset || "",
    baselinePath: manualDeriveBaseline(item),
    verified: false,
  };
  manualEl("manualTitle").textContent = "手动调参 · " + effectDisplayName(item);
  manualEl("manualSubtitle").textContent = item.matchName + " · " + (item.plugin || "插件");
  manualEl("manualParamList").textContent = "";
  manualEl("manualPreview").textContent = "尚未验证";
  manualEl("manualDiff").textContent = "对比结果会显示在这里";
  manualEl("manualPreset").textContent = manualContext.preset
    ? "兜底预设：" + manualContext.preset
    : "未选择 .ffx 兜底预设";
  manualEl("manualWarning").hidden = true;
  manualSetStatus("先点「读取参数」；每次操作都会启动一个独立 AE，请先关闭正在使用的 AE。");
  manualSetBusy(false);
  manualEl("manualDialog").hidden = false;
  await manualReadOverrides();
  manualRenderRows();
  if (manualContext.existing.length) {
    manualSetStatus("已读取现有覆盖 " + manualContext.existing.length + " 条；点「读取参数」获取完整参数列表。");
  }
}

function closeManualDialog() {
  const dialog = manualEl("manualDialog");
  if (dialog) dialog.hidden = true;
  manualContext = null;
}

function effectCardNode(item) {
  const card = document.createElement("div");
  card.className = "card" + (effectIsSelected(item.matchName) ? " selected" : "");
  card.dataset.matchName = String(item.matchName || "");

  const name = effectDisplayName(item);
  const category = effectCategoryLabel(item);
  const hasPreview = effectHasPreview(item);
  const frames = Math.max(1, Number(item.frames) || 1);
  const stillFrame = Math.min(frames - 1, Math.max(0, Number(item.stillFrame) || 0));

  const thumb = document.createElement("div");
  thumb.className = "card-thumb";
  let preview = null;
  if (hasPreview && item.framePattern) {
    preview = document.createElement("div");
    preview.className = "effect-preview";
    applyEffectPreview(preview, item, stillFrame);
    thumb.appendChild(preview);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "placeholder";
    placeholder.textContent = effectStatusLabel(item);
    thumb.appendChild(placeholder);
  }
  if (hasPreview && !item.animated) {
    const dot = document.createElement("span");
    dot.className = "card-static-dot";
    dot.title = "静止帧";
    thumb.appendChild(dot);
  }
  if (preview) bindEffectHoverPreview(card, preview, item);
  bindEffectSelectCheckbox(thumb, item);
  bindEffectFavoriteButton(thumb, item);

  const body = document.createElement("div");
  body.className = "card-body";
  const nameNode = document.createElement("div");
  nameNode.className = "card-name";
  nameNode.textContent = name;
  const categoryNode = document.createElement("div");
  categoryNode.className = "card-category";
  categoryNode.textContent = category;
  body.appendChild(nameNode);
  body.appendChild(categoryNode);
  if (item.manual) {
    const manualBadge = document.createElement("span");
    manualBadge.className = "card-manual-badge" + (item.manualUnverified ? " warning" : "");
    manualBadge.textContent = item.manualUnverified ? "手动⚠" : "手动";
    manualBadge.title = item.manualVerified
      ? "手动覆盖已通过写入验证"
      : item.manualUnverified
        ? "手动覆盖中有参数写入后像素无变化"
        : "使用手动覆盖表，尚未验证写入";
    body.appendChild(manualBadge);
  }

  const statusLabel = hasPreview ? "" : effectStatusLabel(item);
  card.title = [name, String(item.matchName || ""), category, statusLabel]
    .filter(Boolean)
    .join("\n");
  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openEffectMenu(item, event.clientX, event.clientY);
  });
  card.appendChild(thumb);
  card.appendChild(body);
  return card;
}

function paintEffectEmpty(hasData) {
  const empty = $("emptyEffects");
  if (!empty) return;
  const title = document.createElement("p");
  title.className = "empty-title";
  const subs = [];
  if (hasData) {
    title.textContent = "没有符合筛选的效果";
    subs.push("试试清空搜索、切换来源，或者点左侧的「全部效果」。");
  } else {
    title.textContent = "效果库还是空的";
    subs.push("插件效果要先到「渲染」页生成预览，生成后会自动出现在这里。");
    subs.push("内置效果预览随 DreamEngine 面板安装，装好后重启 Hub 就能看到。");
    subs.push("分类会跟随 After Effects 自动同步，不用手动新建。");
  }
  empty.textContent = "";
  empty.appendChild(title);
  for (const text of subs) {
    const sub = document.createElement("p");
    sub.className = "empty-sub";
    sub.textContent = text;
    empty.appendChild(sub);
  }
}

function effectCounts() {
  const counts = (state.effectData && state.effectData.counts) || {};
  const total = Number(counts.total) || state.effects.length;
  const builtin =
    Number(counts.builtin) || state.effects.filter((item) => item.source === "builtin").length;
  const plugin = Number(counts.plugin) || Math.max(0, total - builtin);
  const rendered =
    Number(counts.rendered) || state.effects.filter((item) => effectHasPreview(item)).length;
  const categories =
    Number(counts.categories) ||
    new Set(state.effects.map((item) => effectCategoryKey(item)).filter(Boolean)).size;
  return { total, builtin, plugin, rendered, categories };
}

function paintEffectHint(shown) {
  const hint = $("effectHint");
  if (!hint) return;
  const counts = effectCounts();
  if (!counts.total) {
    hint.textContent = "";
    return;
  }
  const parts = [
    `共 ${counts.total} 个效果`,
    `内置 ${counts.builtin}`,
    `插件 ${counts.plugin}`,
    `已生成预览 ${counts.rendered}`,
    `${counts.categories} 个分类`,
  ];
  if (state.effectSelection.size) parts.push(`已选 ${state.effectSelection.size}`);
  const filtering =
    !!state.effectQuery.trim() ||
    state.effectCategory !== "all" ||
    state.effectPlugin !== "all" ||
    state.effectFavoritesOnly;
  if (filtering) parts.push(`当前显示 ${shown} 个`);
  hint.textContent = parts.join(" · ");
}

/* 工具栏的「仅显示已收藏效果」是独立开关（与侧栏收藏分类选择分开） */
function syncEffectFavoritesOnlyButton() {
  const button = $("btnEffectFavoritesOnly");
  if (!button) return;
  button.setAttribute("aria-pressed", state.effectFavoritesOnly ? "true" : "false");
}

function paintEffectSyncButton() {
  const button = $("btnEffectSyncCategories");
  if (!button) return;
  const scanning = !!state.pluginCatalogScanning;
  button.disabled = scanning || anyJobBusy() || !hubHas("scanPluginEffects");
  button.textContent = scanning ? "正在同步…" : "同步 AE 分类";
}

function paintEffectsLibrary() {
  const grid = $("effectGrid");
  if (!grid) return;
  if (state.effectHoverStop) state.effectHoverStop();
  const groups = effectGroups();
  renderEffectCategories(groups);
  fillEffectPluginSelect(groups);
  const items = visibleEffects();

  grid.textContent = "";
  grid.hidden = items.length === 0;
  const empty = $("emptyEffects");
  if (empty) empty.hidden = items.length > 0;
  if (!items.length) paintEffectEmpty(state.effects.length > 0);
  for (const item of items) grid.appendChild(effectCardNode(item));

  $("tabEffectCount").textContent = String(effectCounts().total);
  updateEffectSelectionUI();
  syncEffectFavoritesOnlyButton();
  paintEffectHint(items.length);
  paintEffectSyncButton();
}

async function loadEffects() {
  let data = null;
  if (hubHas("listEffects")) {
    try {
      data = await window.hub.listEffects();
    } catch {
      data = null;
    }
  }
  state.effectData = data && data.ok ? data : null;
  state.effects = data && data.ok && Array.isArray(data.items) ? data.items : [];
  const favorites =
    data && data.ok && Array.isArray(data.favorites)
      ? data.favorites
      : data && data.ok
        ? state.effects.filter((item) => item.favorite).map((item) => item.matchName)
        : [];
  applyEffectFavorites(favorites);
  pruneEffectSelection();
  paintEffectsLibrary();
}

async function refreshEffects() {
  await loadEffects();
  setStatus("已刷新");
}

async function syncEffectCategories() {
  if (state.pluginCatalogScanning) return;
  if (!hubHas("scanPluginEffects")) {
    setStatus("主进程尚未提供扫描插件目录接口", true);
    return;
  }
  setStatus("正在同步 AE 分类…");
  await scanPluginCatalog();
  paintEffectsLibrary();
}

/* ---------- 渲染页 ---------- */

function paintAe(ae) {
  const el = $("aeState");
  const text = el.querySelector(".ae-text");
  const notice = $("aeNotice");

  el.classList.toggle("running", ae.running);
  el.classList.toggle("ready", !ae.running && !!ae.exe);

  if (ae.running) {
    text.textContent = "After Effects 运行中";
  } else if (ae.exe) {
    text.textContent = "After Effects 未运行";
  } else {
    text.textContent = "未找到 After Effects";
  }

  notice.className = "notice " + (ae.running ? "warn" : "ok");
  if (ae.running) {
    notice.innerHTML =
      '<div class="notice-title">渲染需要独占 After Effects</div>' +
      '<div class="notice-sub">请先在 AE 里保存工程，然后关闭 After Effects。' +
      "关闭后这里会自动开始渲染，不需要再点任何按钮。</div>";
  } else if (ae.exe) {
    notice.innerHTML =
      '<div class="notice-title">可以开始</div>' +
      '<div class="notice-sub">After Effects 当前未运行，点「开始渲染」会启动一个专用实例，' +
      "渲完自动关闭并重新打开 AE。</div>";
  } else {
    notice.innerHTML =
      '<div class="notice-title">没有找到 After Effects</div>' +
      '<div class="notice-sub">请确认已安装 AE 2021 或更高版本。</div>';
  }

  $("btnStart").disabled =
    anyJobBusy() || !ae.exe;
}

function paintPluginEffectAe(ae) {
  const notice = $("pluginEffectAeNotice");
  const extReady = !!(state.snapshot && state.snapshot.ext.installed);

  if (ae.running) {
    notice.className = "notice warn";
    notice.innerHTML =
      '<div class="notice-title">插件效果需要独占 After Effects</div>' +
      '<div class="notice-sub">请先保存工程并关闭 After Effects，再回到 Hub 开始生成。</div>';
  } else if (!ae.exe) {
    notice.className = "notice warn";
    notice.innerHTML =
      '<div class="notice-title">没有找到 After Effects</div>' +
      '<div class="notice-sub">请安装 After Effects 2021 或更高版本。</div>';
  } else if (!extReady) {
    notice.className = "notice warn";
    notice.innerHTML =
      '<div class="notice-title">DreamEngine 面板尚未安装</div>' +
      '<div class="notice-sub">离线渲染脚本位于已安装扩展的 tools 目录中，请先重新安装面板。</div>';
  } else {
    notice.className = "notice ok";
    notice.innerHTML =
      '<div class="notice-title">可以开始</div>' +
      '<div class="notice-sub">将使用当前 AE 的效果清单；同一专用实例会分批连续渲染，' +
      "只有崩溃或超时才重启。插件崩溃不会影响其他批次，也不会混入内置效果预览。</div>";
  }

  $("btnPluginEffectStart").disabled =
    anyJobBusy() || ae.running || !ae.exe || !extReady;
}

function paintProgress(renderState) {
  const bar = $("progressBar");
  const msg = $("renderMessage");
  const phase = $("renderPhase");
  const count = $("renderCount");

  if (!renderState) {
    bar.style.width = "0%";
    phase.textContent = "空闲";
    count.textContent = "";
    msg.textContent = "还没有开始渲染。";
    return;
  }

  const total = Number(renderState.total) || 0;
  const current = Number(renderState.current) || 0;
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  bar.style.width = percent + "%";

  const labels = {
    starting: "准备中",
    "waiting-close": "等待关闭 AE",
    rendering: "渲染中",
    done: "已完成",
    failed: "未全部完成",
    cancelled: "已取消",
  };
  phase.textContent = labels[renderState.phase] || String(renderState.phase || "");
  count.textContent =
    total > 0 ? `${current} / ${total}　成功 ${renderState.ok || 0}　失败 ${renderState.fail || 0}` : "";
  msg.textContent = renderState.message || "";
}

async function refreshAeState() {
  const snap = await window.hub.snapshot();
  state.snapshot = snap;
  paintAe(snap.ae);
  paintPluginEffectAe(snap.ae);
  syncAeVersionSelectors(snap);
  fillSettings(snap);
  return snap;
}

function syncAeVersionSelectors(snap) {
  const installed = (snap && snap.ae && snap.ae.installed) || [];
  let selected = localStorage.getItem(RENDER_AE_KEY) || "";
  const available = new Set(installed.map((item) => item.exe));
  if (selected && !available.has(selected)) {
    selected = "";
    localStorage.removeItem(RENDER_AE_KEY);
  }
  for (const select of document.querySelectorAll(".ae-version-select")) {
    select.textContent = "";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = installed.length ? "自动（最高版本）" : "未检测到 After Effects";
    select.appendChild(auto);
    for (const item of installed) {
      const option = document.createElement("option");
      option.value = item.exe;
      option.textContent = `${item.name} (${item.version})`;
      select.appendChild(option);
    }
    select.value = selected;
  }
}

function selectRenderAe(value, source) {
  const next = String(value || "");
  if (next) localStorage.setItem(RENDER_AE_KEY, next);
  else localStorage.removeItem(RENDER_AE_KEY);
  for (const select of document.querySelectorAll(".ae-version-select")) {
    if (select !== source) select.value = next;
  }
}

async function openRenderLog(kind) {
  state.logKind = kind === "plugin" ? "plugin" : "preset";
  $("renderLogTitle").textContent =
    state.logKind === "plugin" ? "插件效果生成日志" : "预设渲染日志";
  $("renderLogSubtitle").textContent = "最近 400 行";
  $("renderLogBody").textContent = "正在读取日志…";
  $("renderLogDialog").hidden = false;
  $("renderLogClose").focus();
  if (state.logKind === "plugin") await pullPluginEffectLog(400);
  else await pullLog(400);
}

function closeRenderLog() {
  $("renderLogDialog").hidden = true;
}

async function pullLog(lines = 400) {
  if ($("renderLogDialog").hidden || state.logKind !== "preset") return;
  const text = await window.hub.logTail(lines);
  $("renderLogBody").textContent = text || "（暂无）";
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    await refreshAeState();
    await pullLog();
  }, 2000);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function startRender(overrides) {
  const extra = overrides || {};
  const options = {
    ae: $("renderAeVersion").value,
    background: $("background").value,
    limit: Number($("limit").value) || 40,
    rounds: Number($("rounds").value) || 40,
    retryFailed: !extra.onlyPreset,
    ...extra,
  };
  const selectedPaths = Array.isArray(extra.presetPaths) ? extra.presetPaths : null;
  const result = await window.hub.startRender(options);
  if (!result || !result.ok) {
    const reason = (result && result.reason) || "";
    const messages = {
      nothing_to_render: "所选预设没有需要渲染的条目",
      no_catalog: "还没有插件目录，请先扫描插件目录",
      already_running: "已有渲染任务在运行",
      preset_render_running: "已有渲染任务在运行",
      write_failed: "写入预设选择文件失败",
    };
    setStatus("启动失败：" + (messages[reason] || reason || "未知原因"), true);
    return false;
  }

  state.rendering = true;
  state.stopRequested = false;
  updateRenderModeButtons();
  $("btnStart").disabled = true;
  $("btnPluginEffectStart").disabled = true;
  $("btnStop").disabled = false;
  const selectedCount = selectedPaths
    ? Number(result.selectedCount) || selectedPaths.length
    : 0;
  setStatus(
    selectedCount
      ? `已开始渲染所选 ${selectedCount} 个预设`
      : options.onlyPreset
        ? "已开始单独渲染"
        : "渲染已启动",
  );
  startPolling();

  // AE 还在跑时 ps1 会进入等待，这里先把话说清楚，别让人以为卡住了
  paintProgress({
    phase: state.snapshot && state.snapshot.ae.running ? "waiting-close" : "rendering",
    message: "",
  });
  $("renderMessage").textContent =
    state.snapshot && state.snapshot.ae.running
      ? "等待你关闭 After Effects…"
      : selectedCount
        ? `正在渲染所选 ${selectedCount} 个预设（约 25 秒启动 AE）…`
        : options.onlyPreset
          ? "正在单独渲染所选预设（约 25 秒启动 AE）…"
          : "正在启动专用 AE 实例（约 25 秒）…";
  return true;
}

async function renderSinglePreset(item) {
  setView("render");
  setRenderMode("preset");
  await startRender({
    onlyPreset: item.path,
    limit: 1,
    rounds: 1,
  });
}

async function stopRender() {
  state.stopRequested = true;
  const result = await window.hub.stopRender();
  // 没有真正停掉（进程已经退了 / 本来就没跑）时不要留下「已停止」的标记
  if (!result || !result.ok) state.stopRequested = false;
  state.rendering = false;
  updateRenderModeButtons();
  $("btnStart").disabled = false;
  $("btnStop").disabled = true;
  stopPolling();
  setStatus("已停止");
  $("renderMessage").textContent = "已手动停止。";
}

/* ---------- 插件效果预览 ---------- */

function paintPluginEffectProgress(renderState) {
  const bar = $("pluginEffectBar");
  const phase = $("pluginEffectPhase");
  const count = $("pluginEffectCount");
  const message = $("pluginEffectMessage");
  if (!renderState) {
    bar.style.width = "0%";
    phase.textContent = "空闲";
    count.textContent = "";
    message.textContent = "插件效果会使用独立 AE 实例逐条渲染，崩溃条目会自动跳过。";
    return;
  }

  const total = Number(renderState.total) || 0;
  const current = Number(renderState.current) || 0;
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const labels = {
    starting: "准备中",
    scanning: "扫描中",
    rendering: "生成中",
    done: "已完成",
    paused: "可继续",
    failed: "已停止",
    cancelled: "已取消",
  };
  bar.style.width = percent + "%";
  phase.textContent = labels[renderState.phase] || String(renderState.phase || "");
  count.textContent =
    total > 0
      ? `${current} / ${total}　本轮成功 ${renderState.ok || 0}　失败 ${renderState.fail || 0}　剩余 ${renderState.remaining || 0}`
      : "";
  message.textContent = renderState.message || "";
}

async function pullPluginEffectLog(lines = 400) {
  if ($("renderLogDialog").hidden || state.logKind !== "plugin") return;
  const text = await window.hub.logPluginEffectsTail(lines);
  $("renderLogBody").textContent = text || "（暂无）";
}

function startPluginEffectPolling() {
  stopPluginEffectPolling();
  state.pluginEffectPollTimer = setInterval(async () => {
    await refreshAeState();
    await pullPluginEffectLog();
    const current = await window.hub.pluginEffectsSnapshot();
    if (current) paintPluginEffectProgress(current);
  }, 2000);
}

function stopPluginEffectPolling() {
  if (state.pluginEffectPollTimer) {
    clearInterval(state.pluginEffectPollTimer);
    state.pluginEffectPollTimer = null;
  }
}

function repaintPluginEffectAe() {
  if (state.snapshot) paintPluginEffectAe(state.snapshot.ae);
}

function beginPluginEffectRun(statusText, startMessage) {
  state.pluginEffectRendering = true;
  state.pluginEffectStopRequested = false;
  updateRenderModeButtons();
  repaintPluginEffectAe();
  paintPluginCatalog();
  $("btnPluginEffectStart").disabled = true;
  $("btnStart").disabled = true;
  $("btnPluginEffectStop").disabled = false;
  paintPluginEffectProgress({
    phase: "starting",
    total: 0,
    current: 0,
    remaining: 0,
    message: startMessage || "正在读取当前 After Effects 的插件效果清单…",
  });
  startPluginEffectPolling();
  setStatus(statusText || "插件效果预览生成已启动");
}

async function startPluginEffects() {
  if (!state.snapshot || !state.snapshot.ae.installed.length) return;
  const options = {
    ae: $("pluginEffectAeVersion").value,
    background: $("pluginEffectBackground").value || "",
    limit: Number($("pluginEffectLimit").value) || 8,
    rounds: Number($("pluginEffectRounds").value) || 200,
  };
  const result = await window.hub.startPluginEffects(options);
  if (!result || !result.ok) {
    const messages = {
      already_running: "已有插件效果任务在运行，请先停止",
      preset_render_running: "预设渲染进行中，结束后才能生成插件效果",
      write_failed: "写入选择文件失败，请重试",
    };
    setStatus(
      "插件效果生成启动失败：" + (messages[result && result.reason] || (result && result.reason) || ""),
      true,
    );
    return;
  }
  beginPluginEffectRun("插件效果预览生成已启动", "正在读取当前 After Effects 的插件效果清单…");
}

async function stopPluginEffects() {
  state.pluginEffectStopRequested = true;
  const wasScan = state.pluginCatalogScanning;
  const result = await window.hub.stopPluginEffects();
  if (!result || !result.ok) state.pluginEffectStopRequested = false;
  state.pluginEffectRendering = false;
  state.pluginCatalogScanning = false;
  updateRenderModeButtons();
  $("btnPluginEffectStart").disabled = false;
  $("btnPluginEffectStop").disabled = true;
  stopPluginEffectPolling();
  paintPluginCatalog();
  setStatus(wasScan ? "已停止扫描插件目录" : "已停止插件效果生成");
  $("pluginEffectMessage").textContent = wasScan
    ? "已停止扫描插件目录。"
    : "已手动停止，下次开始会从断点继续。";
}

/* ---------- 插件目录 / 选择效果 ---------- */

const EFFECT_STATUS = {
  pending: { label: "待渲染", className: "pending" },
  rendered: { label: "已生成", className: "rendered" },
  blacklisted: { label: "已跳过", className: "skipped" },
  excluded: { label: "不可渲染", className: "blocked" },
  no_preview: { label: "不可渲染", className: "blocked" },
};

const EFFECT_REASONS = {
  pseudo: "伪效果",
  obsolete: "已过时",
  no_category: "没有分类",
  poor_preview: "预览效果差",
  crash: "渲染崩溃",
  render_error: "渲染报错",
  render_timeout: "渲染超时",
  ae_dialog: "AE 报错",
};

function effectDisplayName(item) {
  return item.displayName || item.nameZh || item.nameEn || item.matchName || "(未命名效果)";
}

function effectReasonLabel(item) {
  if (!item || !item.reason) return "";
  return EFFECT_REASONS[item.reason] || String(item.reason);
}

function catalogItems() {
  return (state.pluginCatalog && state.pluginCatalog.items) || [];
}

async function refreshPluginCatalog() {
  let catalog = null;
  if (hubHas("pluginEffectsCatalog")) {
    try {
      catalog = await window.hub.pluginEffectsCatalog();
    } catch {
      catalog = null;
    }
  }
  state.pluginCatalog = catalog && catalog.ok ? catalog : null;
  prunePluginEffectSelection();
  paintPluginCatalog();
}

function prunePluginEffectSelection() {
  const names = new Set(catalogItems().map((item) => item.matchName));
  for (const key of [...state.pluginEffectSelection.keys()]) {
    if (!names.has(key)) state.pluginEffectSelection.delete(key);
  }
}

function paintPluginCatalog() {
  const summary = $("pluginCatalogSummary");
  const status = $("pluginCatalogStatus");
  const scanBtn = $("btnScanPluginCatalog");
  const pickBtn = $("btnPickPluginEffects");
  if (!summary) return;

  const catalog = state.pluginCatalog;
  const items = catalogItems();
  const scanning = state.pluginCatalogScanning;
  const busy = anyJobBusy();

  scanBtn.disabled = busy || !hubHas("scanPluginEffects");
  scanBtn.textContent = scanning ? "正在扫描…" : "扫描插件目录";
  pickBtn.disabled = scanning || !!state.pluginEffectRendering || !items.length;

  if (scanning) {
    summary.textContent = "正在扫描插件目录…";
    status.hidden = false;
    status.textContent = "会启动专用 After Effects 读取效果清单，结束后自动刷新。";
    return;
  }

  if (!items.length) {
    summary.textContent = "未扫描插件目录";
    status.hidden = false;
    status.textContent = "先扫描一次，才能按效果勾选渲染。";
    return;
  }

  const counts = catalog.counts || {};
  const total = Number(counts.total) || items.length;
  const pending = Number(counts.pending) || 0;
  const rendered = Number(counts.rendered) || 0;
  const skipped =
    (Number(counts.blacklisted) || 0) +
    (Number(counts.excluded) || 0) +
    (Number(counts.noPreview) || 0);
  const aeLabel = catalog.aeMajor ? "AE " + catalog.aeMajor : "After Effects";
  summary.textContent =
    `已扫描：${aeLabel}，${total} 条（待渲染 ${pending} / 已生成 ${rendered} / 已跳过 ${skipped}）`;
  summary.title = catalog.scannedAt ? "扫描时间：" + catalog.scannedAt : "";
  status.hidden = true;
  status.textContent = "";
}

async function scanPluginCatalog() {
  if (state.pluginCatalogScanning) return;
  if (!hubHas("scanPluginEffects")) {
    setStatus("主进程尚未提供扫描插件目录接口", true);
    return;
  }
  const result = await window.hub.scanPluginEffects({
    ae: $("pluginEffectAeVersion").value,
  });
  if (!result || !result.ok) {
    const reason = (result && result.reason) || "";
    const messages = {
      already_running: "已有插件效果任务在运行，请先停止后再扫描",
      preset_render_running: "预设渲染进行中，结束后才能扫描插件目录",
    };
    setStatus(messages[reason] || "扫描启动失败：" + (reason || "未知原因"), true);
    return;
  }
  beginCatalogScan();
}

function beginCatalogScan() {
  state.pluginCatalogScanning = true;
  state.pluginEffectStopRequested = false;
  paintPluginCatalog();
  updateRenderModeButtons();
  repaintPluginEffectAe();
  $("btnPluginEffectStart").disabled = true;
  $("btnPluginEffectStop").disabled = false;
  paintPluginEffectProgress({
    phase: "starting",
    mode: "catalog",
    total: 0,
    current: 0,
    remaining: 0,
    message: "正在启动专用 After Effects 扫描插件目录…",
  });
  startPluginEffectPolling();
  setStatus("正在扫描插件目录…");
}

function comparePluginNames(a, b) {
  if (a === "其它插件") return 1;
  if (b === "其它插件") return -1;
  return a.localeCompare(b, "zh-CN");
}

function effectPickerVisibleItems() {
  const filters = state.effectPicker;
  const query = filters.query.trim().toLowerCase();
  return catalogItems().filter((item) => {
    const plugin = item.plugin || "其它插件";
    if (filters.plugin && plugin !== filters.plugin) return false;
    if (filters.hideRendered && item.status === "rendered") return false;
    if (!query) return true;
    const haystack = [
      effectDisplayName(item),
      item.nameZh,
      item.nameEn,
      item.matchName,
      item.category,
      item.categoryZh,
      item.plugin,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function effectRowNode(item) {
  const meta = EFFECT_STATUS[item.status] || {
    label: item.status || "未知",
    className: "",
  };
  const reason = effectReasonLabel(item);
  const row = document.createElement("label");
  row.className = "effect-row";

  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = !!state.pluginEffectSelection.has(item.matchName);
  if (!item.selectable) {
    row.classList.add("disabled");
    box.disabled = true;
    box.checked = false;
  }

  const main = document.createElement("span");
  main.className = "effect-main";
  const name = document.createElement("span");
  name.className = "effect-name";
  name.textContent = effectDisplayName(item);
  const metaText = [item.category || item.categoryZh || "未分类"];
  if (reason) metaText.push("原因：" + reason);
  else if (item.status === "no_preview") metaText.push("该分类不生成预览");
  else if (item.status === "blacklisted" && item.reason) {
    metaText.push(effectReasonLabel(item) || String(item.reason));
  }
  const metaNode = document.createElement("span");
  metaNode.className = "effect-meta";
  metaNode.textContent = metaText.join(" · ");
  main.appendChild(name);
  main.appendChild(metaNode);

  const badge = document.createElement("span");
  badge.className = "effect-badge " + meta.className;
  badge.textContent = meta.label;

  row.title = [effectDisplayName(item), item.matchName, reason ? "原因：" + reason : ""]
    .filter(Boolean)
    .join("\n");
  box.addEventListener("change", () => {
    if (box.checked) state.pluginEffectSelection.set(item.matchName, item);
    else state.pluginEffectSelection.delete(item.matchName);
    updateEffectPickerSelection();
  });
  row.appendChild(box);
  row.appendChild(main);
  row.appendChild(badge);
  return row;
}

function renderEffectPickerList() {
  const list = $("effectPickerList");
  if (!list) return;
  const items = effectPickerVisibleItems();
  list.textContent = "";
  $("effectPickerSub").textContent =
    `目录共 ${catalogItems().length} 条，当前显示 ${items.length} 条`;

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "effect-picker-empty";
    empty.textContent = "没有符合筛选条件的效果。";
    list.appendChild(empty);
    updateEffectPickerSelection();
    return;
  }

  const groups = new Map();
  for (const item of items) {
    const plugin = item.plugin || "其它插件";
    if (!groups.has(plugin)) groups.set(plugin, []);
    groups.get(plugin).push(item);
  }
  const pluginNames = [...groups.keys()].sort(comparePluginNames);
  for (const plugin of pluginNames) {
    const group = groups
      .get(plugin)
      .slice()
      .sort((a, b) => effectDisplayName(a).localeCompare(effectDisplayName(b), "zh-CN"));
    const section = document.createElement("div");
    section.className = "effect-group";
    section.dataset.plugin = plugin;
    const head = document.createElement("div");
    head.className = "effect-group-head";
    const title = document.createElement("span");
    title.className = "effect-group-title";
    title.textContent = plugin;
    const count = document.createElement("span");
    count.className = "effect-group-count";
    head.appendChild(title);
    head.appendChild(count);
    section.appendChild(head);
    for (const item of group) section.appendChild(effectRowNode(item));
    list.appendChild(section);
  }
  updateEffectPickerSelection();
}

function updateEffectPickerSelection() {
  const count = state.pluginEffectSelection.size;
  $("effectSelectedCount").textContent = `已选 ${count} 项`;
  $("effectRenderSelected").disabled = count === 0 || !!state.pluginCatalogScanning;
  $("effectClearAll").disabled = count === 0;

  for (const section of document.querySelectorAll("#effectPickerList .effect-group")) {
    const plugin = section.dataset.plugin || "";
    const groupItems = effectPickerVisibleItems().filter(
      (item) => (item.plugin || "其它插件") === plugin,
    );
    const selected = groupItems.filter((item) =>
      state.pluginEffectSelection.has(item.matchName),
    ).length;
    const countNode = section.querySelector(".effect-group-count");
    if (countNode) {
      countNode.textContent =
        `${groupItems.length} 条` + (selected ? ` · 已选 ${selected}` : "");
    }
  }
}

function fillEffectPluginFilter() {
  const select = $("effectPickerPluginFilter");
  const plugins = [
    ...new Set(catalogItems().map((item) => item.plugin || "其它插件")),
  ].sort(comparePluginNames);
  select.textContent = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "全部插件";
  select.appendChild(all);
  for (const plugin of plugins) {
    const option = document.createElement("option");
    option.value = plugin;
    option.textContent = plugin;
    select.appendChild(option);
  }
  select.value = plugins.includes(state.effectPicker.plugin)
    ? state.effectPicker.plugin
    : "";
  state.effectPicker.plugin = select.value;
}

function setEffectPickerStatus(text, isError) {
  const node = $("effectPickerStatus");
  node.textContent = text || "";
  node.classList.toggle("danger", !!isError);
}

function openEffectPicker() {
  if (!catalogItems().length) {
    setStatus("插件目录为空，先点「扫描插件目录」", true);
    return;
  }
  state.effectPicker = { query: "", plugin: "", hideRendered: true, force: false };
  $("effectPickerSearch").value = "";
  $("effectHideRendered").checked = true;
  $("effectForce").checked = false;
  setEffectPickerStatus("");
  fillEffectPluginFilter();
  renderEffectPickerList();
  $("pluginEffectPicker").hidden = false;
  $("effectPickerSearch").focus();
}

function closeEffectPicker() {
  const dialog = $("pluginEffectPicker");
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  setEffectPickerStatus("");
}

function selectAllFilteredEffects() {
  const candidates = effectPickerVisibleItems().filter((item) => item.selectable);
  if (!candidates.length) {
    setEffectPickerStatus("当前筛选没有可渲染的效果", true);
    return;
  }
  for (const item of candidates) {
    state.pluginEffectSelection.set(item.matchName, item);
  }
  renderEffectPickerList();
}

function clearEffectSelection() {
  state.pluginEffectSelection.clear();
  renderEffectPickerList();
}

async function renderSelectedPluginEffects() {
  const matchNames = [...state.pluginEffectSelection.keys()];
  if (!matchNames.length) return;
  if (state.pluginCatalogScanning || state.pluginEffectRendering) {
    setEffectPickerStatus("已有插件效果任务在运行，请先停止或等待结束", true);
    return;
  }
  const force = $("effectForce").checked;
  const options = {
    matchNames,
    force,
    ae: $("pluginEffectAeVersion").value,
    background: $("pluginEffectBackground").value || "",
    limit: Number($("pluginEffectLimit").value) || 8,
    rounds: Number($("pluginEffectRounds").value) || 200,
  };
  const result = await window.hub.startPluginEffects(options);
  if (!result || !result.ok) {
    const reason = (result && result.reason) || "";
    if (reason === "nothing_to_render") {
      const text = "所选条目均已生成或已跳过；勾选强制重渲后再试";
      setEffectPickerStatus(text, true);
      setStatus(text, true);
    } else if (reason === "no_catalog") {
      const text = "还没有插件目录，请先扫描插件目录";
      setEffectPickerStatus(text, true);
      setStatus(text, true);
    } else if (reason === "already_running" || reason === "preset_render_running") {
      setEffectPickerStatus("已有渲染任务在运行，请稍后再试", true);
    } else if (reason === "write_failed") {
      setEffectPickerStatus("写入效果选择文件失败，请重试", true);
    } else {
      setEffectPickerStatus("启动失败：" + (reason || "未知原因"), true);
    }
    return;
  }

  const selected = Number(result.selectedCount) || matchNames.length;
  const skipped = Number(result.skippedCount) || 0;
  closeEffectPicker();
  beginPluginEffectRun(
    skipped
      ? `已开始渲染所选 ${selected} 条插件效果（跳过 ${skipped} 条）`
      : `已开始渲染所选 ${selected} 条插件效果`,
    `正在渲染所选 ${selected} 条插件效果…`,
  );
}

/* ---------- 设置页 ---------- */

function fillSettings(snap) {
  const ext = snap.ext;
  $("extVersion").textContent = ext.version ? "v" + ext.version : "";
  $("setExtDir").textContent = ext.extDir;
  $("setExtVersion").textContent = ext.installed
    ? ext.version || "已安装"
    : "未安装（请先跑安装包）";
  $("setThumbs").textContent = ext.thumbCount + " 张";
  $("setIndexes").textContent = ext.indexes.length
    ? ext.indexes.join("、")
    : "（还没有生成过索引）";

  $("setAeRun").textContent = snap.ae.running ? "运行中" : "未运行";
  $("setAeList").textContent = snap.ae.installed.length
    ? snap.ae.installed.map((v) => v.name).join("、")
    : "未检测到";

  $("setPresets").textContent = snap.paths.presets;
  $("setBg").textContent = snap.paths.backgrounds;
  $("setProbe").textContent = snap.paths.probe;
}

async function fillBackgrounds() {
  const select = $("background");
  const current = select.value;
  const list = await window.hub.listBackgrounds();
  select.textContent = "";
  for (const item of list) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    select.appendChild(option);
  }
  const custom = document.createElement("option");
  custom.value = "__custom__";
  custom.textContent = "自己添加…";
  select.appendChild(custom);
  if (current && [...select.options].some((o) => o.value === current)) {
    select.value = current;
  } else if (select.options.length) {
    select.value = select.options[0].value;
  }
  select.dataset.previous = select.value;
}

async function fillPluginEffectBackgrounds() {
  const select = $("pluginEffectBackground");
  const current = select.value;
  const list = await window.hub.listBackgrounds();
  select.textContent = "";
  const standard = document.createElement("option");
  standard.value = "";
  standard.textContent = "标准素材";
  select.appendChild(standard);
  for (const item of list) {
    if (item.builtin) continue;
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    select.appendChild(option);
  }
  const custom = document.createElement("option");
  custom.value = "__custom__";
  custom.textContent = "自己添加…";
  select.appendChild(custom);
  if (current && [...select.options].some((option) => option.value === current)) {
    select.value = current;
  } else {
    select.value = "";
  }
  select.dataset.previous = select.value;
}

/* ---------- 绑定 ---------- */

function bind() {
  presetSidebar.init();
  effectSidebar.init();
  readEffectCollapsedGroups();
  document.getElementById("tabs").addEventListener("click", (event) => {
    const tab = event.target.closest(".tab");
    if (tab) setView(tab.dataset.view);
  });

  $("btnImport").addEventListener("click", addPresets);
  $("btnCategoryAdd").addEventListener("click", () => openCategoryEditor("create", null));
  $("categoryEditor").addEventListener("submit", saveCategory);
  $("categoryCancel").addEventListener("click", closeCategoryEditor);
  $("categoryName").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeCategoryEditor();
  });
  document.addEventListener("mousedown", (event) => {
    const menu = $("categoryMenu");
    if (!menu.hidden && !menu.contains(event.target)) hideCategoryMenu();
  });
  $("presetDeleteCancel").addEventListener("click", closePresetDelete);
  $("presetDeleteConfirm").addEventListener("click", confirmPresetDelete);
  $("presetDeleteDialog").addEventListener("mousedown", (event) => {
    if (event.target === $("presetDeleteDialog")) closePresetDelete();
  });
  $("presetRenameForm").addEventListener("submit", savePresetRename);
  $("presetRenameCancel").addEventListener("click", closePresetRename);
  $("presetRenameDialog").addEventListener("mousedown", (event) => {
    if (event.target === $("presetRenameDialog")) closePresetRename();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("presetDeleteDialog").hidden) closePresetDelete();
    if (event.key === "Escape" && !$("presetRenameDialog").hidden) closePresetRename();
    if (event.key === "Escape") hideCategoryMenu();
  });

  const presetView = $("viewPresets");
  presetView.addEventListener("dragenter", (event) => {
    if ([...(event.dataTransfer?.types || [])].includes("Files")) {
      presetView.classList.add("drop-over");
    }
  });
  presetView.addEventListener("dragover", (event) => {
    if ([...(event.dataTransfer?.types || [])].includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  });
  presetView.addEventListener("dragleave", (event) => {
    if (!presetView.contains(event.relatedTarget)) presetView.classList.remove("drop-over");
  });
  presetView.addEventListener("drop", async (event) => {
    event.preventDefault();
    presetView.classList.remove("drop-over");
    await addDroppedPresets([...(event.dataTransfer?.files || [])]);
  });

  $("btnRefresh").addEventListener("click", async () => {
    await loadPresets();
    setStatus("已刷新");
  });

  $("btnSelectUnrendered").addEventListener("click", selectUnrenderedPresets);
  $("btnClearSelection").addEventListener("click", clearPresetSelection);
  $("btnRenderSelected").addEventListener("click", renderSelectedPresets);
  $("btnSyncAePresets").addEventListener("click", () => syncAePresets(true));
  $("btnPresetFavoritesOnly").addEventListener("click", () => {
    state.presetFavoritesOnly = !state.presetFavoritesOnly;
    renderPresets();
  });
  $("presetSourceFilter").addEventListener("change", (event) => {
    state.presetSourceFilter = event.target.value;
    if (state.presetSourceFilter === "mine" && state.presetCategory.startsWith("ae:")) {
      state.presetCategory = "all";
    } else if (
      state.presetSourceFilter === "external" &&
      state.presetCategory !== "all" &&
      !state.presetCategory.startsWith("ae:") &&
      state.presetCategory !== "__favorites__"
    ) {
      state.presetCategory = "all";
    }
    renderPresets();
  });

  $("search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderPresets();
  });

  $("btnEffectRefresh").addEventListener("click", refreshEffects);
  $("btnEffectSyncCategories").addEventListener("click", syncEffectCategories);
  $("btnEffectSelectUnrendered").addEventListener("click", selectUnrenderedEffects);
  $("btnEffectClearSelection").addEventListener("click", clearEffectLibrarySelection);
  $("btnEffectRenderSelected").addEventListener("click", renderSelectedEffects);
  $("btnEffectFavoritesOnly").addEventListener("click", () => {
    state.effectFavoritesOnly = !state.effectFavoritesOnly;
    paintEffectsLibrary();
  });
  $("effectSearch").addEventListener("input", (event) => {
    state.effectQuery = event.target.value;
    paintEffectsLibrary();
  });
  $("effectPluginFilter").addEventListener("change", (event) => {
    state.effectPlugin = event.target.value;
    if (
      state.effectPlugin !== "all" &&
      state.effectCategory !== "all" &&
      state.effectCategory !== "__uncategorized__" &&
      state.effectCategory !== "__favorites__" &&
      effectGroupFromKey(state.effectCategory) !== state.effectPlugin
    ) {
      state.effectCategory = "all";
    }
    paintEffectsLibrary();
  });

  $("background").addEventListener("change", async (event) => {
    const select = event.target;
    if (select.value !== "__custom__") {
      select.dataset.previous = select.value;
      return;
    }
    select.value = select.dataset.previous || "photo";
    const result = await window.hub.addBackground();
    const added = result.added || [];
    const errors = result.errors || [];
    if (!added.length) {
      setStatus(errors.length ? "图片无法解码为 PNG，未添加背景" : "未添加背景", true);
      return;
    }
    await fillBackgrounds();
    select.value = added[0];
    select.dataset.previous = added[0];
    setStatus(
      `已转换为 PNG：${added[0].split(/[\\/]/).pop()}` +
        (errors.length ? `；${errors.length} 个文件失败` : ""),
    );
  });

  $("pluginEffectBackground").addEventListener("change", async (event) => {
    const select = event.target;
    if (select.value !== "__custom__") {
      select.dataset.previous = select.value;
      return;
    }
    select.value = select.dataset.previous || "";
    const result = await window.hub.addBackground();
    const added = result.added || [];
    const errors = result.errors || [];
    if (!added.length) {
      setStatus(errors.length ? "图片无法解码为 PNG，未添加背景" : "未添加背景", true);
      return;
    }
    await fillPluginEffectBackgrounds();
    select.value = added[0];
    select.dataset.previous = added[0];
    setStatus(
      `已转换为 PNG：${added[0].split(/[\\/]/).pop()}` +
        (errors.length ? `；${errors.length} 个文件失败` : ""),
    );
  });

  $("btnStart").addEventListener("click", startRender);
  $("btnStop").addEventListener("click", stopRender);
  $("btnOpenLog").addEventListener("click", () => openRenderLog("preset"));
  $("btnPluginEffectStart").addEventListener("click", startPluginEffects);
  $("btnPluginEffectStop").addEventListener("click", stopPluginEffects);
  $("btnPluginEffectLog").addEventListener("click", () => openRenderLog("plugin"));

  /* 插件目录 + 选择效果 */
  $("btnScanPluginCatalog").addEventListener("click", scanPluginCatalog);
  $("btnPickPluginEffects").addEventListener("click", openEffectPicker);
  $("effectPickerClose").addEventListener("click", closeEffectPicker);
  $("effectPickerCancel").addEventListener("click", closeEffectPicker);
  $("pluginEffectPicker").addEventListener("mousedown", (event) => {
    if (event.target === $("pluginEffectPicker")) closeEffectPicker();
  });
  $("effectPickerSearch").addEventListener("input", (event) => {
    state.effectPicker.query = event.target.value;
    renderEffectPickerList();
  });
  $("effectPickerPluginFilter").addEventListener("change", (event) => {
    state.effectPicker.plugin = event.target.value;
    renderEffectPickerList();
  });
  $("effectHideRendered").addEventListener("change", (event) => {
    state.effectPicker.hideRendered = event.target.checked;
    renderEffectPickerList();
  });
  $("effectForce").addEventListener("change", (event) => {
    state.effectPicker.force = event.target.checked;
  });
  $("effectSelectAll").addEventListener("click", selectAllFilteredEffects);
  $("effectClearAll").addEventListener("click", clearEffectSelection);
  $("effectRenderSelected").addEventListener("click", renderSelectedPluginEffects);
  /* 手动调参 */
  $("manualDump").addEventListener("click", manualDump);
  $("manualBaseline").addEventListener("click", manualBaseline);
  $("manualVerify").addEventListener("click", manualVerify);
  $("manualPickPreset").addEventListener("click", manualPickPreset);
  $("manualSave").addEventListener("click", manualSave);
  $("manualStop").addEventListener("click", async () => {
    if (!hubHas("stopManualEffect")) return;
    await window.hub.stopManualEffect();
    manualSetStatus("已请求停止手动调参任务。");
  });
  $("manualClose").addEventListener("click", closeManualDialog);
  $("manualCloseBottom").addEventListener("click", closeManualDialog);
  $("manualDialog").addEventListener("mousedown", (event) => {
    if (event.target === $("manualDialog")) closeManualDialog();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("manualDialog").hidden) {
      event.preventDefault();
      closeManualDialog();
    }
  });

  $("renderLogClose").addEventListener("click", closeRenderLog);
  $("renderLogCloseBottom").addEventListener("click", closeRenderLog);
  $("renderLogOpenFolder").addEventListener("click", () => {
    if (state.snapshot) window.hub.reveal(state.snapshot.paths.probe);
  });
  $("renderLogDialog").addEventListener("click", (event) => {
    if (event.target === $("renderLogDialog")) closeRenderLog();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("renderLogDialog").hidden) {
      event.preventDefault();
      closeRenderLog();
    }
    if (event.key === "Escape" && !$("pluginEffectPicker").hidden) {
      event.preventDefault();
      closeEffectPicker();
    }
  });

  $("renderModeSwitch").addEventListener("click", (event) => {
    const button = event.target.closest(".render-mode-button");
    if (!button || button.disabled) return;
    setRenderMode(button.dataset.renderMode);
    if (state.renderMode === "plugin") {
      window.hub.pluginEffectsSnapshot().then((last) => {
        if (last) paintPluginEffectProgress(last);
      });
    }
  });

  for (const select of document.querySelectorAll(".ae-version-select")) {
    select.addEventListener("change", async (event) => {
      selectRenderAe(event.target.value, event.target);
      await loadPresets({ force: true });
    });
  }

  $("btnOpenExt").addEventListener("click", () => window.hub.reveal($("setExtDir").textContent));
  $("btnOpenPresets").addEventListener("click", () => window.hub.reveal($("setPresets").textContent));
  $("btnOpenProbe").addEventListener("click", () => window.hub.reveal($("setProbe").textContent));

  window.hub.onRenderState((renderState) => {
    paintProgress(renderState);
    if (renderState.phase === "waiting-close") {
      $("renderMessage").textContent = "等待你关闭 After Effects…";
    }
  });

  window.hub.onRenderExit(async (info) => {
    state.rendering = false;
    updateRenderModeButtons();
    $("btnStart").disabled = false;
    $("btnStop").disabled = true;
    stopPolling();

    const wasStopped = state.stopRequested;
    state.stopRequested = false;
    if (wasStopped) {
      setStatus("已停止", false);
    } else {
      const finalState = info.state;
      if (finalState) paintProgress(finalState);
      const remaining = Number(finalState && finalState.remaining) || 0;
      const failed = Number(finalState && finalState.fail) || 0;
      const incomplete = remaining > 0 || failed > 0 || (finalState && finalState.phase === "failed");
      if (incomplete) {
        const count = remaining || failed;
        setStatus("渲染未全部完成：仍有 " + count + " 个预设未生成", true);
      } else {
        const ok = info.code === 0;
        setStatus(ok ? "渲染完成" : "渲染结束（退出码 " + info.code + "）", !ok);
      }
    }
    await pullLog();
    await loadPresets();
    await refreshAeState();
  });

  window.hub.onPluginEffectsState((renderState) => {
    paintPluginEffectProgress(renderState);
  });

  window.hub.onPluginEffectsExit(async (info) => {
    const finalState = info.state || {};
    const wasScan =
      state.pluginCatalogScanning || finalState.mode === "catalog";
    const wasStopped = state.pluginEffectStopRequested;

    state.pluginEffectRendering = false;
    state.pluginCatalogScanning = false;
    state.pluginEffectStopRequested = false;
    updateRenderModeButtons();
    $("btnPluginEffectStart").disabled = false;
    $("btnPluginEffectStop").disabled = true;
    stopPluginEffectPolling();
    if (info.state) paintPluginEffectProgress(info.state);
    await refreshPluginCatalog();
    await pullPluginEffectLog();
    await refreshAeState();

    if (wasScan) {
      await loadEffects();
      if (wasStopped) {
        setStatus("已停止扫描插件目录");
      } else if (finalState.phase === "done") {
        setStatus(`插件目录已更新（${catalogItems().length} 条）`);
      } else {
        setStatus(finalState.message || "插件目录扫描未完成", true);
      }
      return;
    }

    /* 渲染结束刷新效果库，让新生成的预览立即出现 */
    await loadEffects();
    const remaining = Number(finalState.remaining) || 0;
    if (finalState.phase === "done" && remaining === 0) {
      setStatus("插件效果预览生成完成");
    } else if (wasStopped) {
      setStatus("插件效果预览生成已停止");
    } else if (finalState.phase === "paused") {
      setStatus(finalState.message || "已达轮数上限，可再次开始继续生成");
    } else {
      setStatus(
        "插件效果预览未全部完成" +
          (remaining > 0 ? `，仍有 ${remaining} 条待生成` : ""),
        true,
      );
    }
  });

  if (hubHas("onPluginEffectsCatalog")) {
    window.hub.onPluginEffectsCatalog((catalog) => {
      state.pluginCatalog = catalog && catalog.ok ? catalog : null;
      prunePluginEffectSelection();
      paintPluginCatalog();
    });
  }
}

async function boot() {
  bind();
  const snap = await refreshAeState();
  await fillBackgrounds();
  await fillPluginEffectBackgrounds();
  await loadPresetCategories();
  await loadPresets();
  await loadEffects();
  await pullLog();
  await refreshPluginCatalog();

  const last = await window.hub.renderSnapshot();
  if (last) paintProgress(last);
  else paintProgress(null);
  const lastPluginEffects = await window.hub.pluginEffectsSnapshot();
  if (lastPluginEffects) paintPluginEffectProgress(lastPluginEffects);
  else paintPluginEffectProgress(null);
  if (snap.pluginEffects && snap.pluginEffects.running) {
    setRenderMode("plugin");
    if (snap.pluginEffects.mode === "catalog") {
      state.pluginCatalogScanning = true;
      paintPluginCatalog();
      paintPluginEffectProgress(snap.pluginEffects.state || null);
    } else {
      state.pluginEffectRendering = true;
    }
    updateRenderModeButtons();
    $("btnPluginEffectStart").disabled = true;
    $("btnPluginEffectStop").disabled = false;
    startPluginEffectPolling();
  }

  if (!snap.ext.installed) {
    setStatus("没有检测到已安装的 DreamEngine 面板，先跑安装包里的安装脚本", true);
  }
}

boot();
