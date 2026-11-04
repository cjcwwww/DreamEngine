var AEV_Library = (function () {
  var BATCH_LIMIT = 64;
  var MAX_DEGRADE = 12;
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
    generating: false,
    // 有图但配方/素材已变、需要重渲的条目（来自 AEV_PreviewGen.staleList）
    stale: {},
    // 排序方式：name = 按名称首字母，category = 按 AE 分类
    sortMode: "name",
    // 左侧栏选中的分类键（空 = 全部）
    category: "",
    // AE 菜单里的分类顺序（从 catalog 首次出现顺序推导）
    categoryOrder: [],
    // 预览格尺寸（px）。面板比例不同、卡片实际渲染大小不同时可手动调。
    thumbSize: 132
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

  // 排除规则统一放在 viewmodel，面板与离线清单生成共用同一份判断
  function isActiveEffect(effect) {
    return !AEV_ViewModel.isExcludable(effect);
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
            AEV_ViewModel.buildItem(state.catalog[i], state.names, state.previews, state.stale)
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
        var item = AEV_ViewModel.buildItem(effect, state.names, state.previews, state.stale);
        item.installed = !!installed[matchName];
        items.push(item);
      }
    }
    state.items = items;
  }

  function createCard(item) {
    var card = document.createElement("button");
    card.type = "button";
    card.className = "effect-card" + (item.stale ? " stale" : "");
    card.title = item.matchName;
    card.setAttribute("aria-label", AEV_ViewModel.resolveName(item, state.lang));

    var thumb = document.createElement("div");
    thumb.className = "thumb";
    if (item.hasPreview) {
      var preview = item.preview;
      // 切片参数用百分比而不是固定像素——缩略框渲染多大，
      // 一格都精确等于一个框，不会把相邻格子的画面带进来。
      var slice = AEV_ViewModel.spriteSlice(preview, state.manifest);
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
          // 动画从第 0 帧开始：那一帧是「效果尚未完全施加」的状态，
          // 正好把效果的变化过程演出来。
          frameIndex = 0;
          showFrame(frameIndex);
          playTimer = setInterval(function () {
            frameIndex = (frameIndex + 1) % frameCount;
            showFrame(frameIndex);
          }, 83);
        };
        thumb.style.backgroundSize = slice.size;
        thumb.style.backgroundPosition = slice.position;
        // 静止时显示最后一帧：关键帧动画从 0 渐变到满效果，
        // 停在第 0 帧等于「完全没上效果」，网格里会一片素模。
        showFrame(frameCount - 1);
        card.addEventListener("mouseenter", play);
        card.addEventListener("mouseleave", stop);
      } else {
        thumb.style.backgroundImage = 'url("data/' + preview.src + '")';
        thumb.style.backgroundSize = slice.size;
        thumb.style.backgroundPosition = slice.position;
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
    // 分类筛选
    if (state.category) {
      var narrowed = [];
      for (var c = 0; c < visible.length; c++) {
        if (AEV_ViewModel.categoryKey(visible[c]) === state.category) {
          narrowed.push(visible[c]);
        }
      }
      visible = narrowed;
    }
    // 排序（默认按名称首字母）
    visible = AEV_ViewModel.sortItems(visible, state.sortMode, state.lang);

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
    renderSidebar(visible);
  }

  /**
   * 左侧分类栏。
   * 分类顺序取自 AE 菜单（catalog 里首次出现的顺序），
   * 计数取当前插件筛选后的结果，所以切来源时数字会跟着变。
   */
  function renderSidebar(visible) {
    var list = byId("categoryList");
    if (!list) return;
    var stats = AEV_ViewModel.categoryCounts(visible, state.lang);
    var order = state.categoryOrder.length
      ? state.categoryOrder
      : Object.keys(stats.counts);

    list.textContent = "";
    var total = visible.length;

    list.appendChild(
      categoryButton("", state.lang === "zh" ? "全部分类" : "All categories", total, !state.category)
    );

    for (var i = 0; i < order.length; i++) {
      var key = order[i];
      var count = stats.counts[key];
      if (!count) continue;
      var label = stats.labels[key] || key;
      list.appendChild(categoryButton(key, label, count, state.category === key));
    }

    // catalog 里没有但确实存在的分类（理论上不会出现）兜底追加
    var extra = [];
    for (var name in stats.counts) {
      if (order.indexOf(name) < 0) extra.push(name);
    }
    for (var e = 0; e < extra.length; e++) {
      list.appendChild(
        categoryButton(extra[e], stats.labels[extra[e]] || extra[e], stats.counts[extra[e]], state.category === extra[e])
      );
    }
  }

  function categoryButton(key, label, count, active) {
    var li = document.createElement("li");
    var button = document.createElement("button");
    button.type = "button";
    button.className = "category-item" + (active ? " active" : "");
    button.setAttribute("data-key", key);

    var text = document.createElement("span");
    text.className = "category-label";
    text.textContent = label;

    var badge = document.createElement("span");
    badge.className = "category-count";
    badge.textContent = String(count);

    button.appendChild(text);
    button.appendChild(badge);
    button.addEventListener("click", function () {
      state.category = key;
      render();
    });
    li.appendChild(button);
    return li;
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

  /**
   * 预览格尺寸。
   *
   * 为什么需要手动调：格子里的画面是按「整网等分」切出来的，
   * 一格永远精确等于一个预览框（不会串格）。但面板比例变化时，
   * 1fr 会把卡片拉宽到不同的实际像素宽度——同一张预览在宽面板上
   * 显得比窄面板上小，细节看不清。滑块让用户自己定一个合适的尺寸。
   *
   * 滑块范围固定 48–180px（与 index.html 一致），**不随窗口比例变化**。
   *
   * 关键约束：**滑块标的值必须等于实际格子宽度**。
   * 设一个放不下的值（比如面板可用 150px 却要 180px 的格子），
   * grid 会把格子压到 150px，于是滑块标 180 而实际是 150 —— 对不上。
   * 所以按可用宽度收敛实际尺寸，并把收敛后的值写回滑块：
   *   · 面板变窄时自动把尺寸收敛到能放下的最大值，滑块同步回弹
   *   · 面板变宽时恢复用户原本选的尺寸
   */
  var THUMB_MIN = 48;
  var THUMB_MAX = 180;
  var THUMB_STEP = 2;
  var THUMB_COMPACT = 80;
  var thumbPreferred = 132;

  /** 侧栏 + 间距 + 主区内边距之外，预览区实际能用的宽度 */
  function availableThumbWidth() {
    var main = document.querySelector("main");
    if (!main) return THUMB_MAX;
    var style = window.getComputedStyle(main);
    var padding = parseFloat(style.paddingLeft) || 0;
    var paddingRight = parseFloat(style.paddingRight) || 0;
    var width = main.clientWidth - padding - paddingRight;
    if (!width || width <= 0) return THUMB_MAX;
    return Math.floor(width);
  }

  function setThumbSize(size) {
    var requested = Number(size);
    if (!isNaN(requested) && requested > 0) {
      thumbPreferred = Math.max(THUMB_MIN, Math.min(THUMB_MAX, requested));
    }
    var limit = Math.min(THUMB_MAX, availableThumbWidth());
    if (limit < THUMB_MIN) limit = THUMB_MIN;

    var value = Math.min(thumbPreferred, limit);
    value = Math.max(THUMB_MIN, value);
    // 对齐到滑块的 step 刻度（向下取整，保证不超过可用宽度），
    // 否则 range 会自动吸附 slider.value，标称与实际又会差 1px。
    value = THUMB_MIN + Math.floor((value - THUMB_MIN) / THUMB_STEP) * THUMB_STEP;

    state.thumbSize = value;
    document.documentElement.style.setProperty("--thumb-size", value + "px");

    var grid = byId("previewGrid");
    if (grid) grid.classList.toggle("compact", value < THUMB_COMPACT);

    var slider = byId("thumbSize");
    if (slider) {
      // 范围恒定 48–180：面板比例只影响「能否放到该尺寸」，不改变滑块刻度
      slider.min = String(THUMB_MIN);
      slider.max = String(THUMB_MAX);
      slider.step = String(THUMB_STEP);
      // 收敛后把实际生效值写回，避免「标 180、实际 150」的错位
      slider.value = String(value);
    }
    var output = byId("thumbSizeValue");
    if (output) output.textContent = String(value);
  }

  function setSortMode(mode) {
    state.sortMode = mode;
    byId("sortName").className = "segment" + (mode === "name" ? " active" : "");
    byId("sortCategory").className = "segment" + (mode === "category" ? " active" : "");
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
        // sheets 数组的顺序不等于它的 index 字段（打包器按落盘顺序追加），
        // 所以必须按 index 建索引，不能直接用 sheets[preview.sheet]。
        var sheetByIndex = {};
        var sheetList = manifestData.sheets || [];
        for (var sh = 0; sh < sheetList.length; sh++) {
          sheetByIndex[sheetList[sh].index] = sheetList[sh];
        }
        for (var p = 0; p < manifestData.items.length; p++) {
          var preview = manifestData.items[p];
          if (!preview.src) {
            var sheet = sheetByIndex[preview.sheet] || {};
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
          // 分类顺序 = AE 菜单里的顺序（catalog 里各类首次出现的次序）
          state.categoryOrder = AEV_ViewModel.categoryOrder(state.catalog);
          checkStale(function () {
            rebuildItems();
            updateHeader();
            render();
            var staleCount = Object.keys(state.stale).length;
            var ready = state.lang === "zh" ? "效果库已就绪" : "Library ready";
            if (staleCount > 0) {
              ready +=
                state.lang === "zh"
                  ? "（" + staleCount + " 张预览待刷新）"
                  : " (" + staleCount + " previews stale)";
            }
            setStatus(ready, false);
            button.disabled = false;
            if (done) done(null);
          });
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

  /** 向 AE 侧核对缓存指纹：哪些预览是「图还在但配方/素材变了」。
   *  没有这条，改了配方就只能靠人工删图重渲，用户永远不知道旧图已经不代表当前配方。
   */
  function checkStale(callback) {
    state.stale = {};
    if (!state.extensionPath) {
      callback();
      return;
    }
    engine(
      "AEV_PreviewGen.staleList(" + JSON.stringify(state.extensionPath) + ")",
      function (result) {
        var data = parseEngineResult(result);
        if (data && data.stale) {
          for (var i = 0; i < data.stale.length; i++) {
            state.stale[data.stale[i]] = true;
          }
        }
        callback();
      }
    );
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
    var staleNames = [];
    for (var key in state.previews) {
      if (!state.previews.hasOwnProperty(key)) continue;
      if (state.stale[key]) staleNames.push(key);
      else existingNames.push(key);
    }

    var candidates = [];
    for (var i = 0; i < state.catalog.length; i++) {
      var effect = state.catalog[i];
      if (!isActiveEffect(effect)) continue;
      // 已过期的不算「已有预览」：图留着继续显示，但要重新渲一遍
      if (state.previews[effect.matchName] && !state.stale[effect.matchName]) continue;
      if (AEV_ViewModel.isNoPreview(effect.category)) continue;
      if (AEV_ViewModel.isPoorPreviewTarget(effect)) continue;
      candidates.push(effect);
    }
    // 先渲"看得出差异"的常用分类，并让首批覆盖多个分类；
    // 按 catalog 原始顺序取会先撞上 3D 跟踪这类无效效果。
    candidates = AEV_ViewModel.interleaveByCategory(candidates);

    var queueNames = [];
    // 一次点击最多补一张网（64 格）。宁可让用户多点几次，也不要把 AE 锁住几分钟。
    var ceiling = BATCH_LIMIT;
    for (var c = 0; c < candidates.length && queueNames.length < ceiling; c++) {
      queueNames.push(candidates[c].matchName);
    }

    if (queueNames.length === 0) {
      setStatus("当前没有需要生成的效果", false);
      return;
    }

    state.generating = true;
    byId("btnGenerate").disabled = true;
    var staleCount = staleNames.length;
    setStatus(
      staleCount > 0
        ? "正在排队 " + queueNames.length + " 个效果（其中 " + staleCount + " 个是刷新过期预览）…"
        : "正在排队 " + queueNames.length + " 个效果…",
      false
    );

    var totalAdded = 0;
    var guard = 0;
    var degraded = false;
    var failedNames = [];
    var nextSheet = 0;
    for (var e = 0; e < state.entries.length; e++) {
      if (state.entries[e].sheet >= nextSheet) nextSheet = state.entries[e].sheet + 1;
    }

    engine(
      "AEV_Queue.markCached(" + JSON.stringify(existingNames) + ")",
      function () {
        engine("AEV_Queue.reopen(" + JSON.stringify(staleNames) + ")", function () {
          engine("AEV_Queue.ensure(" + JSON.stringify(queueNames) + ")", function () {
            pump();
          });
        });
      }
    );

    function pump() {
      guard++;
      if (guard > 64) {
        finishGenerate("已中止：批次过多（防死循环）", true);
        return;
      }

      // 每批单独成一张网。已有预览是 v1 的单文件整图（batch_000.png），
      // 新生成的是帧序列（batch_001_%04d.png），两种图不能混在同一张 sheet 里，
      // 否则取图路径会打架；宁可浪费旧网的空位，也不做格式混装。
      var sheetIndex = nextSheet++;
      var limit = BATCH_LIMIT;

      setStatus(
        "正在生成：" + totalAdded + " 个已完成，本批最多 " + limit + " 个…",
        false
      );

      var expr =
        "AEV_Queue.drain(" +
        sheetIndex +
        ',{limit:' +
        limit +
        ',cellOffset:0,outputRoot:"extension",extensionPath:' +
        JSON.stringify(state.extensionPath) +
        "})";

      engine(expr, function (result) {
        var data = parseEngineResult(result);
        if (data.status === "idle") {
          finishGenerate("预览生成完成，新增 " + totalAdded + " 个", false);
          return;
        }
        if (data.status !== "ok") {
          var retryNames = data.names || [];
          // 整网渲染是一损俱损：只要有一个效果自身报错，整批 64 条全部失败，
          // 而错误信息里不含条目名。此时降级为逐条渲染，把能出的挑出来。
          if (!degraded && retryNames.length > 1) {
            degraded = true;
            setStatus(
              "整批渲染失败（" +
                (data.reason || "未知原因") +
                "），改为逐条重试以隔离问题条目…",
              false
            );
            retryEach(retryNames, 0);
            return;
          }
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
            cell: n,
            frames: 6,
            frameTemplate:
              "thumbs/batch_" + zeroPad(sheetIndex, 3) + "_%04d.png"
          });
        }
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

    /** 整网失败后的逐条重试：能渲的留下，坏的跳过（队列侧会把 attempts 用尽后标 failed）。
     *  每条单独占一张网，避免互相覆盖；只有整批失败时才会走到这里。
     *  单次最多试 MAX_DEGRADE 条——否则一次点击要等 64 次单渲，用户会以为卡死。
     */
    function retryEach(names, index) {
      if (index >= names.length || index >= MAX_DEGRADE) {
        var remaining = names.length - index;
        var tail =
          failedNames.length > 0
            ? "；失败 " + failedNames.length + " 个（" + failedNames.slice(0, 3).join("、") +
              (failedNames.length > 3 ? " 等" : "") + "），可点「重试失败」"
            : "";
        var rest = remaining > 0 ? "，另有 " + remaining + " 个留待下次" : "";
        finishGenerate(
          "生成完成（部分失败）：新增 " + totalAdded + " 个" + rest + tail,
          failedNames.length > 0
        );
        return;
      }

      var sheetIndex = nextSheet++;
      setStatus(
        "逐条重试 " + (index + 1) + "/" + names.length + "…",
        false
      );

      var expr =
        "AEV_Queue.drain(" +
        sheetIndex +
        ',{limit:1,cellOffset:0,outputRoot:"extension",extensionPath:' +
        JSON.stringify(state.extensionPath) +
        "})";

      engine(expr, function (result) {
        var data = parseEngineResult(result);
        var got = (data && data.names) || [];
        if (data && data.status === "ok" && got.length === 1) {
          state.entries.push({
            matchName: got[0],
            sheet: sheetIndex,
            cell: 0,
            frames: 6,
            frameTemplate: "thumbs/batch_" + zeroPad(sheetIndex, 3) + "_%04d.png"
          });
          totalAdded += 1;
          writeManifest(function () {
            retryEach(names, index + 1);
          });
          return;
        }
        failedNames.push(names[index]);
        retryEach(names, index + 1);
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
    byId("sortName").addEventListener("click", function () { setSortMode("name"); });
    byId("sortCategory").addEventListener("click", function () { setSortMode("category"); });
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
    byId("thumbSize").addEventListener("input", function () {
      setThumbSize(this.value);
    });
    setThumbSize(byId("thumbSize").value);

    /* 面板被拖宽或拖窄时重新收敛实际尺寸（滑块范围始终 48–180，不变）。
       否则会出现「滑块标 180、实际只有 150」的错位。 */
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        setThumbSize(thumbPreferred);
      }, 120);
    });

    refresh();
  }

  document.addEventListener("DOMContentLoaded", boot);

  return {
    refresh: refresh,
    setLanguage: setLanguage
  };
})();
