/* ============================================================
 * prefs.js —— 面板本地的收藏与预设分类
 *
 * 这些数据不依赖 AE 工程，使用 localStorage 跨会话保存。
 * 路径型 id 统一把反斜杠转成正斜杠并忽略大小写，避免 Windows
 * 上同一个文件因为路径写法不同出现两份收藏或分类。
 * ============================================================ */

var AEV_Prefs = (function () {
  var FAVORITES_KEY = "dreamengine.favorites.v1";
  var ORGANIZER_KEY = "dreamengine.presetOrganizer.v1";
  var UI_LAYOUT_KEY = "dreamengine.uiLayout.v1";
  var memoryStorage = {};
  var categorySeq = 0;
  var SIDEBAR_KINDS = { effects: true, presets: true, materials: true };

  function readRaw(key) {
    try {
      if (window.localStorage) return window.localStorage.getItem(key) || "";
    } catch (e) {}
    return memoryStorage[key] || "";
  }

  function writeRaw(key, value) {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(key, value);
        return;
      }
    } catch (e) {}
    memoryStorage[key] = value;
  }

  function readJson(key, fallback) {
    var text = readRaw(key);
    if (!text) return fallback;
    try {
      return JSON.parse(text);
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    writeRaw(key, JSON.stringify(value));
  }

  function uiLayoutDoc() {
    var doc = readJson(UI_LAYOUT_KEY, null);
    if (!doc || typeof doc !== "object") doc = {};
    if (!doc.sidebarWidths || typeof doc.sidebarWidths !== "object") {
      doc.sidebarWidths = {};
    }
    if (!doc.thumbSizes || typeof doc.thumbSizes !== "object") {
      doc.thumbSizes = {};
    }
    return doc;
  }

  function sidebarWidth(kind) {
    if (!SIDEBAR_KINDS[kind]) return 0;
    var value = Number(uiLayoutDoc().sidebarWidths[kind]);
    return isFinite(value) && value > 0 ? Math.round(value) : 0;
  }

  function setSidebarWidth(kind, width) {
    if (!SIDEBAR_KINDS[kind]) return false;
    var value = Number(width);
    if (!isFinite(value) || value < 80 || value > 1000) return false;
    var doc = uiLayoutDoc();
    doc.sidebarWidths[kind] = Math.round(value);
    writeJson(UI_LAYOUT_KEY, doc);
    return true;
  }

  function thumbSize(kind) {
    if (!SIDEBAR_KINDS[kind]) return 0;
    var value = Number(uiLayoutDoc().thumbSizes[kind]);
    return isFinite(value) && value >= 48 && value <= 180 ? Math.round(value) : 0;
  }

  function setThumbSize(kind, size) {
    if (!SIDEBAR_KINDS[kind]) return false;
    var value = Number(size);
    if (!isFinite(value) || value < 48 || value > 180) return false;
    var doc = uiLayoutDoc();
    doc.thumbSizes[kind] = 48 + Math.round((value - 48) / 2) * 2;
    writeJson(UI_LAYOUT_KEY, doc);
    return true;
  }

  function trim(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/^\s+|\s+$/g, "")
      .replace(/\s+/g, " ");
  }

  function pathKey(path) {
    return String(path || "").replace(/\\/g, "/").toLowerCase();
  }

  function favoriteKey(kind, id) {
    if (kind === "presets" || kind === "materials") return pathKey(id);
    return String(id || "");
  }

  function favoritesDoc() {
    var doc = readJson(FAVORITES_KEY, null);
    if (!doc || typeof doc !== "object") doc = {};
    if (!doc.effects || !doc.effects.length) doc.effects = doc.effects || [];
    if (!doc.presets || !doc.presets.length) doc.presets = doc.presets || [];
    if (!doc.materials || !doc.materials.length) doc.materials = doc.materials || [];
    return doc;
  }

  function isFavorite(kind, id) {
    var doc = favoritesDoc();
    var rows = doc[kind] || [];
    var needle = favoriteKey(kind, id);
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i]) === needle) return true;
    }
    return false;
  }

  function toggleFavorite(kind, id) {
    var doc = favoritesDoc();
    var rows = doc[kind] || [];
    var needle = favoriteKey(kind, id);
    var next = [];
    var found = false;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i]) === needle) {
        found = true;
      } else {
        next.push(String(rows[i]));
      }
    }
    if (!found) next.push(needle);
    doc[kind] = next;
    writeJson(FAVORITES_KEY, doc);
    return !found;
  }

  function presetFavoritePathsJson() {
    return JSON.stringify(favoritesDoc().presets || []);
  }

  function clearPresetFavorites() {
    var doc = favoritesDoc();
    doc.presets = [];
    writeJson(FAVORITES_KEY, doc);
  }

  function organizerDoc() {
    var doc = readJson(ORGANIZER_KEY, null);
    if (!doc || typeof doc !== "object") doc = {};
    if (!doc.categories) doc.categories = [];
    if (!doc.assignments || typeof doc.assignments !== "object") doc.assignments = {};
    return doc;
  }

  function categories() {
    var doc = organizerDoc();
    var out = [];
    for (var i = 0; i < doc.categories.length; i++) {
      out.push({
        id: String(doc.categories[i].id || ""),
        name: String(doc.categories[i].name || "")
      });
    }
    return out;
  }

  function categoryNameExists(rows, name, exceptId) {
    var needle = trim(name).toLowerCase();
    for (var i = 0; i < rows.length; i++) {
      if (exceptId && rows[i].id === exceptId) continue;
      if (String(rows[i].name || "").toLowerCase() === needle) return true;
    }
    return false;
  }

  function createPresetCategory(name) {
    var clean = trim(name);
    if (!clean) return null;
    var doc = organizerDoc();
    if (categoryNameExists(doc.categories, clean, "")) return null;
    categorySeq++;
    var row = {
      id: "category-" + new Date().getTime().toString(36) + "-" + categorySeq,
      name: clean
    };
    doc.categories.push(row);
    writeJson(ORGANIZER_KEY, doc);
    return { id: row.id, name: row.name };
  }

  function renamePresetCategory(id, name) {
    var clean = trim(name);
    if (!clean) return false;
    var doc = organizerDoc();
    if (categoryNameExists(doc.categories, clean, String(id || ""))) return false;
    for (var i = 0; i < doc.categories.length; i++) {
      if (doc.categories[i].id === id) {
        doc.categories[i].name = clean;
        writeJson(ORGANIZER_KEY, doc);
        return true;
      }
    }
    return false;
  }

  function deletePresetCategory(id) {
    var doc = organizerDoc();
    var next = [];
    var found = false;
    for (var i = 0; i < doc.categories.length; i++) {
      if (doc.categories[i].id === id) found = true;
      else next.push(doc.categories[i]);
    }
    if (!found) return false;
    doc.categories = next;
    for (var key in doc.assignments) {
      if (!doc.assignments.hasOwnProperty(key)) continue;
      if (doc.assignments[key] === id) delete doc.assignments[key];
    }
    writeJson(ORGANIZER_KEY, doc);
    return true;
  }

  function presetCategoryFor(path) {
    var doc = organizerDoc();
    return String(doc.assignments[pathKey(path)] || "");
  }

  function setPresetCategory(path, categoryId) {
    var doc = organizerDoc();
    var key = pathKey(path);
    if (!key) return false;
    if (!categoryId) {
      delete doc.assignments[key];
      writeJson(ORGANIZER_KEY, doc);
      return true;
    }
    var exists = false;
    for (var i = 0; i < doc.categories.length; i++) {
      if (doc.categories[i].id === categoryId) {
        exists = true;
        break;
      }
    }
    if (!exists) return false;
    doc.assignments[key] = String(categoryId);
    writeJson(ORGANIZER_KEY, doc);
    return true;
  }

  return {
    pathKey: pathKey,
    sidebarWidth: sidebarWidth,
    setSidebarWidth: setSidebarWidth,
    thumbSize: thumbSize,
    setThumbSize: setThumbSize,
    isFavorite: isFavorite,
    toggleFavorite: toggleFavorite,
    presetFavoritePathsJson: presetFavoritePathsJson,
    clearPresetFavorites: clearPresetFavorites,
    presetCategories: categories,
    createPresetCategory: createPresetCategory,
    renamePresetCategory: renamePresetCategory,
    deletePresetCategory: deletePresetCategory,
    presetCategoryFor: presetCategoryFor,
    setPresetCategory: setPresetCategory,
    presetOrganizerJson: function () { return JSON.stringify(organizerDoc()); }
  };
})();
