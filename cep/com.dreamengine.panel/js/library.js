var AEV_Library = (function () {
  var BATCH_LIMIT = 64;
  var state = {
    lang: "zh",
    query: "",
    plugin: "内置",
    showAll: false,
    names: {},
    previews: {},
    manifest: null,
    catalog: [],
    items: [],
    extensionPath: "",
    entries: [],
    generating: false
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
      state.extensionPath = extensionPath;
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
      if (preview.frameSrc) {
        var frameCount = preview.frames || 1;
        var frameIndex = 0;
        var playTimer = null;
        var showFrame = function (index) {
          thumb.style.backgroundImage =
            'url("' + framePath(preview.frameSrc, index) + '")';
        };
        var stop = function () {
          if (!playTimer) return;
          clearInterval(playTimer);
          playTimer = null;
        };
        var play = function () {
          if (playTimer || frameCount < 2) return;
          playTimer = setInterval(function () {
            frameIndex = (frameIndex + 1) % frameCount;
            showFrame(frameIndex);
          }, 83);
        };
        thumb.style.backgroundSize = "100% 100%";
        showFrame(0);
        card.addEventListener("mouseenter", play);
        card.addEventListener("mouseleave", stop);
      } else {
        thumb.style.backgroundImage = 'url("data/' + preview.src + '")';
        thumb.style.backgroundSize =
          state.manifest.width + "px " + state.manifest.height + "px";
        thumb.style.backgroundPosition = "-" + preview.x + "px -" + preview.y + "px";
      }
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

  function refresh(done) {
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
        state.entries = [];
        var columns = manifestData.columns || 8;
        var cellSize = manifestData.cellSize || 256;
        for (var p = 0; p < manifestData.items.length; p++) {
          var preview = manifestData.items[p];
          if (!preview.src) {
            var sheet = manifestData.sheets[preview.sheet] || {};
            preview.src = sheet.src || "";
          }
          state.previews[preview.matchName] = preview;
          state.entries.push({
            matchName: preview.matchName,
            sheet: preview.sheet || 0,
            cell:
              Math.floor((preview.y || 0) / cellSize) * columns +
              Math.floor((preview.x || 0) / cellSize),
            frames: preview.frames || 1,
            frameTemplate: preview.frameSrc || ""
          });
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
          if (done) done(null);
        });
      });
    });

    function finish(error) {
      setStatus(String(error.message || error), true);
      button.disabled = false;
      if (done) done(error);
    }
  }

  /* ---------- 生成队列：与 engine/*.jsx 的唯一交互面 ---------- */

  function parseEngineResult(text) {
    if (!text) return { status: "error", reason: "empty_result" };
    if (text.indexOf("ERR") === 0) return { status: "error", reason: text };
    try {
      return JSON.parse(text);
    } catch (error) {
      return { status: "error", reason: "bad_json" };
    }
  }

  function engine(expr, callback) {
    Bridge.runEngine(state.extensionPath, expr, callback);
  }

  function zeroPad(value, width) {
    var text = String(value);
    while (text.length < width) text = "0" + text;
    return text;
  }

  /** 帧序列模板 "thumbs/batch_000_%04d.png" -> "data/thumbs/batch_000_0001.png" */
  function framePath(template, index) {
    return "data/" + String(template).replace("%04d", zeroPad(index, 4));
  }

  function entriesToTsv(entries) {
    var lines = [];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      lines.push(
        [
          entry.matchName,
          entry.sheet,
          entry.cell,
          entry.frames,
          entry.frameTemplate || ""
        ].join("\t")
      );
    }
    return lines.join("\n");
  }

  function writeManifest(callback) {
    var tsv = entriesToTsv(state.entries);
    engine(
      "AEV_PreviewGen.writeManifest(" +
        JSON.stringify(tsv) +
        "," +
        JSON.stringify(state.extensionPath) +
        ")",
      function (result) {
        callback(parseEngineResult(result));
      }
    );
  }

  function finishGenerate(message, isError) {
    state.generating = false;
    byId("btnGenerate").disabled = false;
    byId("btnRetry").hidden = !isError;
    refresh(function () {
      setStatus(message, !!isError);
    });
  }

  /** 把「已安装但没有预览」的效果排进队列并逐批渲染，直到队列为空 */
  function generateMissing() {
    if (state.generating) return;
    if (!state.extensionPath) {
      setStatus("扩展路径未知，请先点「重新扫描」", true);
      return;
    }

    var existingNames = [];
    for (var key in state.previews) {
      if (state.previews.hasOwnProperty(key)) existingNames.push(key);
    }

    var queueNames = [];
    // 一次点击最多补一张网（64 格）。宁可让用户多点几次，也不要把 AE 锁住几分钟。
    var ceiling = BATCH_LIMIT;
    for (var i = 0; i < state.catalog.length && queueNames.length < ceiling; i++) {
      var effect = state.catalog[i];
      if (!isActiveEffect(effect)) continue;
      if (state.previews[effect.matchName]) continue;
      if (AEV_ViewModel.isNoPreview(effect.category)) continue;
      queueNames.push(effect.matchName);
    }

    if (queueNames.length === 0) {
      setStatus("当前没有需要生成的效果", false);
      return;
    }

    state.generating = true;
    byId("btnGenerate").disabled = true;
    setStatus("正在排队 " + queueNames.length + " 个效果…", false);

    var cursor = state.entries.length;
    var totalAdded = 0;
    var guard = 0;

    engine(
      "AEV_Queue.markCached(" + JSON.stringify(existingNames) + ")",
      function () {
        engine(
          "AEV_Queue.ensure(" + JSON.stringify(queueNames) + ")",
          function () {
            pump();
          }
        );
      }
    );

    function pump() {
      guard++;
      if (guard > 64) {
        finishGenerate("已中止：批次过多（防死循环）", true);
        return;
      }

      var sheetIndex = Math.floor(cursor / BATCH_LIMIT);
      var cellStart = cursor % BATCH_LIMIT;
      var limit = BATCH_LIMIT - cellStart;

      setStatus(
        "正在生成：" + totalAdded + " 个已完成，本批 " + limit + " 个…",
        false
      );

      var expr =
        "AEV_Queue.drain(" +
        sheetIndex +
        ',{limit:' +
        limit +
        ',outputRoot:"extension",extensionPath:' +
        JSON.stringify(state.extensionPath) +
        "})";

      engine(expr, function (result) {
        var data = parseEngineResult(result);
        if (data.status === "idle") {
          finishGenerate("预览生成完成，新增 " + totalAdded + " 个", false);
          return;
        }
        if (data.status !== "ok") {
          finishGenerate("生成失败：" + (data.reason || data.batch || "未知原因"), true);
          return;
        }

        var names = data.names || [];
        if (names.length === 0) {
          finishGenerate("生成中止：批次为空", true);
          return;
        }

        for (var n = 0; n < names.length; n++) {
          state.entries.push({
            matchName: names[n],
            sheet: sheetIndex,
            cell: cellStart + n,
            frames: 6,
            frameTemplate:
              "thumbs/batch_" + zeroPad(sheetIndex, 3) + "_%04d.png"
          });
        }
        cursor += names.length;
        totalAdded += names.length;

        writeManifest(function (written) {
          if (written.status !== "ok") {
            finishGenerate("索引写入失败：" + (written.reason || ""), true);
            return;
          }
          pump();
        });
      });
    }
  }

  function retryFailed() {
    if (state.generating || !state.extensionPath) return;
    engine("AEV_Queue.retryFailed()", function (result) {
      var data = parseEngineResult(result);
      setStatus("已重新排队 " + (data.reset || 0) + " 个", false);
    });
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
    byId("btnGenerate").addEventListener("click", generateMissing);
    byId("btnRetry").addEventListener("click", retryFailed);
    refresh();
  }

  document.addEventListener("DOMContentLoaded", boot);

  return {
    refresh: refresh,
    setLanguage: setLanguage
  };
})();
