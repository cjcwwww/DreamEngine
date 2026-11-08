/* ============================================================
 * materials.js —— 素材库视图
 *
 * CEP 只负责分类、卡片和媒体预览；目录扫描与 AE 导入全部走
 * engine/materials.jsx。
 *
 * 扫描层返回的是「递归扫描后的扁平 items」，每条带绝对 path。目录树完全
 * 在 UI 层从 path 派生：以 root 为基准按 "/" 切分，去掉最后一段文件名，
 * 剩下的就是各级文件夹。这样不需要扫描层额外返回目录节点，也不动 jsx。
 *
 * 语法：ES5（CEP 11 的老 CEF）：只用 var / function，不用箭头函数、
 * 模板字符串、let/const、可选链。
 * ============================================================ */

var AEV_MaterialsUI = (function () {
  var state = {
    lang: "zh",
    items: [],
    root: "",
    dir: "",
    category: "all",
    favoritesOnly: false,
    query: "",
    loaded: false,
    extensionPath: "",
    activeMedia: null,
    videoTimer: null,
    clickTimer: null,
    selectedPath: ""
  };

  function byId(id) { return document.getElementById(id); }
  function L(key, args) { return AEV_t(key, state.lang, args); }

  /* ---------- 路径工具：ExtendScript 给的是 "/" 分隔的绝对路径 ---------- */

  function normPath(path) {
    return String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function pathKey(path) { return normPath(path).toLowerCase(); }

  function isUnder(path, dir) {
    return pathKey(path).indexOf(pathKey(dir) + "/") === 0;
  }

  function baseName(path) {
    var parts = normPath(path).split("/");
    return parts[parts.length - 1] || normPath(path);
  }

  function joinPath(dir, name) { return normPath(dir) + "/" + name; }

  /* ---------- 从扁平 items 派生目录树 ----------
   * dirs        : 所有「有素材后代」的目录（含 root），刷新后用来校验当前目录
   * folderCounts: 每个目录下（递归）的素材数
   * direct      : 当前目录下的直接素材（不含子目录）
   * folders     : 当前目录下的直接子文件夹（含递归素材数），空文件夹不会出现
   */
  function buildTree() {
    var root = normPath(state.root);
    var dir = normPath(state.dir) || root;
    var dirKey = pathKey(dir);
    var dirs = {};
    var folderCounts = {};
    var childMap = {};
    var direct = [];
    if (root) dirs[pathKey(root)] = true;

    for (var i = 0; i < state.items.length; i++) {
      var item = state.items[i];
      var full = normPath(item.path);
      if (!root || !isUnder(full, root)) continue;
      var parts = full.substring(root.length + 1).split("/");
      if (!parts.length) continue;
      parts.pop();

      var parent = root;
      var k;
      for (k = 0; k < parts.length; k++) {
        parent = joinPath(parent, parts[k]);
        dirs[pathKey(parent)] = true;
        folderCounts[pathKey(parent)] = (folderCounts[pathKey(parent)] || 0) + 1;
      }

      if (pathKey(parent) === dirKey) {
        direct.push(item);
      } else if (isUnder(parent, dir)) {
        var childName = parent.substring(dir.length + 1).split("/")[0];
        if (!childName) continue;
        var childPath = joinPath(dir, childName);
        var childKey = pathKey(childPath);
        if (!childMap[childKey]) childMap[childKey] = { name: childName, path: childPath };
      }
    }

    var folders = [];
    for (var key in childMap) {
      if (childMap.hasOwnProperty(key)) {
        folders.push({
          name: childMap[key].name,
          path: childMap[key].path,
          count: folderCounts[key] || 0
        });
      }
    }
    folders.sort(function (a, b) {
      return pathKey(a.path) < pathKey(b.path) ? -1 : 1;
    });

    return { dirs: dirs, direct: direct, folders: folders };
  }

  /** 刷新后保留当前目录；若已不存在，逐级回退到最近一个仍存在的上级，最后回根。 */
  function resolveDir(dirs) {
    var root = normPath(state.root);
    if (!root) { state.dir = ""; return false; }
    var rootKey = pathKey(root);
    var candidate = normPath(state.dir) || root;
    var before = pathKey(state.dir);

    if (pathKey(candidate) !== rootKey &&
        pathKey(candidate).indexOf(rootKey + "/") !== 0) {
      state.dir = root;
      return pathKey(state.dir) !== before;
    }
    while (true) {
      if (dirs[pathKey(candidate)]) {
        state.dir = candidate;
        return pathKey(state.dir) !== before;
      }
      if (pathKey(candidate) === rootKey) break;
      var at = candidate.lastIndexOf("/");
      if (at < rootKey.length) break;
      candidate = candidate.substring(0, at);
    }
    state.dir = root;
    return pathKey(state.dir) !== before;
  }

  function run(expr, callback) {
    if (!state.extensionPath) {
      Bridge.getExtensionPath(function (path) {
        state.extensionPath = path || "";
        if (!state.extensionPath) {
          callback("ERR:no_extension_path");
          return;
        }
        Bridge.runEngine(state.extensionPath, expr, callback);
      });
      return;
    }
    Bridge.runEngine(state.extensionPath, expr, callback);
  }

  function parseResult(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return { status: "error", reason: String(text || e) };
    }
  }

  /** Old indices may contain URL-encoded File.name values from ExtendScript. */
  function displayName(name) {
    var text = String(name || "");
    try {
      return decodeURI(text);
    } catch (e) {
      return text;
    }
  }

  function normalizeItems(items) {
    var source = items || [];
    var out = [];
    for (var i = 0; i < source.length; i++) {
      if (!source[i] || source[i].exists === false) continue;
      source[i].name = displayName(source[i].name);
      out.push(source[i]);
    }
    return out;
  }

  function categoryRows(tree) {
    var counts = {
      favorites: 0,
      all: tree.direct.length,
      video: 0,
      image: 0,
      audio: 0,
      project: 0
    };
    for (var i = 0; i < tree.direct.length; i++) {
      var type = tree.direct[i].type;
      if (counts[type] !== undefined) counts[type]++;
      if (isFavorite(tree.direct[i].path)) counts.favorites++;
    }
    return [
      { id: "__favorites__", label: L("favorites.filter"), count: counts.favorites },
      { id: "all", label: L("materials.all"), count: counts.all },
      { id: "video", label: L("materials.video"), count: counts.video },
      { id: "image", label: L("materials.image"), count: counts.image },
      { id: "audio", label: L("materials.audio"), count: counts.audio },
      { id: "project", label: L("materials.project"), count: counts.project }
    ];
  }

  function renderCategories(tree) {
    var list = byId("materialCategories");
    if (!list) return;
    list.textContent = "";
    var rows = categoryRows(tree);
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var li = document.createElement("li");
        li.className = "category-item material-category" +
          (row.id === "__favorites__" ? " favorite-category" : "") +
          ((row.id === "__favorites__" ? state.favoritesOnly : state.category === row.id)
            ? " active"
            : "");
        li.setAttribute("role", "button");
        li.appendChild(textNode("span", "category-label", row.label));
        li.appendChild(textNode("span", "category-count", String(row.count)));
        li.addEventListener("click", function () {
          if (row.id === "__favorites__") state.favoritesOnly = !state.favoritesOnly;
          else state.category = row.id;
          render();
        });
        list.appendChild(li);
      })(rows[i]);
    }
  }

  function textNode(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }

  /** 搜索只在当前目录的直接素材里做，不穿透子目录。 */
  function visibleItems(tree) {
    var query = state.query.toLowerCase();
    var out = [];
    for (var i = 0; i < tree.direct.length; i++) {
      var item = tree.direct[i];
      if (state.category !== "all" && item.type !== state.category) {
        continue;
      }
      if (state.favoritesOnly && !isFavorite(item.path)) continue;
      if (query) {
        var haystack = String(item.name + " " + item.type).toLowerCase();
        if (haystack.indexOf(query) < 0) continue;
      }
      out.push(item);
    }
    return out;
  }

  /* ---------- 面包屑 ---------- */
  function renderBreadcrumb() {
    var nav = byId("materialBreadcrumb");
    if (!nav) return;
    nav.textContent = "";
    var root = normPath(state.root);
    if (!root) {
      var none = document.createElement("span");
      none.className = "material-crumb current";
      none.textContent = L("materials.noRoot");
      nav.appendChild(none);
      return;
    }

    /* 首段是根目录的文件夹名（不是完整路径），完整路径放在 title 里。 */
    var segments = [{ label: baseName(root), path: root, title: root }];
    var dir = normPath(state.dir) || root;
    if (pathKey(dir) !== pathKey(root)) {
      var parts = dir.substring(root.length + 1).split("/");
      var acc = root;
      for (var i = 0; i < parts.length; i++) {
        acc = joinPath(acc, parts[i]);
        segments.push({ label: parts[i], path: acc, title: acc });
      }
    }

    /* 层级过多：中间折成 "…"，首段与末段始终可见。 */
    var shown = segments;
    if (segments.length > 4) {
      shown = [segments[0], null, segments[segments.length - 1]];
    }

    for (var j = 0; j < shown.length; j++) {
      if (j > 0) {
        nav.appendChild(textNode("span", "material-crumb-sep", "›"));
      }
      var seg = shown[j];
      if (seg === null) {
        var hidden = [];
        for (var h = 1; h < segments.length - 1; h++) hidden.push(segments[h].label);
        var dots = textNode("span", "material-crumb-ellipsis", "…");
        dots.title = hidden.join(" › ");
        nav.appendChild(dots);
        continue;
      }
      var isLast = j === shown.length - 1;
      var node;
      if (isLast) {
        /* 当前层：纯文本，不是链接，也不可点。 */
        node = document.createElement("span");
        node.className = "material-crumb current";
      } else {
        node = document.createElement("button");
        node.type = "button";
        node.className = "material-crumb";
        (function (target, button) {
          button.addEventListener("click", function () {
            state.dir = target;
            state.selectedPath = "";
            render();
          });
        })(seg.path, node);
      }
      node.textContent = seg.label;
      if (seg.title) node.title = seg.title;
      nav.appendChild(node);
    }
  }

  function renderCards(tree) {
    var grid = byId("materialGrid");
    var empty = byId("materialEmpty");
    if (!grid) return;
    pauseAll();
    grid.textContent = "";
    var items = visibleItems(tree);
    var searching = !!state.query;
    var i;
    if (!searching) {
      for (i = 0; i < tree.folders.length; i++) {
        grid.appendChild(makeFolderCard(tree.folders[i]));
      }
    }
    for (i = 0; i < items.length; i++) {
      grid.appendChild(makeCard(items[i]));
    }
    var total = grid.children.length;
    grid.hidden = total === 0;
    if (empty) {
      empty.hidden = total !== 0;
      if (total === 0) {
        var strong = byId("materialEmptyText") || empty.querySelector("strong");
        var folderIsEmpty = !searching &&
          tree.folders.length === 0 && tree.direct.length === 0;
        var key = folderIsEmpty ? "materials.emptyFolder" : "materials.empty";
        if (strong) {
          strong.setAttribute("data-i18n", key);
          strong.textContent = L(key);
        }
      }
    }
  }

  /** 文件夹卡片复用 .material-card 骨架，因此天然遵循 --view-size 与网格布局。 */
  function makeFolderCard(folder) {
    var card = document.createElement("article");
    card.className = "material-card folder";
    card.setAttribute("data-path", folder.path);
    if (state.selectedPath && AEV_Prefs.pathKey(state.selectedPath) === AEV_Prefs.pathKey(folder.path)) {
      card.className += " selected";
    }
    card.title = folder.path;

    var preview = document.createElement("div");
    preview.className = "material-preview";
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "material-folder-icon");
    svg.setAttribute("aria-hidden", "true");
    var shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
    shape.setAttribute("d", "M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z");
    svg.appendChild(shape);
    preview.appendChild(svg);
    card.appendChild(preview);

    var body = document.createElement("div");
    body.className = "material-card-body";
    body.appendChild(textNode("div", "material-name", folder.name));
    body.appendChild(textNode("div", "material-meta", L("materials.folderItems", [folder.count])));
    card.appendChild(body);

    card.addEventListener("click", function () {
      selectCard(folder.path);
    });
    card.addEventListener("dblclick", function () {
      state.dir = folder.path;
      state.selectedPath = "";
      render();
    });
    return card;
  }

  function makeCard(item) {
    var card = document.createElement("article");
    card.className = "material-card " + item.type;
    card.setAttribute("data-path", item.path);
    if (state.selectedPath && AEV_Prefs.pathKey(state.selectedPath) === AEV_Prefs.pathKey(item.path)) {
      card.className += " selected";
    }
    card.title = item.path;

    var preview = document.createElement("div");
    preview.className = "material-preview";
    if (item.type === "image") {
      var image = document.createElement("img");
      image.loading = "lazy";
      image.alt = item.name;
      image.src = fileUrl(item.imageThumb || item.path);
      preview.appendChild(image);
    } else if (item.type === "video") {
      var video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.src = fileUrl(item.videoPreview || item.path);
      preview.appendChild(video);
    } else if (item.type === "audio") {
      var waveform = document.createElement("div");
      waveform.className = "material-waveform";
      if (item.waveform) waveform.style.backgroundImage = "url(" + fileUrl(item.waveform) + ")";
      preview.appendChild(waveform);
      var audio = document.createElement("audio");
      audio.hidden = true;
      audio.preload = "metadata";
      audio.src = fileUrl(item.path);
      card.appendChild(audio);
    } else {
      preview.appendChild(textNode("span", "material-kind", L("materials.project")));
    }
    card.appendChild(preview);
    card.appendChild(makeFavoriteButton(item.path));

    var body = document.createElement("div");
    body.className = "material-card-body";
    body.appendChild(textNode("div", "material-name", item.name));
    body.appendChild(textNode(
      "div",
      "material-meta",
      item.type + " · " + formatSize(item.size)
    ));
    card.appendChild(body);
    bindMaterialCard(card, item);
    return card;
  }

  function isFavorite(path) {
    return window.AEV_Prefs && AEV_Prefs.isFavorite("materials", path);
  }

  function makeFavoriteButton(path) {
    var active = isFavorite(path);
    var button = document.createElement("button");
    button.type = "button";
    button.className = "favorite-toggle" + (active ? " active" : "");
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.setAttribute("aria-label", L(active ? "favorites.remove" : "favorites.add"));
    button.title = L(active ? "favorites.remove" : "favorites.add");
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    var star = document.createElementNS("http://www.w3.org/2000/svg", "path");
    star.setAttribute("d", "M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z");
    svg.appendChild(star);
    button.appendChild(svg);
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      AEV_Prefs.toggleFavorite("materials", path);
      render();
    });
    button.addEventListener("dblclick", function (event) {
      event.stopPropagation();
    });
    return button;
  }

  function fileUrl(path) {
    var normalized = String(path || "").replace(/\\/g, "/");
    return "file:///" + encodeURI(normalized).replace(/#/g, "%23");
  }

  function bindMaterialCard(card, item) {
    var media = card.querySelector("video,audio");
    card.addEventListener("click", function (event) {
      if (event.target && event.target.closest && event.target.closest(".favorite-toggle")) return;
      selectCard(item.path);
      if (!media) {
        pauseAll();
        return;
      }
      if (state.clickTimer) {
        clearTimeout(state.clickTimer);
        state.clickTimer = null;
      }
      if (event.detail > 1) return;
      state.clickTimer = setTimeout(function () {
        state.clickTimer = null;
        toggleMedia(media, item.type);
      }, 220);
    });
    card.addEventListener("dblclick", function (event) {
      if (event.target && event.target.closest && event.target.closest(".favorite-toggle")) return;
      if (state.clickTimer) {
        clearTimeout(state.clickTimer);
        state.clickTimer = null;
      }
      importItem(item);
    });
  }

  function selectCard(path) {
    state.selectedPath = path;
    var cards = document.querySelectorAll(".material-card");
    for (var i = 0; i < cards.length; i++) {
      var same = AEV_Prefs.pathKey(cards[i].getAttribute("data-path")) === AEV_Prefs.pathKey(path);
      cards[i].className = cards[i].className.replace(/\s*selected/g, "");
      if (same) cards[i].className += " selected";
    }
  }

  function toggleMedia(media, type) {
    var wasPlaying = state.activeMedia === media;
    pauseAll();
    if (wasPlaying) return;
    if (type === "video") playVideo(media);
    else if (type === "audio") playAudio(media);
  }

  function playVideo(video) {
    pauseAll();
    state.activeMedia = video;
    try { video.currentTime = 0; } catch (e) {}
    try {
      var promise = video.play();
      if (promise && promise.catch) promise.catch(function () {});
    } catch (e2) {}
    state.videoTimer = setTimeout(pauseAll, 2000);
  }

  function playAudio(audio) {
    pauseAll();
    state.activeMedia = audio;
    audio.addEventListener("ended", function () {
      if (state.activeMedia === audio) pauseAll();
    }, { once: true });
    try {
      var promise = audio.play();
      if (promise && promise.catch) promise.catch(function () {});
    } catch (e) {}
  }

  function importItem(item) {
    run(
      "AEV_Materials.importJson(" +
        JSON.stringify(item.path) + "," +
        JSON.stringify(item.type) + ")",
      function (text) {
      var data = parseResult(text);
      if (data && data.status === "ok") {
        setStatus(L(
          data.kind === "project" ? "materials.importedProject" : "materials.addedToComp",
          [item.name, Number(data.time) || 0]
        ), false);
      } else {
        var reason = data && data.reason ? data.reason : "unknown";
        setStatus(
          reason === "no_comp"
            ? L("materials.noComp")
            : L("materials.importFailed", [reason]),
          true
        );
      }
      }
    );
  }

  function formatSize(bytes) {
    var size = Number(bytes) || 0;
    if (size < 1024) return size + " B";
    if (size < 1024 * 1024) return Math.round(size / 1024) + " KB";
    return (size / 1024 / 1024).toFixed(1) + " MB";
  }

  function render() {
    var tree = buildTree();
    if (resolveDir(tree.dirs)) tree = buildTree();
    renderBreadcrumb();
    renderCategories(tree);
    renderCards(tree);
  }

  function pauseAll() {
    if (state.clickTimer) {
      clearTimeout(state.clickTimer);
      state.clickTimer = null;
    }
    if (state.videoTimer) {
      clearTimeout(state.videoTimer);
      state.videoTimer = null;
    }
    if (state.activeMedia) {
      try { state.activeMedia.pause(); } catch (e) {}
      try { state.activeMedia.currentTime = 0; } catch (e2) {}
    }
    state.activeMedia = null;
  }

  function loadIndex() {
    run("AEV_Materials.indexJson()", function (text) {
      var data = parseResult(text);
      if (data && data.status !== "error" && data.items) {
        state.items = normalizeItems(data.items);
        state.root = normPath(data.root || "");
        state.dir = state.root;
        state.loaded = true;
      } else if (data && data.status === "error") {
        setStatus(L("materials.readFailed", [data.reason || ""]), true);
      }
      render();
    });
  }

  /** 换目录：复用 pickRoot 的逻辑，调用 AEV_Materials.pickRootJson()。 */
  function pickRoot() {
    run("AEV_Materials.pickRootJson()", function (text) {
      var data = parseResult(text);
      if (!data || data.status === "cancelled") return;
      if (data.status !== "ok") {
        setStatus(L("materials.readFailed", [data.reason || ""]), true);
        return;
      }
      state.items = normalizeItems(data.items);
      state.root = normPath(data.root || "");
      state.dir = state.root;
      state.selectedPath = "";
      state.loaded = true;
      setStatus(L("materials.scanned", [state.items.length]), false);
      render();
    });
  }

  /** 刷新：scanJson(root)；state.dir 不变，由 render() 里的 resolveDir 校验并回退。 */
  function refresh() {
    if (!state.root) {
      pickRoot();
      return;
    }
    run("AEV_Materials.scanJson(" + JSON.stringify(state.root) + ")", function (text) {
      var data = parseResult(text);
      if (!data || data.status !== "ok") {
        setStatus(L("materials.readFailed", [data && data.reason ? data.reason : ""]), true);
        return;
      }
      state.items = normalizeItems(data.items);
      state.loaded = true;
      setStatus(L("materials.scanned", [state.items.length]), false);
      render();
    });
  }

  function setStatus(text, error) {
    var el = byId("statusText");
    if (!el) return;
    el.textContent = text;
    el.style.color = error ? "var(--danger)" : "";
  }

  function bind() {
    var changeRoot = byId("btnMaterialChangeRoot");
    var refreshButton = byId("btnMaterialRefresh");
    if (changeRoot) changeRoot.addEventListener("click", pickRoot);
    if (refreshButton) refreshButton.addEventListener("click", refresh);
  }

  function enter() {
    if (!state.loaded) loadIndex();
    else render();
  }

  function leave() {
    pauseAll();
  }

  function setLanguage(lang) {
    state.lang = lang === "en" ? "en" : "zh";
    render();
  }

  /**
   * 搜索词由顶栏那一个搜索框统一驱动（原来在素材页里还有一个自己的输入框）。
   * 只改查询并重绘，不做防抖 —— 卡片数量有限，按下即筛。
   */
  function setQuery(value) {
    var next = String(value === undefined || value === null ? "" : value);
    if (next === state.query) return;
    state.query = next;
    if (state.loaded) render();
  }

  function getQuery() {
    return state.query;
  }

  document.addEventListener("DOMContentLoaded", bind);

  return {
    enter: enter,
    leave: leave,
    refresh: refresh,
    setLanguage: setLanguage,
    setQuery: setQuery,
    getQuery: getQuery,
    pauseAll: pauseAll,
    state: state
  };
})();
