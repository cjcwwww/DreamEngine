/* ============================================================
 * app.js —— 渲染进程逻辑
 *
 * 只用 window.hub（preload 暴露的白名单），不碰 Node。
 * 换壳（Tauri 等）时只需要替换 preload 那一层。
 * ============================================================ */

const $ = (id) => document.getElementById(id);

const state = {
  snapshot: null,
  presets: [],
  query: "",
  view: "presets",
  rendering: false,
  stopRequested: false,
  pollTimer: null,
  logTimer: null,
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

/* ---------- 页签 ---------- */

function setView(name) {
  state.view = name;
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.view === name);
  }
  $("viewPresets").hidden = name !== "presets";
  $("viewRender").hidden = name !== "render";
  $("viewSettings").hidden = name !== "settings";

  if (name === "render") {
    refreshAeState();
    pullLog();
  }
}

/* ---------- 预设库 ---------- */

function renderPresets() {
  const grid = $("grid");
  const query = state.query.trim().toLowerCase();
  const items = state.presets.filter(
    (item) => !query || item.name.toLowerCase().includes(query),
  );

  grid.textContent = "";

  const empty = $("emptyPresets");
  const hasAny = state.presets.length > 0;
  empty.hidden = hasAny;
  grid.hidden = !hasAny;

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

      const badge = document.createElement("span");
      badge.className = "card-badge done";
      badge.textContent = item.offline ? "离线生成" : "已渲染";
      thumb.appendChild(badge);

      if (item.animated && item.frames > 1) {
        const anim = document.createElement("span");
        anim.className = "card-badge anim";
        anim.style.left = "auto";
        anim.style.right = "7px";
        anim.textContent = item.frames + " 帧";
        thumb.appendChild(anim);
      }
    } else {
      const ph = document.createElement("div");
      ph.className = "placeholder";
      ph.textContent = "待渲染";
      thumb.appendChild(ph);
    }

    const body = document.createElement("div");
    body.className = "card-body";

    const name = document.createElement("div");
    name.className = "card-name";
    name.textContent = item.name;
    name.title = item.name;

    const meta = document.createElement("div");
    meta.className = "card-meta";
    meta.textContent = item.rendered
      ? `${item.frames} 帧 · ${formatSize(item.size)}`
      : formatSize(item.size);

    body.appendChild(name);
    body.appendChild(meta);
    card.appendChild(thumb);
    card.appendChild(body);
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

  $("btnStart").disabled = state.rendering || !ae.exe;
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
    failed: "已停止",
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
  fillSettings(snap);
  return snap;
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

async function startRender() {
  const options = {
    background: $("background").value,
    limit: Number($("limit").value) || 12,
    rounds: Number($("rounds").value) || 40,
  };
  const result = await window.hub.startRender(options);
  if (!result.ok) {
    setStatus("启动失败：" + (result.reason || ""), true);
    return;
  }

  state.rendering = true;
  state.stopRequested = false;
  $("btnStart").disabled = true;
  $("btnStop").disabled = false;
  setStatus("渲染已启动");
  startPolling();

  // AE 还在跑时 ps1 会进入等待，这里先把话说清楚，别让人以为卡住了
  paintProgress({
    phase: state.snapshot && state.snapshot.ae.running ? "waiting-close" : "rendering",
    message: "",
  });
  $("renderMessage").textContent =
    state.snapshot && state.snapshot.ae.running
      ? "等待你关闭 After Effects…"
      : "正在启动专用 AE 实例（约 25 秒）…";
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

/* ---------- 绑定 ---------- */

function bind() {
  document.getElementById("tabs").addEventListener("click", (event) => {
    const tab = event.target.closest(".tab");
    if (tab) setView(tab.dataset.view);
  });

  $("btnImport").addEventListener("click", addPresets);

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
    if (!added.length) return;
    await fillBackgrounds();
    select.value = added[0];
    select.dataset.previous = added[0];
    setStatus(`已添加背景：${added[0].split(/[\\/]/).pop()}`);
  });

  $("btnStart").addEventListener("click", startRender);
  $("btnStop").addEventListener("click", stopRender);
  $("btnOpenLog").addEventListener("click", () => {
    if (state.snapshot) window.hub.reveal(state.snapshot.paths.probe);
  });

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
      const ok = info.code === 0;
      setStatus(ok ? "渲染完成" : "渲染结束（退出码 " + info.code + "）", !ok);
    }
    await pullLog();
    await loadPresets();
    await refreshAeState();
  });
}

async function boot() {
  bind();
  const snap = await refreshAeState();
  await fillBackgrounds();
  await loadPresets();
  await pullLog();

  const last = await window.hub.renderSnapshot();
  if (last) paintProgress(last);
  else paintProgress(null);

  if (!snap.ext.installed) {
    setStatus("没有检测到已安装的 DreamEngine 面板，先跑安装包里的安装脚本", true);
  }
}

boot();
