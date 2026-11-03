var AEV_ViewModel = (function () {
  /* 表达式控件族与音频族不渲图，面板退化为文字条目（设计文档 §4.3） */
  var NO_PREVIEW_CATEGORIES = [
    "expression controls",
    "表达式控制",
    "audio",
    "音频"
  ];

  /* 这些分类即使渲出来也基本看不出效果：需要 3D 场景、立体素材或音频输入。
     实测踩过：按 catalog 原始顺序取候选，第一屏全是 ADBE 3D Tracker / 3D Glasses，
     8 个预览里 6 个与原始素材几乎无差别。 */
  var POOR_PREVIEW_CATEGORIES = [
    "3d channel",
    "3d 通道"
  ];

  /* 常用且视觉差异明显的分类，越靠前越优先生成 */
  var PREFERRED_CATEGORIES = [
    "blur & sharpen",
    "模糊和锐化",
    "color correction",
    "颜色校正",
    "distort",
    "扭曲",
    "stylize",
    "风格化",
    "generate",
    "生成",
    "noise & grain",
    "杂色和颗粒",
    "perspective",
    "透视",
    "transition",
    "过渡",
    "keying",
    "抠像",
    "simulation",
    "模拟",
    "channel",
    "声道",
    "time",
    "时间",
    "utility",
    "实用工具",
    "matte",
    "遮罩"
  ];

  function normalize(value) {
    return String(value === undefined || value === null ? "" : value).toLowerCase();
  }

  function indexOfText(list, value) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] === value) return i;
    }
    return -1;
  }

  function isNoPreview(category) {
    var cat = normalize(category);
    return indexOfText(NO_PREVIEW_CATEGORIES, cat) >= 0;
  }

  /** 需要 3D 场景/立体素材才成立的效果，列入"不主动生成" */
  function isPoorPreviewTarget(effect) {
    var cat = normalize(effect && effect.category);
    if (indexOfText(POOR_PREVIEW_CATEGORIES, cat) >= 0) return true;
    var matchName = normalize(effect && effect.matchName);
    // CS 前缀是本机 Cycore 旧命名残留（displayName 与 CC 系列重名）。
    // 实测：CS CrossBlur 参与整网渲染时报「滤镜无效」，整批随之失败。
    // 这 10 个先整体排除，等隔离探针逐个确认后再决定是否恢复。
    if (matchName.indexOf("cs") === 0) return true;
    // 实测：CC Drizzle 在 2048 整网 × 6 帧下渲染挂起（AE 未响应超过 5 分钟），
    // 逐条测试时也会卡在同一处。先排除，避免单条拖死整批。
    if (matchName === "cc drizzle") return true;
    // 实测：ADBE Numbers2 / Timecode 这类"文本生成器"在 addProperty 时就会弹出
    // 模态参数对话框（编号设置），脚本会一直等输入，AE 看起来像死机。
    if (/^adbe (numbers|timecode)/.test(matchName)) return true;
    var hints = ["tracker", "glasses", "stereo", "camera", "extracto"];
    for (var i = 0; i < hints.length; i++) {
      if (matchName.indexOf(hints[i]) >= 0) return true;
    }
    return false;
  }

  /** 生成优先级：数值越小越先渲 */
  function previewRank(effect) {
    if (isPoorPreviewTarget(effect)) return 1000;
    var cat = normalize(effect && effect.category);
    var idx = indexOfText(PREFERRED_CATEGORIES, cat);
    return idx >= 0 ? idx : 500;
  }

  /** 按分类轮转排列候选。
   *  纯按 rank 排序会让首批 64 个全是"模糊和锐化"，预览墙看起来毫无多样性；
   *  轮转后首批就能覆盖模糊/调色/扭曲/风格化等多个类别。
   */
  function interleaveByCategory(effects) {
    var buckets = {};
    var order = [];
    for (var i = 0; i < effects.length; i++) {
      var effect = effects[i];
      var cat = normalize(effect && effect.category) || "未分类";
      if (!buckets[cat]) {
        buckets[cat] = [];
        order.push(cat);
      }
      buckets[cat].push(effect);
    }

    order.sort(function (a, b) {
      var rankA = previewRank(buckets[a][0]);
      var rankB = previewRank(buckets[b][0]);
      if (rankA !== rankB) return rankA - rankB;
      return buckets[b].length - buckets[a].length;
    });

    var out = [];
    var cursors = {};
    var progressed = true;
    while (progressed) {
      progressed = false;
      for (var k = 0; k < order.length; k++) {
        var key = order[k];
        var cursor = cursors[key] || 0;
        if (cursor < buckets[key].length) {
          out.push(buckets[key][cursor]);
          cursors[key] = cursor + 1;
          progressed = true;
        }
      }
    }
    return out;
  }

  function firstText() {
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i];
      if (value !== null && value !== undefined && String(value).length > 0) {
        return String(value);
      }
    }
    return "";
  }

  function resolveName(item, lang) {
    if (lang === "zh") {
      return firstText(item.nameZh, item.nameEn, item.displayName, item.matchName);
    }
    return firstText(item.nameEn, item.displayName, item.nameZh, item.matchName);
  }

  function resolveCategory(item, lang) {
    if (lang === "zh") {
      return firstText(item.categoryZh, item.categoryEn, item.category, "未分类");
    }
    return firstText(item.categoryEn, item.category, item.categoryZh, "Uncategorized");
  }

  function inferPlugin(item) {
    var matchName = String(item.matchName || "");
    var category = String(item.category || "");

    if (category.indexOf("BCC") === 0 || matchName.indexOf("BCC") === 0) return "BCC";
    if (
      matchName.indexOf("S_") === 0 ||
      category.indexOf("Sapphire") === 0
    ) return "Sapphire";
    if (
      matchName.indexOf("RG") === 0 ||
      category.indexOf("RG ") === 0
    ) return "Red Giant";
    if (
      matchName.indexOf("RE:") === 0 ||
      category.indexOf("RE:Vision") === 0
    ) return "RE:Vision";
    if (
      matchName.indexOf("Videocopilot") === 0 ||
      matchName.indexOf("VIDEOCOPILOT") === 0 ||
      category === "Video Copilot"
    ) return "Video Copilot";
    if (
      matchName.indexOf("ADBE") === 0 ||
      matchName.indexOf("APC") === 0 ||
      matchName.indexOf("CC ") === 0 ||
      matchName.indexOf("CS") === 0
    ) return "内置";

    return category || "未收录";
  }

  function buildItem(effect, namesByName, previewByMatchName) {
    var nameRecord = namesByName[effect.matchName] || {};
    var preview = previewByMatchName[effect.matchName] || null;
    return {
      matchName: effect.matchName,
      displayName: effect.displayName,
      category: effect.category,
      categoryZh: nameRecord.categoryZh,
      categoryEn: nameRecord.categoryEn,
      nameZh: nameRecord.nameZh,
      nameEn: nameRecord.nameEn,
      plugin: inferPlugin(effect),
      hasPreview: !!(preview && (preview.src || preview.frameSrc)),
      preview: preview
    };
  }

  function filterItems(items, state) {
    var lang = state.lang || "zh";
    var query = String(state.query || "").toLowerCase();
    var plugin = state.plugin || "全部";
    var output = [];

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (plugin !== "全部" && item.plugin !== plugin) continue;

      if (query) {
        var haystack = [
          resolveName(item, lang),
          resolveName(item, lang === "zh" ? "en" : "zh"),
          item.matchName,
          item.displayName,
          item.plugin,
          resolveCategory(item, lang)
        ].join(" ").toLowerCase();
        if (haystack.indexOf(query) === -1) continue;
      }
      output.push(item);
    }
    return output;
  }

  return {
    isNoPreview: isNoPreview,
    isPoorPreviewTarget: isPoorPreviewTarget,
    previewRank: previewRank,
    interleaveByCategory: interleaveByCategory,
    inferPlugin: inferPlugin,
    resolveName: resolveName,
    resolveCategory: resolveCategory,
    buildItem: buildItem,
    filterItems: filterItems
  };
})();

if (typeof window !== "undefined") {
  window.AEV_ViewModel = AEV_ViewModel;
}
