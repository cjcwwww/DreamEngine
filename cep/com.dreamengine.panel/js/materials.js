/* ============================================================
 * materials.js —— 素材库视图
 *
 * CEP 只负责分类、卡片和媒体预览；目录扫描与 AE 导入全部走
 * engine/materials.jsx。
 * ============================================================ */

var AEV_MaterialsUI = (function () {
  var state = {
    lang: "zh",
    items: [],
    root: "",
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

  function categoryRows() {
    var counts = {
      favorites: 0,
      all: state.items.length,
      video: 0,
      image: 0,
      audio: 0,
      project: 0
    };
    for (var i = 0; i < state.items.length; i++) {
      var type = state.items[i].type;
      if (counts[type] !== undefined) counts[type]++;
      if (isFavorite(state.items[i].path)) counts.favorites++;
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

  function renderCategories() {
    var list = byId("materialCategories");
    if (!list) return;
    list.textContent = "";
    var rows = categoryRows();
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

  function visibleItems() {
    var query = state.query.toLowerCase();
    var out = [];
    for (var i = 0; i < state.items.length; i++) {
      var item = state.items[i];
      if (state.category !== "all" && item.type !== state.category) {
        continue;
      }
      if (state.favoritesOnly && !isFavorite(item.path)) continue;
      if (query) {
        var haystack = String(item.name + " " + item.path + " " + item.type).toLowerCase();
        if (haystack.indexOf(query) < 0) continue;
      }
      out.push(item);
    }
    return out;
  }

  function renderCards() {
    var grid = byId("materialGrid");
    var empty = byId("materialEmpty");
    if (!grid) return;
    pauseAll();
    grid.textContent = "";
    var items = visibleItems();
    for (var i = 0; i < items.length; i++) {
      grid.appendChild(makeCard(items[i]));
    }
    grid.hidden = items.length === 0;
    if (empty) empty.hidden = items.length !== 0;
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
    renderCategories();
    renderCards();
    var root = byId("materialRoot");
    if (root) root.textContent = state.root || L("materials.noRoot");
    var summary = byId("materialSummary");
    if (summary) {
      if (!state.root) summary.textContent = L("materials.noRoot");
      else summary.textContent = L("materials.summary", [state.items.length, visibleItems().length]);
    }
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
        state.root = data.root || "";
        state.loaded = true;
      } else if (data && data.status === "error") {
        setStatus(L("materials.readFailed", [data.reason || ""]), true);
      }
      render();
    });
  }

  function pickRoot() {
    run("AEV_Materials.pickRootJson()", function (text) {
      var data = parseResult(text);
      if (!data || data.status === "cancelled") return;
      if (data.status !== "ok") {
        setStatus(L("materials.readFailed", [data.reason || ""]), true);
        return;
      }
      state.items = normalizeItems(data.items);
      state.root = data.root || "";
      state.loaded = true;
      setStatus(L("materials.scanned", [state.items.length]), false);
      render();
    });
  }

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
    var pick = byId("btnMaterialRoot");
    var refreshButton = byId("btnMaterialRefresh");
    var search = byId("materialSearch");
    if (pick) pick.addEventListener("click", pickRoot);
    if (refreshButton) refreshButton.addEventListener("click", refresh);
    if (search) {
      search.addEventListener("input", function () {
        state.query = this.value;
        renderCards();
      });
    }
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

  document.addEventListener("DOMContentLoaded", bind);

  return {
    enter: enter,
    leave: leave,
    refresh: refresh,
    setLanguage: setLanguage,
    pauseAll: pauseAll,
    state: state
  };
})();
