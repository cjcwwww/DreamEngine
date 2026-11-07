/* ============================================================
 * app.js —— 渲染进程逻辑
 *
 * 只用 window.hub（preload 暴露的白名单），不碰 Node。
 * 换壳（Tauri 等）时只需要替换 preload 那一层。
 * ============================================================ */

const $ = (id) => document.getElementById(id);
const RENDER_AE_KEY = "dreamengine.renderAePath.v1";

const state = {
  snapshot: null,
  presets: [],
  query: "",
  view: "presets",
  rendering: false,
  stopRequested: false,
  pluginEffectRendering: false,
  pluginEffectStopRequested: false,
  pollTimer: null,
  pluginEffectPollTimer: null,
  logTimer: null,
  presetHoldTimer: null,
  presetHoverStop: null,
  presetDeletePath: "",
  presetDeleteName: "",
  presetRenamePath: "",
  presetOrganizer: { categories: [], assignments: {}, favorites: {} },
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

/* ---------- 页签 ---------- */

function setView(name) {
  state.view = name;
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.view === name);
  }
  $("viewPresets").hidden = name !== "presets";
  $("viewRender").hidden = name !== "render";
  $("viewPluginEffects").hidden = name !== "pluginEffects";
  $("viewSettings").hidden = name !== "settings";

  if (name === "render") {
    refreshAeState();
    pullLog();
  }
  if (name === "pluginEffects") {
    refreshAeState();
    pullPluginEffectLog();
    window.hub.pluginEffectsSnapshot().then((last) => {
      if (last) paintPluginEffectProgress(last);
    });
  }
  if (name !== "presets") closePresetDelete();
  if (name !== "presets") closePresetRename();
  if (name !== "presets") hideCategoryMenu();
  if (name !== "presets" && state.presetHoverStop) state.presetHoverStop();
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
  for (const item of state.presets) {
    if (isPresetFavorite(item.path)) counts.favorite++;
    const id = categoryFor(item.path);
    if (!id) counts.uncategorized++;
    else counts[id] = (counts[id] || 0) + 1;
  }
  list.textContent = "";
  list.appendChild(categoryRow("__favorites__", "收藏", counts.favorite, true));
  list.appendChild(categoryRow("all", "全部预设", counts.all));
  list.appendChild(categoryRow("__uncategorized__", "未分类", counts.uncategorized));
  for (const category of categories()) {
    const row = categoryRow(category.id, category.name, counts[category.id] || 0);
    row.querySelector("button").addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openCategoryAdminMenu(category, event.clientX, event.clientY);
    });
    list.appendChild(row);
  }
}

function categoryRow(id, label, count, favoriteRow) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  const active = favoriteRow ? state.presetFavoritesOnly : state.presetCategory === id;
  button.className =
    "category-item" + (favoriteRow ? " favorite-category" : "") + (active ? " active" : "");
  const text = document.createElement("span");
  text.className = "category-label";
  text.textContent = label;
  const badge = document.createElement("span");
  badge.className = "category-count";
  badge.textContent = String(count);
  button.appendChild(text);
  button.appendChild(badge);
  button.addEventListener("click", () => {
    if (favoriteRow) state.presetFavoritesOnly = !state.presetFavoritesOnly;
    else state.presetCategory = id;
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
  menu.appendChild(menuButton("重命名", false, false, () => openPresetRename(item)));
  menu.appendChild(menuButton(favorite ? "取消收藏" : "收藏", false, false, () =>
    togglePresetFavorite(item),
  ));
  if (item.rendered) {
    menu.appendChild(menuButton("取消渲染", false, false, () => clearPresetRender(item)));
  }
  menu.appendChild(menuButton("单独渲染", false, false, () => renderSinglePreset(item)));
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

function renderPresets() {
  const grid = $("grid");
  if (state.presetHoverStop) state.presetHoverStop();
  const query = state.query.trim().toLowerCase();
  const items = state.presets.filter((item) => {
    if (query && !item.name.toLowerCase().includes(query)) return false;
    if (state.presetFavoritesOnly && !isPresetFavorite(item.path)) return false;
    const cat = categoryFor(item.path);
    if (state.presetCategory === "__uncategorized__") return !cat;
    if (state.presetCategory !== "all") return cat === state.presetCategory;
    return true;
  });

  grid.textContent = "";
  renderCategories();

  const empty = $("emptyPresets");
  empty.hidden = items.length > 0;
  grid.hidden = items.length === 0;

  for (const item of items) {
    const card = document.createElement("div");
    card.className = "card";

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
      ph.textContent = "待渲染";
      thumb.appendChild(ph);
    }
    bindFavoriteButton(thumb, item);
    bindCategoryButton(thumb, item);

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
    category.textContent = categoryLabel(item.path) || "未分类";

    titleRow.appendChild(name);
    titleRow.appendChild(size);
    body.appendChild(titleRow);
    body.appendChild(category);
    card.appendChild(thumb);
    card.appendChild(body);
    bindPresetLongPress(card, item);
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openPresetMenu(item, event.clientX, event.clientY);
    });
    grid.appendChild(card);
  }

  const rendered = state.presets.filter((p) => p.rendered).length;
  $("tabPresetCount").textContent = String(state.presets.length);
  $("presetHint").textContent =
    state.presets.length === 0
      ? ""
      : `${state.presets.length} 个预设 · 已生成 ${rendered} 个预览`;
}

