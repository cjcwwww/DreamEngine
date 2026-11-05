// ============================================================
// preset_categories.jsx —— AE / Hub 共享的预设分类存储
//
// 文件：<我的文档>/DreamEngine/preset_categories.json
// 结构：{ version, categories:[{id,name}], assignments:{path:id} }
// 语法：ES3 only。
// ============================================================

var AEV_PresetCategories = (function () {
    var RELATIVE = "preset_categories.json";
    var seq = 0;

    function jsonText(value) {
        var out = String(value === undefined || value === null ? "" : value);
        out = out.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        out = out.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
        return '"' + out + '"';
    }

    function trim(value) {
        return String(value === undefined || value === null ? "" : value)
            .replace(/^\s+|\s+$/g, "")
            .replace(/\s+/g, " ");
    }

    function pathKey(path) {
        return String(path || "").replace(/\\/g, "/").toLowerCase();
    }

    function emptyDoc() {
        return { version: 1, categories: [], assignments: {} };
    }

    function normalize(doc) {
        if (!doc || typeof doc !== "object") return emptyDoc();
        if (!doc.categories || !doc.categories.length) doc.categories = doc.categories || [];
        if (!doc.assignments || typeof doc.assignments !== "object") doc.assignments = {};
        doc.version = 1;
        return doc;
    }

    function readDoc() {
        var text = AEV_Store.readText(RELATIVE);
        if (!text) return emptyDoc();
        try {
            return normalize(eval("(" + text + ")"));
        } catch (e) {
            return emptyDoc();
        }
    }

    function docJson(doc) {
        var categories = [];
        var assignments = [];
        var i;
        for (i = 0; i < doc.categories.length; i++) {
            categories.push(
                '{"id":' + jsonText(doc.categories[i].id) +
                ',"name":' + jsonText(doc.categories[i].name) + "}"
            );
        }
        for (var key in doc.assignments) {
            if (!doc.assignments.hasOwnProperty(key)) continue;
            assignments.push(jsonText(key) + ":" + jsonText(doc.assignments[key]));
        }
        return '{"version":1,"categories":[' + categories.join(",") +
            '],"assignments":{' + assignments.join(",") + "}}";
    }

    function writeDoc(doc) {
        var outcome = AEV_Store.writeText(RELATIVE, docJson(doc));
        if (String(outcome).indexOf("OK:") !== 0) throw new Error(outcome);
        return doc;
    }

    function nameExists(doc, name, exceptId) {
        var needle = trim(name).toLowerCase();
        for (var i = 0; i < doc.categories.length; i++) {
            if (exceptId && doc.categories[i].id === exceptId) continue;
            if (String(doc.categories[i].name || "").toLowerCase() === needle) return true;
        }
        return false;
    }

    function loadJson() {
        return docJson(writeDoc(readDoc()));
    }

    function importJson(text) {
        try {
            return docJson(writeDoc(normalize(eval("(" + String(text || "{}") + ")"))));
        } catch (e) {
            return '{"status":"error","reason":"bad_json"}';
        }
    }

    function createJson(name) {
        var clean = trim(name);
        if (!clean) return '{"status":"error","reason":"empty_name"}';
        var doc = readDoc();
        if (nameExists(doc, clean, "")) return '{"status":"error","reason":"duplicate"}';
        seq++;
        doc.categories.push({
            id: "category-" + new Date().getTime().toString(36) + "-" + seq,
            name: clean
        });
        return docJson(writeDoc(doc));
    }

    function renameJson(id, name) {
        var clean = trim(name);
        if (!clean) return '{"status":"error","reason":"empty_name"}';
        var doc = readDoc();
        if (nameExists(doc, clean, id)) return '{"status":"error","reason":"duplicate"}';
        for (var i = 0; i < doc.categories.length; i++) {
            if (doc.categories[i].id === id) {
                doc.categories[i].name = clean;
                return docJson(writeDoc(doc));
            }
        }
        return '{"status":"error","reason":"not_found"}';
    }

    function deleteJson(id) {
        var doc = readDoc();
        var next = [];
        var found = false;
        for (var i = 0; i < doc.categories.length; i++) {
            if (doc.categories[i].id === id) found = true;
            else next.push(doc.categories[i]);
        }
        if (!found) return '{"status":"error","reason":"not_found"}';
        doc.categories = next;
        for (var key in doc.assignments) {
            if (doc.assignments.hasOwnProperty(key) && doc.assignments[key] === id) {
                delete doc.assignments[key];
            }
        }
        return docJson(writeDoc(doc));
    }

    function assignJson(path, categoryId) {
        var doc = readDoc();
        var key = pathKey(path);
        if (!key) return '{"status":"error","reason":"empty_path"}';
        if (!categoryId) {
            delete doc.assignments[key];
        } else {
            var exists = false;
            for (var i = 0; i < doc.categories.length; i++) {
                if (doc.categories[i].id === categoryId) {
                    exists = true;
                    break;
                }
            }
            if (!exists) return '{"status":"error","reason":"category_missing"}';
            doc.assignments[key] = String(categoryId);
        }
        return docJson(writeDoc(doc));
    }

    return {
        loadJson: loadJson,
        importJson: importJson,
        createJson: createJson,
        renameJson: renameJson,
        deleteJson: deleteJson,
        assignJson: assignJson,
        pathKey: pathKey
    };
})();
