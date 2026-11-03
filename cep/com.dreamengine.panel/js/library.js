var AEV_Library = (function () {
  var state = {
    lang: "zh",
    query: "",
    plugin: "内置",
    showAll: false,
    names: {},
    previews: {},
    manifest: null,
    catalog: [],
    items: []
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function loadJson(path, callback) {
    var request = new XMLHttpRequest();
    request.open("GET", path, true);
    request.onreadystatechange = function () {
      if (request.readyState !== 4) return;
      if ((request.status === 200 || request.status === 0) && request.responseText) {
        try {
          callback(null, JSON.parse(request.responseText));
        } catch (error) {
          callback(error);
        }
      } else {
        callback(new Error("读取失败：" + path));
      }
    };
    request.send();
  }

  function getCatalog(callback) {
    Bridge.getExtensionPath(function (extensionPath) {
      if (!extensionPath) {
        callback(new Error("无法取得扩展目录"));
        return;
      }
      var catalogPath = extensionPath + "/engine/catalog.jsx";
      var jsx =
        "(function(){try{$.evalFile(new File(" +
        JSON.stringify(catalogPath) +
        "));return AEV_Catalog.getCatalogJson();}catch(e){return 'ERR:'+e.toString();}})()";
      Bridge.evalAE(jsx, function (result) {
        if (!result || result.indexOf("ERR:") === 0) {
          callback(new Error(result || "AE catalog 返回空值"));
          return;
        }
        try {
          callback(null, JSON.parse(result));
        } catch (error) {
          callback(error);
        }
      });
    });
  }

  function isActiveEffect(effect) {
    if (effect.matchName.indexOf("Pseudo/") === 0) return false;
    if (/Obsolete|过时/i.test(effect.category)) return false;
    return true;
  }

  function rebuildItems() {
    var installed = {};
    var i;
    for (i = 0; i < state.catalog.length; i++) {
      installed[state.catalog[i].matchName] = state.catalog[i];
    }

    var items = [];
    if (state.showAll) {
      for (i = 0; i < state.catalog.length; i++) {
        if (isActiveEffect(state.catalog[i])) {
          items.push(
            AEV_ViewModel.buildItem(state.catalog[i], state.names, state.previews)
          );
        }
      }
    } else {
      var previewKeys = Object.keys(state.previews);
      for (i = 0; i < previewKeys.length; i++) {
        var matchName = previewKeys[i];
        var effect = installed[matchName];
        if (!effect) {
          var nameRecord = state.names[matchName] || {};
          effect = {
            matchName: matchName,
            displayName: nameRecord.nameEn || matchName,
            category: ""
          };
        }
        var item = AEV_ViewModel.buildItem(effect, state.names, state.previews);
        item.installed = !!installed[matchName];
        items.push(item);
      }
    }
    state.items = items;
  }

  function createCard(item) {
    var card = document.createElement("button");
    card.type = "button";
    card.className = "effect-card";
    card.title = item.matchName;
    card.setAttribute("aria-label", AEV_ViewModel.resolveName(item, state.lang));

    var thumb = document.createElement("div");
    thumb.className = "thumb";
    if (item.hasPreview) {
      var preview = item.preview;
      var sheet = state.manifest.sheets[preview.sheet];
      thumb.style.backgroundImage = 'url("data/' + sheet.src + '")';
      thumb.style.backgroundSize =
        state.manifest.width + "px " + state.manifest.height + "px";
      thumb.style.backgroundPosition = "-" + preview.x + "px -" + preview.y + "px";
    } else {
      var placeholder = document.createElement("span");
      placeholder.className = "thumb-placeholder";
      placeholder.textContent = state.lang === "zh" ? "无预览" : "No preview";
      thumb.appendChild(placeholder);
    }

    var copy = document.createElement("div");
    copy.className = "card-copy";

    var name = document.createElement("span");
    name.className = "card-name";
    name.textContent = AEV_ViewModel.resolveName(item, state.lang);

    var meta = document.createElement("span");
    meta.className = "card-meta";
    var dot = document.createElement("span");
    dot.className = "plugin-dot" + (item.installed === false ? " missing" : "");
    var category = document.createElement("span");
    category.className = "card-category";
    var categoryText = AEV_ViewModel.resolveCategory(item, state.lang);
    if (item.installed === false) {
      categoryText = state.lang === "zh" ? "当前机器未安装" : "Not installed";
    }
    category.textContent =
      categoryText.indexOf(item.plugin) === 0
        ? categoryText
        : item.plugin + " · " + categoryText;

    meta.appendChild(dot);
    meta.appendChild(category);
    copy.appendChild(name);
    copy.appendChild(meta);
    card.appendChild(thumb);
    card.appendChild(copy);
    return card;
  }

  function render() {
    var visible = AEV_ViewModel.filterItems(state.items, {
      lang: state.lang,
      query: state.query,
      plugin: state.plugin
    });
    var grid = byId("previewGrid");
    var empty = byId("emptyState");
    var fragment = document.createDocumentFragment();

    grid.textContent = "";
    for (var i = 0; i < visible.length; i++) {
      fragment.appendChild(createCard(visible[i]));
    }
    grid.appendChild(fragment);
    empty.hidden = visible.length !== 0;
    byId("selectionStats").textContent =
      (state.lang === "zh" ? "显示 " : "Showing ") + visible.length;
  }

  function updateHeader() {
    var previewCount = Object.keys(state.previews).length;
    byId("libraryStats").textContent =
      (state.lang === "zh" ? "内置预览 " : "Previews ") +
      previewCount +
      (state.lang === "zh" ? " · 本机效果 " : " · Installed ") +
      state.catalog.length;
  }

  function setLanguage(lang) {
    state.lang = lang;
    byId("langZh").className = "segment" + (lang === "zh" ? " active" : "");
    byId("langEn").className = "segment" + (lang === "en" ? " active" : "");
    byId("searchInput").placeholder =
      lang === "zh" ? "搜索效果或分类" : "Search effects or categories";
    updateHeader();
    render();
  }

  function setStatus(text, isError) {
    var status = byId("statusText");
    status.textContent = text;
    status.className = isError ? "error" : "";
  }

  function refresh() {
    var button = byId("btnRefresh");
    button.disabled = true;
    setStatus(state.lang === "zh" ? "正在扫描 AE 效果…" : "Scanning AE effects…", false);

    loadJson("data/names.json", function (namesError, namesData) {
      if (namesError) {
        finish(namesError);
        return;
      }
      var names = {};
      for (var i = 0; i < namesData.items.length; i++) {
        names[namesData.items[i].matchName] = namesData.items[i];
      }
      state.names = names;

      loadJson("data/manifest.json", function (manifestError, manifestData) {
        if (manifestError) {
          finish(manifestError);
          return;
        }
        state.manifest = manifestData;
        state.previews = {};
        for (var p = 0; p < manifestData.items.length; p++) {
          var preview = manifestData.items[p];
          var sheet = manifestData.sheets[preview.sheet];
          preview.src = sheet.src;
          state.previews[preview.matchName] = preview;
        }

        getCatalog(function (catalogError, catalogData) {
          if (catalogError) {
            finish(catalogError);
            return;
          }
          state.catalog = catalogData.effects;
          rebuildItems();
          updateHeader();
          render();
          setStatus(
            state.lang === "zh" ? "效果库已就绪" : "Library ready",
            false
          );
          button.disabled = false;
        });
      });
    });

    function finish(error) {
      setStatus(String(error.message || error), true);
      button.disabled = false;
    }
  }

  function boot() {
    byId("langZh").addEventListener("click", function () { setLanguage("zh"); });
    byId("langEn").addEventListener("click", function () { setLanguage("en"); });
    byId("searchInput").addEventListener("input", function () {
      state.query = this.value;
      render();
    });
    byId("pluginFilter").addEventListener("change", function () {
      state.plugin = this.value;
      render();
    });
    byId("showAll").addEventListener("change", function () {
      state.showAll = this.checked;
      rebuildItems();
      render();
    });
    byId("btnRefresh").addEventListener("click", refresh);
    refresh();
  }

  document.addEventListener("DOMContentLoaded", boot);

  return {
    refresh: refresh,
    setLanguage: setLanguage
  };
})();