async function loadPresets() {
  const data = await window.hub.listPresets();
  state.presets = data.items || [];
  renderPresets();
}

function bindPresetLongPress(card, item) {
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
    state.rendering || state.pluginEffectRendering || !ae.exe;
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
    state.pluginEffectRendering || state.rendering || ae.running || !ae.exe || !extReady;
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

async function pullLog() {
  const text = await window.hub.logTail(40);
  $("logBody").textContent = text || "（暂无）";
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
  const result = await window.hub.startRender(options);
  if (!result.ok) {
    setStatus("启动失败：" + (result.reason || ""), true);
    return;
  }

  state.rendering = true;
  state.stopRequested = false;
  $("btnStart").disabled = true;
  $("btnPluginEffectStart").disabled = true;
  $("btnStop").disabled = false;
  setStatus(options.onlyPreset ? "已开始单独渲染" : "渲染已启动");
  startPolling();

  // AE 还在跑时 ps1 会进入等待，这里先把话说清楚，别让人以为卡住了
  paintProgress({
    phase: state.snapshot && state.snapshot.ae.running ? "waiting-close" : "rendering",
    message: "",
  });
  $("renderMessage").textContent =
    state.snapshot && state.snapshot.ae.running
      ? "等待你关闭 After Effects…"
      : options.onlyPreset
        ? "正在单独渲染所选预设（约 25 秒启动 AE）…"
        : "正在启动专用 AE 实例（约 25 秒）…";
}

async function renderSinglePreset(item) {
  setView("render");
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

async function pullPluginEffectLog() {
  const text = await window.hub.logPluginEffectsTail(40);
  $("pluginEffectLogBody").textContent = text || "（暂无）";
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

async function startPluginEffects() {
  if (!state.snapshot || !state.snapshot.ae.installed.length) return;
  const options = {
    ae: $("pluginEffectAeVersion").value,
    background: $("pluginEffectBackground").value || "",
    limit: Number($("pluginEffectLimit").value) || 8,
    rounds: Number($("pluginEffectRounds").value) || 200,
  };
  const result = await window.hub.startPluginEffects(options);
  if (!result.ok) {
    setStatus("插件效果生成启动失败：" + (result.reason || ""), true);
    return;
  }

  state.pluginEffectRendering = true;
  state.pluginEffectStopRequested = false;
  $("btnPluginEffectStart").disabled = true;
  $("btnStart").disabled = true;
  $("btnPluginEffectStop").disabled = false;
  setStatus("插件效果预览生成已启动");
  paintPluginEffectProgress({
    phase: "starting",
    total: 0,
    current: 0,
    remaining: 0,
    message: "正在读取当前 After Effects 的插件效果清单…",
  });
  startPluginEffectPolling();
}

async function stopPluginEffects() {
  state.pluginEffectStopRequested = true;
  const result = await window.hub.stopPluginEffects();
  if (!result || !result.ok) state.pluginEffectStopRequested = false;
  state.pluginEffectRendering = false;
  $("btnPluginEffectStart").disabled = false;
  $("btnPluginEffectStop").disabled = true;
  stopPluginEffectPolling();
  setStatus("已停止插件效果生成");
  $("pluginEffectMessage").textContent = "已手动停止，下次开始会从断点继续。";
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

  $("search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderPresets();
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
  $("btnOpenLog").addEventListener("click", () => {
    if (state.snapshot) window.hub.reveal(state.snapshot.paths.probe);
  });
  $("btnPluginEffectStart").addEventListener("click", startPluginEffects);
  $("btnPluginEffectStop").addEventListener("click", stopPluginEffects);
  $("btnPluginEffectLog").addEventListener("click", () => {
    if (state.snapshot) window.hub.reveal(state.snapshot.paths.probe);
  });

  for (const select of document.querySelectorAll(".ae-version-select")) {
    select.addEventListener("change", (event) => {
      selectRenderAe(event.target.value, event.target);
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
    state.pluginEffectRendering = false;
    const wasStopped = state.pluginEffectStopRequested;
    state.pluginEffectStopRequested = false;
    $("btnPluginEffectStart").disabled = false;
    $("btnPluginEffectStop").disabled = true;
    stopPluginEffectPolling();
    if (info.state) paintPluginEffectProgress(info.state);
    await pullPluginEffectLog();
    await refreshAeState();

    const finalState = info.state || {};
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
}

async function boot() {
  bind();
  const snap = await refreshAeState();
  await fillBackgrounds();
  await fillPluginEffectBackgrounds();
  await loadPresetCategories();
  await loadPresets();
  await pullLog();

  const last = await window.hub.renderSnapshot();
  if (last) paintProgress(last);
  else paintProgress(null);
  const lastPluginEffects = await window.hub.pluginEffectsSnapshot();
  if (lastPluginEffects) paintPluginEffectProgress(lastPluginEffects);
  else paintPluginEffectProgress(null);
  if (snap.pluginEffects && snap.pluginEffects.running) {
    state.pluginEffectRendering = true;
    $("btnPluginEffectStart").disabled = true;
    $("btnPluginEffectStop").disabled = false;
    startPluginEffectPolling();
  }

  if (!snap.ext.installed) {
    setStatus("没有检测到已安装的 DreamEngine 面板，先跑安装包里的安装脚本", true);
  }
}

boot();
