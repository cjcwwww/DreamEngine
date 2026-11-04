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
    // 插件 L2 预览：被拉黑的效果与已生成数量（独立索引，不进 entries）
    pluginBlacklist: {},
    pluginPreviewCount: 0,
    // 各来源（内置 / BCC / Sapphire…）已有多少张预览
    pluginCounts: {},
    // 预设库（M3）：用户自建库里的 .ffx 与搜索词
    presets: [],
    presetFolder: "",
    presetQuery: "",
    // 排序方式：name = 按名称首字母，category = 按 AE 分类
    sortMode: "name",
    // 左侧栏选中的分类键（空 = 全部）
    category: "",
    // AE 菜单里的分类顺序（从 catalog 首次出现顺序推导）
    categoryOrder: [],
    // 预览格尺寸（px）。面板比例不同、卡片实际渲染大小不同时可手动调。
    thumbSize: 132,
    // 当前主视图：effects = 效果预览，presets = 预设预览
    view: "effects",
    // 已知「帧内容完全相同」的预览：这些是静态效果，不该轮播（会闪）
    staticPreviews: {}
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

  /** 可选索引：插件 L2 索引/黑名单在首次安装时根本不存在，不能中断 refresh */
  function loadOptionalJson(path, callback) {
    loadJson(path, function (error, data) {
      callback(error ? null : data);
    });
  }

  /**
   * 取本机效果清单。
   * 走 runEngine 而不是单独 evalFile：单独 eval 会把 catalog 模块整个重置，
   * 模块里的会话缓存（枚举 1371 条的结果）就白丢了。
   * force=true 表示「重新扫描」——用户装了新插件后要能看到。
   */
  function getCatalog(callback, force) {
    Bridge.getExtensionPath(function (extensionPath) {
      if (!extensionPath) {
        callback(new Error("无法取得扩展目录"));
        return;
      }
      state.extensionPath = extensionPath;
      Bridge.runEngine(
        extensionPath,
        "AEV_Catalog.getCatalogJson(" + (force ? "true" : "false") + ")",
        function (result) {
          if (!result || result.indexOf("ERR:") === 0) {
            callback(new Error(result || "AE catalog 返回空值"));
            return;
          }
          try {
            callback(null, JSON.parse(result));
          } catch (error) {
            callback(error);
          }
        }
      );
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
    var counts = {};
    for (i = 0; i < items.length; i++) {
      if (!items[i].hasPreview) continue;
      counts[items[i].plugin] = (counts[items[i].plugin] || 0) + 1;
    }
    state.pluginCounts = counts;
    state.items = items;
    updatePluginCounts();
  }

  /**
   * 来源下拉里标出每个插件包已有多少张预览。
   * 插件预览是逐条离线渲出来的，用户得一眼看到「哪个包已经有图」，
   * 否则切到 BCC 只看到一片「待离线生成」还以为功能坏了。
   */
  function updatePluginCounts() {
    var select = byId("pluginFilter");
    if (!select) return;
    var options = select.getElementsByTagName("option");
    for (var i = 0; i < options.length; i++) {
      var option = options[i];
      var base = option.getAttribute("data-label");
      if (!base) {
        base = option.textContent;
        option.setAttribute("data-label", base);
      }
      if (option.value === "全部") {
        option.textContent = base;
        continue;
      }
      var n = state.pluginCounts[option.value] || 0;
      option.textContent = n > 0 ? base + " · " + n : base;
    }
  }

  function createCard(item) {
    var card = document.createElement("button");
    card.type = "button";
    card.className = "effect-card" + (item.stale ? " stale" : "");
    card.title = item.matchName + "（双击添加到 AE 选中图层）";
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
        // 静态预览（各帧内容完全相同）不播：播放它只会让浏览器反复
        // 重解码同一张图 —— 视觉上是「闪几下」，而且毫无信息量。
        // 判定来自 data/animated.json（由 tools/mark_animated.mjs 生成）。
        var isAnimated = state.staticPreviews[item.matchName] !== true &&
          frameCount > 1;
        var showFrame = function (index) {
          thumb.style.backgroundImage =
            'url("' + framePath(preview.frameSrc, index) + '")';
        };
        var stop = function () {
          if (!playTimer) return;
          clearInterval(playTimer);
          playTimer = null;
        };
        var startPlaying = function () {
          if (playTimer) return;
          // 动画从第 0 帧开始：那一帧是「效果尚未完全施加」的状态，
          // 正好把效果的变化过程演出来。
          frameIndex = 0;
          showFrame(frameIndex);
          playTimer = setInterval(function () {
            frameIndex = (frameIndex + 1) % frameCount;
            showFrame(frameIndex);
          }, 83);
        };
        var play = function () {
          if (!isAnimated || playTimer) return;
          // 帧没预加载完就先不播：直接切 background-image 会让浏览器
          // 撤掉旧背景、等新图解码，中间那一瞬只剩容器底色 —— 看上去
          // 就是「闪」。等预加载完成再开播就没有空档了。
          if (preview.__ready) {
            startPlaying();
            return;
          }
          var urls = [];
          for (var f = 0; f < frameCount; f++) {
            urls.push(framePath(preview.frameSrc, f));
          }
          preloadFrames(urls, function () {
            preview.__ready = true;
            if (card.matches(":hover")) startPlaying();
          });
        };
        thumb.style.backgroundSize = slice.size;
        thumb.style.backgroundPosition = slice.position;
        // 静止时显示最后一帧：关键帧动画从 0 渐变到满效果，
        // 停在第 0 帧等于「完全没上效果」，网格里会一片素模。
        showFrame(frameCount - 1);
        if (isAnimated) {
          card.addEventListener("mouseenter", play);
          card.addEventListener("mouseleave", stop);
        }
      } else {
        thumb.style.backgroundImage = 'url("data/' + preview.src + '")';
        thumb.style.backgroundSize = slice.size;
        thumb.style.backgroundPosition = slice.position;
      }
    } else {
      var placeholder = document.createElement("span");
      placeholder.className = "thumb-placeholder";
      var skipReason = state.pluginBlacklist[item.matchName];
      if (skipReason) {
        placeholder.textContent = state.lang === "zh" ? "已跳过" : "Skipped";
        card.title += " · " + (state.lang === "zh" ? "已跳过：" : "skipped: ") + skipReason;
      } else if (item.plugin !== "内置") {
        placeholder.textContent = state.lang === "zh" ? "待离线生成" : "Offline render";
      } else {
        placeholder.textContent = state.lang === "zh" ? "无预览" : "No preview";
      }
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
    // 双击 = 把这个效果加到 AE 当前选中的图层。
    // 单击不做任何事：效果墙是浏览用的，误加效果会污染用户的工程。
    card.addEventListener("dblclick", function () {
      applyToSelectedLayer(item);
    });
    return card;
  }

  /**
   * 把效果加到 AE 里当前选中的图层。
   *
   * 走引擎侧的 AEV_Apply.addToSelectedJson：那边负责找合成与选中层、
   * 挂效果、内置效果套显式配方（插件效果一个参数都不碰）。
   */
  function applyToSelectedLayer(item) {
    if (!state.extensionPath) {
      setStatus(state.lang === "zh" ? "扩展路径未知，请先点「重新扫描」" : "Unknown extension path", true);
      return;
    }
    var label = AEV_ViewModel.resolveName(item, state.lang);
    engine(
      "AEV_Apply.addToSelectedJson(" + JSON.stringify(item.matchName) + ")",
      function (result) {
        var data = parseEngineResult(result);
        if (!data || data.status !== "ok") {
          var reason = (data && data.reason) || "";
          var message;
          if (reason === "no_layer") {
            message = state.lang === "zh"
              ? "请先在 AE 里选中一个图层，再双击效果"
              : "Select a layer in AE first, then double-click an effect";
          } else if (reason === "no_comp") {
            message = state.lang === "zh"
              ? "AE 里没有打开的合成"
              : "No composition open in AE";
          } else {
            message = state.lang === "zh"
              ? "添加失败：" + reason
              : "Failed to add: " + reason;
          }
          setStatus(message, true);
          return;
        }
        var modeNote = "";
        if (data.mode === "recipe") {
          modeNote = state.lang === "zh" ? "（已套用预览参数）" : " (with preview parameters)";
        } else if (data.mode === "plugin-default") {
          modeNote = state.lang === "zh" ? "（插件效果，用默认参数）" : " (plugin effect, default parameters)";
        }
        setStatus(
          (state.lang === "zh" ? "已把「" : "Added ") +
            label +
            (state.lang === "zh" ? "」加到图层「" : "\" to layer \"") +
            (data.layer || "?") +
            (state.lang === "zh" ? "」" : "\"") +
            modeNote,
          false
        );
      }
    );
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
    // 底栏固定单行省略，长错误详情挂到 title 上仍能看全
    status.title = text;
    status.className = isError ? "error" : "";
  }

  /**
   * 重新扫描并渲染。
   * @param {function} done    完成回调
   * @param {boolean} force    true = 强制重扫 AE 效果清单（用户点了「重新扫描」）
   */
  function refresh(done, force) {
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

        // ---- 插件 L2 预览（可选索引，首次安装时不存在） ----
        // 只合入显示用的 state.previews；绝不塞进 state.entries——
        // writeManifest 会整份重写 L1 主索引，install_l1 又会覆盖它。
        loadOptionalJson("data/plugin_manifest.json", function (pluginData) {
          loadOptionalJson("data/plugin_blacklist.json", function (blacklistData) {
            state.pluginBlacklist = {};
            var blackItems = (blacklistData && blacklistData.items) || [];
            for (var b = 0; b < blackItems.length; b++) {
              state.pluginBlacklist[blackItems[b].matchName] =
                blackItems[b].reason || "crash";
            }

            state.pluginPreviewCount = 0;
            var pluginItems = (pluginData && pluginData.items) || [];
            for (var q = 0; q < pluginItems.length; q++) {
              var pluginPreview = pluginItems[q];
              // 帧序列的第 0 帧作为 src 兜底（静止时不依赖轮播）
              if (!pluginPreview.src && pluginPreview.frameSrc) {
                pluginPreview.src = pluginPreview.frameSrc.replace("%04d", "0000");
              }
              state.previews[pluginPreview.matchName] = pluginPreview;
              state.pluginPreviewCount++;
            }

            // 静态预览名单：这些条目各帧内容完全相同，播起来只会闪。
            // 由 tools/mark_animated.mjs 生成；没有这个文件时全部当动态。
            loadOptionalJson("data/animated.json", function (animData) {
              state.staticPreviews = {};
              var animItems = (animData && animData.items) || [];
              for (var an = 0; an < animItems.length; an++) {
                if (animItems[an].animated === false) {
                  state.staticPreviews[animItems[an].matchName] = true;
                }
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
                  refreshQueue();
                  if (done) done(null);
                });
              }, force);
            });
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

  /* ---------- 帧预加载（消除首次悬停的闪烁） ---------- */

  /**
   * 预加载一串帧图，全部就绪后回调。
   *
   * 为什么必须预加载：切 background-image 到一个还没加载完的 URL 时，
   * 浏览器会先把旧背景撤掉、新的还没画上 —— 中间那一瞬只剩容器的底色，
   * 看上去就是「闪一下」。第一��悬停时 6 帧全都没缓存，于是连闪 6 下
   * （用户反馈：首次预览效果时会闪几下）。预加载后切换走的是已解码的
   * 缓存，不再有空档。
   *
   * 预加载用的 Image 与 CSS background-image 用同一个 URL，共享同一份
   * HTTP 缓存，所以两者不会各拉一份。
   */
  var frameImages = {};

  function frameImage(url) {
    var img = frameImages[url];
    if (img) return img;
    img = new Image();
    img.src = url;
    frameImages[url] = img;
    return img;
  }

  function preloadFrames(urls, callback) {
    var pending = urls.length;
    if (pending === 0) {
      callback();
      return;
    }
    var done = false;
    function settle() {
      pending--;
      if (pending <= 0 && !done) {
        done = true;
        callback();
      }
    }
    for (var i = 0; i < urls.length; i++) {
      var img = frameImage(urls[i]);
      if (img.complete) {
        settle();
      } else {
        img.addEventListener("load", settle, { once: true });
        img.addEventListener("error", settle, { once: true });
      }
    }
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
    var pluginSkipped = 0;
    for (var i = 0; i < state.catalog.length; i++) {
      var effect = state.catalog[i];
      if (!isActiveEffect(effect)) continue;
      // 插件效果绝不进整网混渲：实测 BCC / Sapphire 混渲会让 AE 进程直接消失，
      // 而面板与 AE 是同一个进程。它们走独立离线通道 run_plugin_preview.jsx。
      if (!AEV_ViewModel.isBuiltinEffect(effect)) {
        pluginSkipped++;
        continue;
      }
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
      setStatus(
        pluginSkipped > 0
          ? "内置预览已齐；" + pluginSkipped + " 个插件效果请用离线脚本生成"
          : "当前没有需要生成的效果",
        false
      );
      return;
    }

    state.generating = true;
    byId("btnGenerate").disabled = true;
    var staleCount = staleNames.length;
    var queueMessage =
      staleCount > 0
        ? "正在排队 " + queueNames.length + " 个效果（其中 " + staleCount + " 个是刷新过期预览）…"
        : "正在排队 " + queueNames.length + " 个效果…";
    if (pluginSkipped > 0) {
      queueMessage += "（另有 " + pluginSkipped + " 个插件效果需离线脚本生成）";
    }
    setStatus(queueMessage, false);

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
          refreshQueue();
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
      refreshQueue();
    });
  }

  /* ---------- 生成队列抽屉 ---------- */

  function queueStatusText(status) {
    if (state.lang === "en") {
      if (status === "pending") return "pending";
      if (status === "rendering") return "rendering";
      if (status === "failed") return "failed";
      if (status === "cached") return "done";
      return status;
    }
    if (status === "pending") return "待渲染";
    if (status === "rendering") return "渲染中";
    if (status === "failed") return "失败";
    if (status === "cached") return "已完成";
    return status;
  }

  function queueLabel(matchName) {
    var record = state.names[matchName] || {};
    if (state.lang === "zh") {
      return record.nameZh || record.nameEn || matchName;
    }
    return record.nameEn || record.nameZh || matchName;
  }

  function renderQueueList(items) {
    var list = byId("queueList");
    if (!list) return;
    list.textContent = "";
    if (!items.length) {
      var empty = document.createElement("li");
      empty.className = "queue-empty";
      empty.textContent = state.lang === "zh" ? "队列是空的" : "Queue is empty";
      list.appendChild(empty);
      return;
    }
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var li = document.createElement("li");
      li.className = "queue-item";
      li.title = item.reason || item.matchName;
      var name = document.createElement("span");
      name.className = "queue-name";
      name.textContent = queueLabel(item.matchName);
      var badge = document.createElement("span");
      badge.className = "queue-badge " + (item.status || "");
      badge.textContent = queueStatusText(item.status);
      li.appendChild(name);
      li.appendChild(badge);
      list.appendChild(li);
    }
  }

  /** 拉一次队列状态：状态栏计数 + 抽屉列表 */
  function refreshQueue() {
    if (!state.extensionPath) return;
    engine("AEV_Queue.stats()", function (result) {
      var data = parseEngineResult(result);
      var counts = byId("queueCounts");
      if (counts) {
        if (data && data.pending !== undefined) {
          // 底栏只放紧凑数字：「0 待渲染 / 0 失败」在窄面板下会被压成
          // 逐字竖排、把底栏撑高好几倍。完整含义放 title 与队列抽屉里。
          counts.textContent = data.pending + " / " + data.failed;
          var toggle = byId("btnQueue");
          if (toggle) {
            toggle.title = state.lang === "zh"
              ? "查看生成队列：待渲染 " + data.pending + " · 失败 " + data.failed
              : "Queue: " + data.pending + " pending · " + data.failed + " failed";
          }
        } else {
          counts.textContent = "—";
        }
      }
      var summary = byId("queueSummary");
      if (summary) {
        summary.textContent = data
          ? "待渲染 " + data.pending + " · 渲染中 " + data.rendering +
            " · 失败 " + data.failed + " · 共 " + data.total
          : "";
      }
      engine("AEV_Queue.listJson(80)", function (listResult) {
        var listData = parseEngineResult(listResult);
        renderQueueList((listData && listData.items) || []);
      });
    });
  }

  /* ---------- 预设库（M3） ---------- */

  /** 载入用户自建的预设库（我的文档/DreamEngine/presets） */
  function loadPresetLibrary() {
    if (!state.extensionPath) return;
    engine("AEV_Presets.libraryJson()", function (result) {
      var data = parseEngineResult(result);
      if (!data || data.status !== "ok") {
        setStatus(
          state.lang === "zh" ? "读取预设库失败" : "Failed to read preset library",
          true
        );
        return;
      }
      state.presets = data.items || [];
      state.presetFolder = data.folder || "";
      renderPresetList();
    });
  }

  /**
   * 用户自己挑 .ffx 加进库。
   * 不再扫描 AE 内置预设目录 —— 那是几百个跟本机无关的文件，
   * 用户要的是「自主添加」：挑中的文件复制进预设库，之后就能反复用。
   */
  function addPresets() {
    if (!state.extensionPath) return;
    setStatus(
      state.lang === "zh" ? "请选择要加入的预设文件…" : "Pick preset files…",
      false
    );
    engine("AEV_Presets.pickJson()", function (result) {
      var data = parseEngineResult(result);
      if (!data || data.status !== "ok") {
        setStatus(state.lang === "zh" ? "选择预设失败" : "Failed to pick presets", true);
        return;
      }
      var items = data.items || [];
      if (!items.length) {
        setStatus(state.lang === "zh" ? "没有选择文件" : "No file picked", false);
        return;
      }
      var added = 0;
      var index = 0;

      function importNext() {
        if (index >= items.length) {
          setStatus(
            state.lang === "zh" ? "已加入 " + added + " 个预设" : "Added " + added + " presets",
            false
          );
          loadPresetLibrary();
          return;
        }
        var item = items[index++];
        engine(
          "AEV_Presets.importOneJson(" + JSON.stringify(item.path) + ")",
          function (oneResult) {
            var one = parseEngineResult(oneResult);
            if (one && one.status === "ok") added++;
            importNext();
          }
        );
      }
      importNext();
    });
  }

  function renderPresetList() {
    var list = byId("presetList");
    if (!list) return;
    var query = String(state.presetQuery || "").toLowerCase();
    list.textContent = "";
    var shown = 0;
    for (var i = 0; i < state.presets.length; i++) {
      var item = state.presets[i];
      if (query && String(item.name + " " + item.category).toLowerCase().indexOf(query) === -1) {
        continue;
      }
      shown++;
      var card = document.createElement("button");
      card.type = "button";
      card.className = "preset-card";
      card.title = item.path;

      var name = document.createElement("span");
      name.className = "preset-name";
      name.textContent = item.name;

      var category = document.createElement("span");
      category.className = "preset-category";
      category.textContent = item.category || "预设";

      card.appendChild(name);
      card.appendChild(category);
      bindPresetItem(card, item);
      list.appendChild(card);
      // 一次最多渲染 400 张：几百个预设全量建 DOM 会让面板明显卡顿
      if (shown >= 400) break;
    }
    var summary = byId("presetSummary");
    if (summary) {
      if (!state.presets.length) {
        summary.textContent =
          state.lang === "zh"
            ? "库里还没有预设，点「添加预设」挑 .ffx 文件"
            : "No presets yet — use “添加预设” to pick .ffx files";
      } else {
        summary.textContent =
          "共 " + state.presets.length + " 个预设" +
          (shown < state.presets.length ? "（显示 " + shown + "）" : "") +
          " · 点一个应用到当前合成";
      }
    }
  }

  function bindPresetItem(button, item) {
    button.addEventListener("click", function () {
      applyPreset(item);
    });
  }

  /**
   * 把预设应用到 AE 当前合成。
   * 走 engine 侧的安全包装：只选目标层、比对效果数、按类型顺序重试、
   * 自动新建的图层用 remove() 删掉（依据 T0.4 实测结论）。
   */
  function applyPreset(item) {
    if (!state.extensionPath) return;
    engine("AEV_Presets.contextJson()", function (ctxResult) {
      var ctx = parseEngineResult(ctxResult);
      if (!ctx || !ctx.comp) {
        setStatus(
          state.lang === "zh" ? "请先在 AE 里选中一个合成" : "Select a composition in AE first",
          true
        );
        return;
      }
      setStatus(state.lang === "zh" ? "正在应用预设…" : "Applying preset…", false);
      engine(
        "AEV_Presets.applyJson(" +
          JSON.stringify(ctx.comp) + "," +
          JSON.stringify(item.path) + "," +
          (Number(ctx.layer) || 0) + ")",
        function (applyResult) {
          var data = parseEngineResult(applyResult);
          if (data && data.status === "ok" && data.best) {
            setStatus(
              "已应用「" + item.name + "」（图层类型 " + data.best.kind +
                "，新增效果 " + data.best.effects + "）",
              false
            );
            checkPresetDependencies(ctx.comp);
          } else {
            var attempts = (data && data.attempts) || [];
            setStatus(
              "预设没有生效：" + (attempts.join(" | ") || "未知原因"),
              true
            );
          }
        }
      );
    });
  }

  /** 依赖检查：合成里用到但本机没装的效果（通常是缺插件） */
  function checkPresetDependencies(compName) {
    engine("AEV_Presets.dependenciesJson(" + JSON.stringify(compName) + ")", function (result) {
      var data = parseEngineResult(result);
      if (!data || data.status !== "ok") return;
      var missing = data.missing || [];
      if (missing.length) {
        setStatus(
          "缺少 " + missing.length + " 个插件效果：" + missing.slice(0, 3).join("、") +
            (missing.length > 3 ? " 等" : ""),
          true
        );
      }
    });
  }

  /**
   * 搜索框的展开/收起。
   *
   * 平时只显示一个小图标（面板可以拖得很窄，常驻的大输入框会把筛选栏
   * 挤爆）；点一下才展开输入框并聚焦。
   */
  function setSearchOpen(open, inputId, fieldId, toggleId) {
    var field = byId(fieldId);
    var toggle = byId(toggleId);
    var input = byId(inputId);
    if (!field || !toggle || !input) return;
    field.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      input.focus();
      input.select();
    }
  }

  /**
   * 搜索框的展开/收起交互。
   *
   * 收起靠「点击 search-wrap 之外的地方」判定 —— 用 document 上的
   * mousedown 监听 + contains 判断，比在 wrap 上挂 click 再看
   * event.target 可靠得多：点图标时 target 是按钮、点输入框时 target
   * 是 input，两个条件都不满足，收起逻辑永远不触发。
   *
   * 图标本身再点一次是「切换」：展开时收起，收起时展开。
   */
  function bindSearchToggle(toggleId, inputId, fieldId, wrapId) {
    var toggle = byId(toggleId);
    var input = byId(inputId);
    var field = byId(fieldId);
    var wrap = byId(wrapId);
    if (!toggle || !input || !field || !wrap) return;

    var isOpen = function () {
      return !field.hidden;
    };

    toggle.addEventListener("click", function () {
      if (isOpen()) {
        setSearchOpen(false, inputId, fieldId, toggleId);
      } else {
        setSearchOpen(true, inputId, fieldId, toggleId);
      }
    });

    input.addEventListener("keydown", function (event) {
      if (event.key === "Escape" || event.keyCode === 27) {
        event.stopPropagation();
        input.value = "";
        if (inputId === "searchInput") {
          state.query = "";
          render();
        } else {
          state.presetQuery = "";
          renderPresetList();
        }
        setSearchOpen(false, inputId, fieldId, toggleId);
      }
    });

    // 点到包装之外就收起。用 mousedown 而不是 click：
    // 点击时输入框可能已经失焦，且 mousedown 早于 blur，顺序更稳。
    document.addEventListener("mousedown", function (event) {
      if (!isOpen()) return;
      var target = event.target;
      if (target && wrap.contains && wrap.contains(target)) return;
      setSearchOpen(false, inputId, fieldId, toggleId);
    });
  }

  /**
   * 设置页开关。
   *
   * 与队列抽屉互斥：两个都是右侧覆盖层，同时开只会互相盖住。
   * 齿轮按钮是「切换」语义；Esc 与点抽屉外都能收起。
   */
  function setSettingsOpen(open) {
    var drawer = byId("settingsDrawer");
    var trigger = byId("btnSettings");
    if (!drawer || !trigger) return;
    drawer.hidden = !open;
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      var queue = byId("queueDrawer");
      if (queue) queue.hidden = true;
    }
  }

  /**
   * 主视图切换：效果预览 / 预设预览。
   *
   * 两个视图同级，切换栏固定在面板最上方。
   * 切到预设视图时才去读预设库 —— 效果视图用不到它。
   */
  function setView(view) {
    state.view = view;
    var isEffects = view === "effects";
    byId("viewEffects").hidden = !isEffects;
    byId("viewPresets").hidden = isEffects;
    byId("tabEffects").className = "view-tab" + (isEffects ? " active" : "");
    byId("tabPresets").className = "view-tab" + (!isEffects ? " active" : "");
    byId("tabEffects").setAttribute("aria-selected", isEffects ? "true" : "false");
    byId("tabPresets").setAttribute("aria-selected", !isEffects ? "true" : "false");
    // 效果墙专属的工具条在预设视图下没有意义（搜索的是效果不是预设）
    byId("effectControls").hidden = !isEffects;
    if (isEffects) {
      // 切回来时重建效果墙：离开时把 DOM 清空了
      render();
    } else {
      // 离开效果墙时把几百张卡片从 DOM 里摘掉 —— 留着虽然看不见，
      // 但每次切回来都要重建，白白浪费一次建 hundreds 个节点的开销。
      var grid = byId("previewGrid");
      if (grid) grid.textContent = "";
      loadPresetLibrary();
    }
  }

  function boot() {
    byId("langZh").addEventListener("click", function () { setLanguage("zh"); });
    byId("langEn").addEventListener("click", function () { setLanguage("en"); });
    byId("tabEffects").addEventListener("click", function () { setView("effects"); });
    byId("tabPresets").addEventListener("click", function () { setView("presets"); });
    byId("sortName").addEventListener("click", function () { setSortMode("name"); });
    byId("sortCategory").addEventListener("click", function () { setSortMode("category"); });
    byId("searchInput").addEventListener("input", function () {
      state.query = this.value;
      render();
    });
    bindSearchToggle("searchToggle", "searchInput", "searchField", "searchWrap");
    byId("pluginFilter").addEventListener("change", function () {
      state.plugin = this.value;
      render();
    });
    byId("showAll").addEventListener("change", function () {
      state.showAll = this.checked;
      rebuildItems();
      render();
    });
    byId("btnRefresh").addEventListener("click", function () {
      // 「重新扫描」= 强制重扫 AE 效果清单（用户可能刚装了新插件）
      refresh(null, true);
    });
    byId("btnGenerate").addEventListener("click", generateMissing);
    byId("btnRetry").addEventListener("click", retryFailed);
    byId("btnSettings").addEventListener("click", function () {
      setSettingsOpen(byId("settingsDrawer").hidden);
    });
    byId("btnSettingsClose").addEventListener("click", function () {
      setSettingsOpen(false);
    });
    byId("btnOpenQueue").addEventListener("click", function () {
      setSettingsOpen(false);
      var drawer = byId("queueDrawer");
      if (drawer) {
        drawer.hidden = false;
        refreshQueue();
      }
    });
    // Esc 关设置页；点在抽屉与齿轮之外也关。
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" || event.keyCode === 27) {
        if (!byId("settingsDrawer").hidden) setSettingsOpen(false);
      }
    });
    document.addEventListener("mousedown", function (event) {
      var drawer = byId("settingsDrawer");
      if (drawer.hidden) return;
      var target = event.target;
      var trigger = byId("btnSettings");
      if (trigger && trigger.contains && trigger.contains(target)) return;
      if (drawer.contains && drawer.contains(target)) return;
      setSettingsOpen(false);
    });
    byId("btnQueue").addEventListener("click", function () {
      var drawer = byId("queueDrawer");
      if (!drawer) return;
      var opening = drawer.hidden;
      setSettingsOpen(false); // 与设置页互斥
      drawer.hidden = !opening;
      if (opening) refreshQueue();
    });
    byId("btnQueueClose").addEventListener("click", function () {
      var drawer = byId("queueDrawer");
      if (drawer) drawer.hidden = true;
    });
    byId("btnQueueRetry").addEventListener("click", function () {
      retryFailed();
    });
    byId("btnPresetAdd").addEventListener("click", function () {
      addPresets();
    });
    byId("presetSearch").addEventListener("input", function () {
      state.presetQuery = this.value;
      renderPresetList();
    });
    bindSearchToggle(
      "presetSearchToggle",
      "presetSearch",
      "presetSearchField",
      "presetSearchWrap"
    );
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
