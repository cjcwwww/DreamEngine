// ============================================================
// presets.jsx —— 预设库（M3）：扫描 .ffx、安全应用、依赖检查
//
// 依据 T0.4 / T0.6 的实机结论：
//   · 目录扫描必须递归（单层 getFiles("*.ffx") 返回 0），
//     AE 自带 Presets 目录 622 个 .ffx，递归约 742ms
//   · applyPreset 对图层类型不匹配时**静默无效**（不报错、也没效果）
//   · 没有选中层时 applyPreset 会自己新建图层
//   → 所以应用预设必须：清空选区、只选目标层；调用后比较
//     「效果数 / 含关键帧属性数 / 图层数」；按 solid→text→footage→adjustment
//     重试；把自动新建的图层用 remove() 删掉（不依赖撤销）。
//
// 语法：ES3 only。
// ============================================================

var AEV_Presets = (function () {
    var MAX_FILES = 1200;
    var MAX_DEPTH = 5;
    /* 试用的图层类型顺序：先纯色层（大多数效果预设都能落上去） */
    var LAYER_ORDER = ["solid", "text", "footage", "adjustment"];

    function jsonText(value) {
        var out = String(value === undefined || value === null ? "" : value);
        out = out.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        out = out.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
        return '"' + out + '"';
    }

    function result(status, fields) {
        var parts = ['"status":' + jsonText(status)];
        for (var i = 0; i < fields.length; i++) {
            parts.push('"' + fields[i][0] + '":' + jsonText(fields[i][1]));
        }
        return "{" + parts.join(",") + "}";
    }

    function isPresetFile(name) {
        var lower = String(name || "").toLowerCase();
        return lower.length > 4 && lower.lastIndexOf(".ffx") === lower.length - 4;
    }

    /** 递归收集 .ffx（单层扫描拿不到，必须递归——T0.6 实测） */
    function collect(folder, depth, out) {
        if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
        var entries = [];
        try {
            entries = folder.getFiles();
        } catch (e) {
            return;
        }
        for (var i = 0; i < entries.length; i++) {
            if (out.length >= MAX_FILES) return;
            var entry = entries[i];
            if (entry instanceof Folder) {
                collect(entry, depth + 1, out);
                continue;
            }
            if (!isPresetFile(entry.name)) continue;
            out.push({
                path: entry.fsName,
                name: String(entry.name).replace(/\.ffx$/i, ""),
                size: 0,
                folder: folder.fsName
            });
        }
    }

    /**
     * 预设的分类：取所在目录名（AE 自带预设按目录分门别类）。
     * 传文件路径或目录路径都支持。
     */
    function categoryOf(pathText) {
        var text = String(pathText || "");
        // 传的是文件路径时，先去掉文件名
        if (isPresetFile(text)) {
            var cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
            if (cut < 0) return "";
            text = text.substring(0, cut);
        }
        var cut2 = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
        if (cut2 < 0) return "";
        return text.substring(cut2 + 1);
    }

    /**
     * 扫描目录下的 .ffx。
     * 返回 {status, count, items:[{path,name,category,size}]}
     */
    function scanJson(rootPath, limit) {
        var folder = new Folder(String(rootPath || ""));
        if (!folder.exists) {
            return result("error", [["reason", "no_folder"], ["path", String(rootPath || "")]]);
        }
        var found = [];
        collect(folder, 0, found);
        var max = limit > 0 ? limit : found.length;
        var items = [];
        var counts = {};
        for (var i = 0; i < found.length && items.length < max; i++) {
            var item = found[i];
            var category = categoryOf(item.folder);
            counts[category] = (counts[category] || 0) + 1;
            items.push(
                '{"path":' + jsonText(item.path) +
                ',"name":' + jsonText(item.name) +
                ',"category":' + jsonText(category) + "}"
            );
        }
        var cats = [];
        for (var key in counts) {
            if (counts.hasOwnProperty(key)) {
                cats.push('{"name":' + jsonText(key) + ',"count":' + counts[key] + "}");
            }
        }
        return '{"status":"ok","count":' + items.length +
               ',"total":' + found.length +
               ',"categories":[' + cats.join(",") + '],"items":[' +
               items.join(",") + "]}";
    }

    /** 合成当前状态快照：图层数 / 效果数 / 含关键帧的属性数 */
    function snapshot(comp) {
        var layers = 0, effects = 0, keyProps = 0;
        try {
            layers = comp.numLayers;
        } catch (e) {
            return { layers: 0, effects: 0, keyProps: 0 };
        }
        for (var i = 1; i <= layers; i++) {
            var layer = null;
            try {
                layer = comp.layer(i);
            } catch (e2) {
                continue;
            }
            if (!layer) continue;
            var parade = null;
            try {
                parade = layer.property("ADBE Effect Parade");
            } catch (e3) {
                continue;
            }
            if (!parade) continue;
            var count = 0;
            try {
                count = parade.numProperties;
            } catch (e4) {
                continue;
            }
            for (var e = 1; e <= count; e++) {
                effects++;
                var group = null;
                try {
                    group = parade.property(e);
                } catch (e5) {
                    continue;
                }
                if (!group) continue;
                var sub = 0;
                try {
                    sub = group.numProperties;
                } catch (e6) {
                    sub = 0;
                }
                for (var p = 1; p <= sub; p++) {
                    try {
                        var prop = group.property(p);
                        if (prop.numKeys && prop.numKeys > 0) keyProps++;
                    } catch (e7) {}
                }
            }
        }
        return { layers: layers, effects: effects, keyProps: keyProps };
    }

    /** 找到指定类型的图层；layerIndex >= 0 时优先用指定层 */
    function findLayer(comp, kind, layerIndex) {
        var total = 0;
        try {
            total = comp.numLayers;
        } catch (e) {
            return null;
        }
        if (layerIndex >= 1 && layerIndex <= total) {
            try {
                return comp.layer(layerIndex);
            } catch (e2) {}
        }
        for (var i = 1; i <= total; i++) {
            var layer = null;
            try {
                layer = comp.layer(i);
            } catch (e3) {
                continue;
            }
            if (!layer) continue;
            if (matchesKind(layer, kind)) return layer;
        }
        return null;
    }

    function sourceTypeOf(layer) {
        try {
            var source = layer.source;
            if (!source) return null;
            var main = source.mainSource;
            if (!main) return null;
            return main.sourceType;
        } catch (e) {
            return null;
        }
    }

    function matchesKind(layer, kind) {
        if (kind === "adjustment") {
            try {
                return !!layer.adjustmentLayer;
            } catch (e) {
                return false;
            }
        }
        var type = sourceTypeOf(layer);
        if (type === null) return false;
        try {
            if (kind === "solid") return type === SourceType.SOLID;
            if (kind === "text") return type === SourceType.TEXT;
            if (kind === "footage") return type === SourceType.FOOTAGE;
        } catch (e2) {}
        return false;
    }

    /** 删掉调用期间自动新建的图层（从末尾往前删，避免索引错位） */
    function cleanupLayers(comp, beforeCount) {
        var total = 0;
        try {
            total = comp.numLayers;
        } catch (e) {
            return;
        }
        for (var i = total; i > beforeCount; i--) {
            try {
                comp.layer(i).remove();
            } catch (e2) {}
        }
    }

    /**
     * 安全应用预设。
     * compName   目标合成名
     * presetPath .ffx 路径
     * layerIndex 指定图层序号（>=1 时优先用它），否则按类型顺序试
     * 返回 {status, best:{kind,effects,keys}, attempts:[...]}
     */
    function applyJson(compName, presetPath, layerIndex) {
        var comp = null;
        var lookupError = "";
        try {
            comp = app.project.items.getItemByName(String(compName || ""));
        } catch (e) {
            lookupError = String(e);
        }
        if (!comp) {
            return result("error", [
                ["reason", "no_comp"],
                ["comp", String(compName || "")],
                ["lookupError", lookupError]
            ]);
        }
        var file = new File(String(presetPath || ""));
        if (!file.exists) {
            return result("error", [["reason", "no_preset"], ["path", String(presetPath || "")]]);
        }

        var attempts = [];
        var best = null;
        var order = LAYER_ORDER;
        if (layerIndex >= 1) {
            order = ["index"];
        }

        for (var i = 0; i < order.length; i++) {
            var kind = order[i];
            var target = kind === "index"
                ? findLayer(comp, "", layerIndex)
                : findLayer(comp, kind, -1);
            if (!target) {
                attempts.push(kind + "|no_layer");
                continue;
            }
            var before = snapshot(comp);
            var applied = false;
            try {
                comp.selectedLayers = [target];
                app.applyPreset(file);
                applied = true;
            } catch (e) {
                attempts.push(kind + "|error|" + e);
                cleanupLayers(comp, before.layers);
                continue;
            }
            var after = snapshot(comp);
            var addedEffects = after.effects - before.effects;
            var addedKeys = after.keyProps - before.keyProps;
            var addedLayers = after.layers - before.layers;
            cleanupLayers(comp, before.layers);
            attempts.push(
                kind + "|effects+" + addedEffects + "|keys+" + addedKeys + "|layers+" + addedLayers
            );
            if (applied && (addedEffects > 0 || addedKeys > 0)) {
                var score = addedEffects * 10 + addedKeys * 3;
                if (!best || score > best.score) {
                    best = {
                        kind: kind,
                        score: score,
                        effects: addedEffects,
                        keys: addedKeys
                    };
                }
            }
        }

        if (!best) {
            return '{"status":"no_effect","attempts":[' +
                '"' + attempts.join(" ;; ").replace(/"/g, "'") + '"]}';
        }
        return '{"status":"ok","best":{"kind":' + jsonText(best.kind) +
            ',"effects":' + best.effects + ',"keys":' + best.keys +
            '},"attempts":[' + '"' + attempts.join(" ;; ").replace(/"/g, "'") + '"]}';
    }

    /**
     * 依赖检查：列出合成各图层用到的效果 matchName，
     * 并标出本机没装的效果（插件缺失）。
     */
    function dependenciesJson(compName) {
        var comp = null;
        try {
            comp = app.project.items.getItemByName(String(compName || ""));
        } catch (e) {}
        if (!comp) {
            return result("error", [["reason", "no_comp"]]);
        }
        var hasEffect = null;
        if (typeof AEV_Catalog !== "undefined") {
            try {
                hasEffect = AEV_Catalog.hasEffect;
            } catch (e0) {
                hasEffect = null;
            }
        }
        var layers = [];
        var missing = {};
        var total = 0;
        try {
            total = comp.numLayers;
        } catch (e3) {
            total = 0;
        }
        for (var l = 1; l <= total; l++) {
            var layer = null;
            try {
                layer = comp.layer(l);
            } catch (e4) {
                continue;
            }
            if (!layer) continue;
            var names = [];
            var parade = null;
            try {
                parade = layer.property("ADBE Effect Parade");
            } catch (e5) {
                parade = null;
            }
            if (parade) {
                var count = 0;
                try {
                    count = parade.numProperties;
                } catch (e6) {
                    count = 0;
                }
                for (var e = 1; e <= count; e++) {
                    var matchName = "";
                    try {
                        matchName = String(parade.property(e).matchName || "");
                    } catch (e7) {}
                    if (!matchName) continue;
                    names.push(matchName);
                    if (hasEffect && !hasEffect(matchName)) missing[matchName] = true;
                }
            }
            layers.push(
                '{"index":' + l + ',"name":' + jsonText(layer.name) +
                ',"effects":[' + names.join(",") + "]}"
            );
        }
        var missingList = [];
        for (var key in missing) {
            if (missing.hasOwnProperty(key)) missingList.push(jsonText(key));
        }
        return '{"status":"ok","layers":[' + layers.join(",") +
               '],"missing":[' + missingList.join(",") + "]}";
    }

    /**
     * AE 内置预设目录的候选路径。
     *
     * 实测 AE 2021 里 **app.path 是 undefined**（网上常见的写法在这版不成立），
     * 所以改为「扫 Program Files\Adobe 下的 Adobe After Effects * 目录」，
     * 取其中的 Support Files\Presets；app.path 作为兜底也一并列出。
     */
    function discoverRoots() {
        var found = [];
        var bases = ["C:/Program Files/Adobe", "D:/Program Files/Adobe", "C:/Program Files (x86)/Adobe"];
        for (var b = 0; b < bases.length; b++) {
            var base = new Folder(bases[b]);
            if (!base.exists) continue;
            var entries = [];
            try {
                entries = base.getFiles();
            } catch (e) {
                continue;
            }
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                if (!(entry instanceof Folder)) continue;
                // 目录名在 ExtendScript 里可能是 URL 编码形式
                // （实测 "Adobe After Effects 2021" 返回 "Adobe%20After%20Effects%202021"），
                // 所以不按名字挑，直接看有没有 Support Files/Presets —— 命中就是 AE 安装目录。
                var paths = [entry.fsName];
                try {
                    paths.push(decodeURI(entry.fsName));
                } catch (e2) {}
                for (var p = 0; p < paths.length; p++) {
                    var presets = new Folder(paths[p] + "/Support Files/Presets");
                    if (presets.exists) {
                        found.push(presets.fsName);
                        break;
                    }
                }
            }
        }
        try {
            if (app.path) {
                var byApp = new Folder(app.path + "/Presets");
                if (byApp.exists) found.push(byApp.fsName);
            }
        } catch (e2) {}
        return found;
    }

    function defaultRootJson() {
        var candidates = discoverRoots();
        var items = [];
        for (var i = 0; i < candidates.length; i++) {
            items.push('{"path":' + jsonText(candidates[i]) + ',"exists":true}');
        }
        return '{"status":"ok","candidates":[' + items.join(",") + "]}";
    }

    /**
     * 当前上下文：活动合成名 + 选中图层序号。
     * 应用预设必须知道往哪个合成的哪一层上加（T0.4：没有选中层时
     * applyPreset 会自己新建图层，把工程弄脏）。
     */
    function contextJson() {
        var compName = "";
        var layerIndex = 0;
        try {
            var comp = app.project.activeItem;
            if (comp && String(comp.typeName) === "Composition") {
                compName = String(comp.name);
                var selected = null;
                try {
                    selected = comp.selectedLayers;
                } catch (e) {
                    selected = null;
                }
                if (selected && selected.length > 0) {
                    try {
                        layerIndex = selected[0].index;
                    } catch (e2) {
                        layerIndex = 0;
                    }
                }
            }
        } catch (e3) {}
        return result("ok", [["comp", compName], ["layer", String(layerIndex)]]);
    }

    return {
        scanJson: scanJson,
        applyJson: applyJson,
        dependenciesJson: dependenciesJson,
        defaultRootJson: defaultRootJson,
        contextJson: contextJson,
        isPresetFile: isPresetFile,
        categoryOf: categoryOf,
        MAX_FILES: MAX_FILES,
        LAYER_ORDER: LAYER_ORDER
    };
})();
