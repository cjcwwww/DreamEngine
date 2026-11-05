const fs = require("node:fs");
const path = require("node:path");

function emptyDoc() {
  return {
    version: 1,
    categories: [],
    assignments: {},
    favorites: {},
    renderSkip: {},
  };
}

function pathKey(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function trim(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function read(paths) {
  try {
    const raw = fs.readFileSync(paths.presetCategories, "utf8").replace(/^\uFEFF/, "");
    const doc = JSON.parse(raw);
    return {
      version: 1,
      categories: Array.isArray(doc.categories) ? doc.categories : [],
      assignments: doc.assignments && typeof doc.assignments === "object" ? doc.assignments : {},
      favorites: doc.favorites && typeof doc.favorites === "object" ? doc.favorites : {},
      renderSkip: doc.renderSkip && typeof doc.renderSkip === "object" ? doc.renderSkip : {},
    };
  } catch {
    return emptyDoc();
  }
}

function write(paths, doc) {
  fs.mkdirSync(path.dirname(paths.presetCategories), { recursive: true });
  fs.writeFileSync(paths.presetCategories, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return doc;
}

function nameExists(doc, name, exceptId) {
  const needle = trim(name).toLowerCase();
  return doc.categories.some(
    (row) => row.id !== exceptId && String(row.name || "").toLowerCase() === needle,
  );
}

function create(paths, name) {
  const clean = trim(name);
  if (!clean) return { ok: false, reason: "empty_name", doc: read(paths) };
  const doc = read(paths);
  if (nameExists(doc, clean, "")) return { ok: false, reason: "duplicate", doc };
  const row = {
    id: `category-${Date.now().toString(36)}-${doc.categories.length + 1}`,
    name: clean,
  };
  doc.categories.push(row);
  write(paths, doc);
  return { ok: true, category: row, doc };
}

function rename(paths, id, name) {
  const clean = trim(name);
  if (!clean) return { ok: false, reason: "empty_name", doc: read(paths) };
  const doc = read(paths);
  if (nameExists(doc, clean, id)) return { ok: false, reason: "duplicate", doc };
  const row = doc.categories.find((item) => item.id === id);
  if (!row) return { ok: false, reason: "not_found", doc };
  row.name = clean;
  write(paths, doc);
  return { ok: true, category: row, doc };
}

function remove(paths, id) {
  const doc = read(paths);
  const before = doc.categories.length;
  doc.categories = doc.categories.filter((item) => item.id !== id);
  if (doc.categories.length === before) return { ok: false, reason: "not_found", doc };
  for (const [key, value] of Object.entries(doc.assignments)) {
    if (value === id) delete doc.assignments[key];
  }
  write(paths, doc);
  return { ok: true, doc };
}

function assign(paths, target, categoryId) {
  const doc = read(paths);
  const key = pathKey(target);
  if (!key) return { ok: false, reason: "empty_path", doc };
  if (!categoryId) {
    delete doc.assignments[key];
  } else {
    if (!doc.categories.some((item) => item.id === categoryId)) {
      return { ok: false, reason: "category_missing", doc };
    }
    doc.assignments[key] = String(categoryId);
  }
  write(paths, doc);
  return { ok: true, doc };
}

function toggleFavorite(paths, target) {
  const doc = read(paths);
  const key = pathKey(target);
  if (!key) return { ok: false, reason: "empty_path", doc };
  const favorite = !doc.favorites[key];
  if (favorite) doc.favorites[key] = true;
  else delete doc.favorites[key];
  write(paths, doc);
  return { ok: true, favorite, doc };
}

function toggleRenderSkip(paths, target) {
  const doc = read(paths);
  const key = pathKey(target);
  if (!key) return { ok: false, reason: "empty_path", doc };
  const renderDisabled = !doc.renderSkip[key];
  if (renderDisabled) doc.renderSkip[key] = true;
  else delete doc.renderSkip[key];
  write(paths, doc);
  return { ok: true, renderDisabled, doc };
}

function movePath(paths, from, to) {
  const oldKey = pathKey(from);
  const newKey = pathKey(to);
  const doc = read(paths);
  if (!oldKey || !newKey) return { ok: false, reason: "empty_path", doc };
  if (doc.assignments[oldKey]) {
    doc.assignments[newKey] = doc.assignments[oldKey];
    delete doc.assignments[oldKey];
  }
  if (doc.favorites[oldKey]) {
    doc.favorites[newKey] = true;
    delete doc.favorites[oldKey];
  }
  if (doc.renderSkip[oldKey]) {
    doc.renderSkip[newKey] = true;
    delete doc.renderSkip[oldKey];
  }
  write(paths, doc);
  return { ok: true, doc };
}

module.exports = {
  read,
  create,
  rename,
  remove,
  assign,
  toggleFavorite,
  toggleRenderSkip,
  movePath,
  pathKey,
};
