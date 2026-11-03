var AEV_ViewModel = (function () {
  /* 表达式控件族与音频族不渲图，面板退化为文字条目（设计文档 §4.3） */
  var NO_PREVIEW_CATEGORIES = [
    "expression controls",
    "表达式控制",
    "audio",
    "音频"
  ];

  function isNoPreview(category) {
    var cat = String(category === undefined || category === null ? "" : category).toLowerCase();
    for (var i = 0; i < NO_PREVIEW_CATEGORIES.length; i++) {
      if (cat === NO_PREVIEW_CATEGORIES[i]) return true;
    }
    return false;
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
