// ============================================================
// preset_preview.jsx —— 预设预览渲染（M3 / T4.6）
//
// 用户要求：
//   · 静态预设 → 静态预览（1 帧）
//   · 含关键帧的预设 → 预览覆盖「第一个关键帧 → 最后一个关键帧」
//   · 生成背景由用户指定：内置几种，或自己上传图片
//
// 硬约束（都是实机踩过的）：
//   · 全程在**临时合成**里做，渲完 remove()，绝不碰用户工程
//   · 用 layer.applyPreset + layer.selected = true；应用级 applyPreset 与
//     给 comp.selectedLayers 赋值都会直接把 AE 弄崩
//   · 含第三方插件效果的预设在面板里**跳过**（面板与 AE 同进程），
//     改由 tools/run_plugin_preset_preview.jsx 在专用 AE 实例里逐条隔离渲染；
//     传 options.allowPlugins=true 即放行
//   · 索引写独立的 data/preset_manifest.json，不碰 L1 的 manifest.json
//     （后者会被引擎 writeManifest 整份重写）
//
// 语法：ES3 only。
// ============================================================

var AEV_PresetPreview = (function () {
    var VERSION = 1;
    var FPS = 6;                  // 动态预设每秒至少保留 6 帧
    var MAX_FRAMES = 36;          // 6 秒 × 6 fps
    var MAX_SPAN_SECONDS = 6;     // 关键帧跨度上限，避免渲出几百帧
    var MAX_PROPS = 900;          // 属性遍历上限，防止深树拖慢 AE

    var BUILTIN_BACKGROUNDS = [
        { id: "photo", name: "标准（色块＋文字＋细线）" },
        { id: "text", name: "文字（Dream / Engine）" },
        { id: "solid", name: "纯色" },
        { id: "shape", name: "形状（圆形）" },
        { id: "pattern", name: "高对比条纹" }
    ];

    function config() {
        if (typeof DREAM_ENGINE_RENDER_CONFIG !== "undefined" && DREAM_ENGINE_RENDER_CONFIG) {
            return DREAM_ENGINE_RENDER_CONFIG;
        }
        return { contactSheet: { cellSize: 128 }, animatedPreview: { frameCount: 36, fps: 6 } };
    }

    function pad(value, width) {
        var text = String(value);
        while (text.length < width) text = "0" + text;
        return text;
    }

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

    /** AE 返回的文件名是 URL 编码的（"%E8%83%8C%E6%99%AF"），不解码面板会显示乱码 */
    function displayName(name) {
        var text = String(name || "");
        try { text = decodeURI(text); } catch (e) {}
        return text;
    }

    function backgroundDir() {
        var dir = new Folder(Folder.myDocuments.fsName + "/DreamEngine/backgrounds");
        if (!dir.exists) dir.create();
        return dir;
    }

    function thumbDir(extensionPath) {
        var dir = new Folder(String(extensionPath || "") + "/data/thumbs");
        if (!dir.exists) dir.create();
        return dir;
    }

    /** 面板的背景下拉：内置 5 种 + 用户上传的图片 */
    function backgroundsJson() {
        var items = [];
        for (var i = 0; i < BUILTIN_BACKGROUNDS.length; i++) {
            items.push('{"id":' + jsonText(BUILTIN_BACKGROUNDS[i].id) +
                       ',"name":' + jsonText(BUILTIN_BACKGROUNDS[i].name) +
                       ',"builtin":true}');
        }
        var dir = backgroundDir();
        var files = [];
        try {
            files = dir.getFiles();
        } catch (e) {}
        for (var f = 0; f < files.length; f++) {
            var file = files[f];
            if (!(file instanceof File)) continue;
            var lower = String(file.name).toLowerCase();
            if (!/\.(png|jpg|jpeg|tif|tiff|bmp|psd|ai)$/.test(lower)) continue;
            items.push('{"id":' + jsonText(file.fsName) +
                       ',"name":' + jsonText(displayName(file.name)) + ',"builtin":false}');
        }
        return '{"status":"ok","items":[' + items.join(",") + "]}";
    }

    /** 把用户选的图片复制进背景目录（重名自动加序号） */
    function importBackgroundJson(path) {
        var src = new File(String(path || ""));
        if (!src.exists) return result("error", [["reason", "no_file"]]);
        var dir = backgroundDir();
        var target = new File(dir.fsName + "/" + src.name);
        var n = 1;
        while (target.exists) {
            var cut = String(src.name).lastIndexOf(".");
            var base = cut > 0 ? String(src.name).substring(0, cut) : String(src.name);
            var ext = cut > 0 ? String(src.name).substring(cut) : "";
            target = new File(dir.fsName + "/" + base + "_" + n + ext);
            n++;
        }
        try {
            src.copy(target);
        } catch (e) {
            return result("error", [["reason", "copy_failed"], ["detail", String(e)]]);
        }
        return '{"status":"ok","id":' + jsonText(target.fsName) +
               ',"name":' + jsonText(displayName(target.name)) + "}";
    }

    /** 面板把整份索引文本写盘（引擎侧不解析 JSON，避免 ES3 没有 JSON.parse） */
    function writeIndexJson(text, extensionPath) {
        var file = new File(String(extensionPath || "") + "/data/preset_manifest.json");
        try {
            file.encoding = "UTF-8";
            if (!file.open("w")) return result("error", [["reason", "open_failed"]]);
            file.write(String(text || ""));
            file.close();
        } catch (e) {
            try { file.close(); } catch (e2) {}
            return result("error", [["reason", "write_failed"], ["detail", String(e)]]);
        }
        return '{"status":"ok"}';
    }

    /** PNG 序列输出模板（与 previewgen.jsx 同一套） */
    function pngTemplate(outputModule) {
        var templates = outputModule.templates;
        for (var i = 0; i < templates.length; i++) {
            if (String(templates[i]).toLowerCase().indexOf("png") >= 0) return String(templates[i]);
        }
        return null;
    }

    /** 统计效果数与含关键帧的属性数（判断预设有没有真的落上去） */
    function snapshot(comp) {
        var effects = 0, keyProps = 0;
        var total = 0;
        try { total = comp.numLayers; } catch (e) { total = 0; }
        for (var i = 1; i <= total; i++) {
            var layer = null;
            try { layer = comp.layer(i); } catch (e2) { continue; }
            if (!layer) continue;
            var parade = null;
            try { parade = layer.property("ADBE Effect Parade"); } catch (e3) { continue; }
            if (!parade) continue;
            var count = 0;
            try { count = parade.numProperties; } catch (e4) { continue; }
            for (var e = 1; e <= count; e++) {
                effects++;
                var group = null;
                try { group = parade.property(e); } catch (e5) { continue; }
                if (!group) continue;
                var sub = 0;
                try { sub = group.numProperties; } catch (e6) { sub = 0; }
                for (var p = 1; p <= sub; p++) {
                    try {
                        var prop = group.property(p);
                        if (prop.numKeys && prop.numKeys > 0) keyProps++;
                    } catch (e7) {}
                }
            }
        }
        return { effects: effects, keyProps: keyProps };
    }

    /**
     * 遍历属性树收集关键帧时间。
     *
     * 只读 numKeys / keyTime —— 绝不读 hasMin / maxValue / value：
     * 实机验证过遍历时读插件参数值会让 AE 直接崩掉。
     */
    function walkKeys(group, depth, out) {
        if (depth > 5 || out.count > MAX_PROPS) return;
        var n = 0;
        try { n = group.numProperties; } catch (e) { return; }
        for (var i = 1; i <= n; i++) {
            var p = null;
            try { p = group.property(i); } catch (e2) { continue; }
            if (!p) continue;
            out.count++;
            if (out.count > MAX_PROPS) return;
            var keys = 0;
            try { keys = p.numKeys; } catch (e3) { keys = 0; }
            if (keys > 0) {
                try {
                    var t1 = Number(p.keyTime(1));
                    var t2 = Number(p.keyTime(keys));
                    if (!isNaN(t1) && !isNaN(t2)) {
                        if (t1 < out.min) out.min = t1;
                        if (t2 > out.max) out.max = t2;
                        out.keys++;
                    }
                } catch (e4) {}
            }
            var sub = 0;
            try { sub = p.numProperties; } catch (e5) { sub = 0; }
            if (sub > 0) walkKeys(p, depth + 1, out);
        }
    }

    function keyRange(comp) {
        var out = { min: 1e9, max: -1e9, keys: 0, count: 0 };
        var total = 0;
        try { total = comp.numLayers; } catch (e) { total = 0; }
        for (var i = 1; i <= total; i++) {
            var layer = null;
            try { layer = comp.layer(i); } catch (e2) { continue; }
            if (layer) walkKeys(layer, 0, out);
        }
        return out;
    }

    /** 收集预设用到的第三方插件效果 matchName（只读名字，不碰参数值） */
    function pluginMatchNames(comp) {
        var found = [];
        var total = 0;
        try { total = comp.numLayers; } catch (e) { total = 0; }
        for (var i = 1; i <= total; i++) {
            var layer = null;
            try { layer = comp.layer(i); } catch (e2) { continue; }
            if (!layer) continue;
            var parade = null;
            try { parade = layer.property("ADBE Effect Parade"); } catch (e3) { continue; }
            if (!parade) continue;
            var count = 0;
            try { count = parade.numProperties; } catch (e4) { continue; }
            for (var e = 1; e <= count; e++) {
                var group = null;
                try { group = parade.property(e); } catch (e5) { continue; }
                if (!group) continue;
                var mn = "";
                try { mn = String(group.matchName || ""); } catch (e6) {}
                if (!mn) continue;
                if (typeof AEV_Recipe !== "undefined" && AEV_Recipe.isBuiltinMatch) {
                    if (!AEV_Recipe.isBuiltinMatch(mn)) found.push(mn);
                }
            }
        }
        return found;
    }

    function selectOnly(comp, layer) {
        var total = 0;
        try { total = comp.numLayers; } catch (e) { total = 0; }
        for (var i = 1; i <= total; i++) {
            try { comp.layer(i).selected = false; } catch (e2) {}
        }
        try { layer.selected = true; } catch (e3) {}
    }

    /** 搭背景层：内置素材 comp 或用户上传的图片 */
    function addBackground(comp, background, size, trash) {
        var id = String(background || "photo");
        var isCustom = id.indexOf("/") >= 0 || id.indexOf("\\") >= 0;
        if (!isCustom) {
            var asset = null;
            try {
                asset = (typeof AEV_Assets !== "undefined")
                    ? AEV_Assets.getFresh(id, size)
                    : null;
            } catch (e) {}
            if (!asset) return null;
            trash.comps.push(asset);
            var nested = comp.layers.add(asset);
            nested.moveToEnd();
            return nested;
        }
        var file = new File(id);
        if (!file.exists) return null;
        var imported = null;
        try {
            imported = app.project.importFile(new ImportOptions(file));
        } catch (e2) {
            return null;
        }
        if (!imported) return null;
        trash.items.push(imported);
        var layer = comp.layers.add(imported);
        layer.moveToEnd();
        // 等比铺满，多余部分裁掉（预览是方形）
        try {
            var w = Number(imported.width) || size;
            var h = Number(imported.height) || size;
            var scale = Math.max(size / w, size / h) * 100;
            layer.property("ADBE Transform Group").property("ADBE Scale").setValue([scale, scale]);
        } catch (e3) {}
        return layer;
    }

    /**
     * 渲染一个预设的预览。
     *
     * presetPath  .ffx 路径
     * sheetIndex  稳定编号（决定输出文件名 preset_<n>_####.png）
     * options     { extensionPath, background, cellSize }
     */
    function renderJson(presetPath, sheetIndex, options) {
        var opts = options || {};
        var conf = config();
        var size = Number(opts.cellSize) || conf.contactSheet.cellSize || 128;
        var background = String(opts.background || "photo");
        var allowPlugins = !!opts.allowPlugins;
        var extensionPath = String(opts.extensionPath || "");
        var file = new File(String(presetPath || ""));
        if (!file.exists) return result("error", [["reason", "no_preset"]]);
        if (!extensionPath) return result("error", [["reason", "no_extension_path"]]);

        var folder = thumbDir(extensionPath);
        if (!folder || !folder.exists) return result("error", [["reason", "no_output_folder"]]);
        if (typeof AEV_Store !== "undefined" && AEV_Store.writePermission() === 0) {
            return result("error", [["reason", "script_write_disabled"]]);
        }

        var baseName = "preset_" + pad(sheetIndex, 3);
        var rawBase = baseName + "_raw";
        var trash = { comps: [], items: [] };
        var comp = null;
        var queueItem = null;
        var rawFiles = [];
        var kept = [];

        /** 清掉上一次的成品帧：帧数变少时残留高位帧会被面板误当有效帧 */
        function clearKeptFrames() {
            var all = folder.getFiles();
            if (!all) return;
            var re = new RegExp("^" + baseName + "_\\d{4}\\.png$");
            for (var i = 0; i < all.length; i++) {
                if (!(all[i] instanceof File)) continue;
                if (!re.test(String(all[i].name))) continue;
                try { all[i].remove(); } catch (e) {}
            }
        }

        clearKeptFrames();
        try {
            // 时长先给足，后面按关键帧范围调整
            comp = app.project.items.addComp(
                "DE_preset_cell_" + pad(sheetIndex, 3),
                size, size, 1, 2, FPS
            );
            comp.time = 0; // applyPreset 会把关键帧放在当前时间指示器上

            var bgLayer = addBackground(comp, background, size, trash);
            if (!bgLayer) return result("error", [["reason", "bad_background"]]);

            var before = snapshot(comp);
            try {
                selectOnly(comp, bgLayer);
                bgLayer.applyPreset(file);
            } catch (eApply) {
                return result("error", [["reason", "apply_failed"], ["detail", String(eApply)]]);
            }
            var after = snapshot(comp);
            if (after.effects <= before.effects && after.keyProps <= before.keyProps) {
                // 文本类预设落在纯色/素材层上会静默无效 —— 垫一个文字层再试。
                // 背景仍在底层可见，文字层只占中间一小块。
                try {
                    var textLayer = comp.layers.addText("PRESET");
                    var tp = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
                    var doc = tp.value;
                    doc.fontSize = Math.round(size * 0.16);
                    doc.fillColor = [0.93, 0.94, 0.9];
                    tp.setValue(doc);
                    textLayer.property("ADBE Transform Group").property("ADBE Position")
                        .setValue([size / 2, size / 2]);
                    selectOnly(comp, textLayer);
                    textLayer.applyPreset(file);
                    after = snapshot(comp);
                } catch (eText) {}
            }
            if (after.effects <= before.effects && after.keyProps <= before.keyProps) {
                return result("no_effect", [["reason", "preset_did_not_apply"]]);
            }

            // 面板里默认不渲插件预设（面板和 AE 同进程，混渲会杀宿主）；
            // 离线专用 AE 实例传 allowPlugins=true，逐条隔离渲染就安全。
            var plugins = pluginMatchNames(comp);
            if (plugins.length > 0 && !allowPlugins) {
                return result("plugin_preset", [
                    ["reason", "third_party_plugin"],
                    ["matchName", plugins.join(",")]
                ]);
            }

            var range = keyRange(comp);
            var animated = range.keys > 0 && (range.max - range.min) > 1 / FPS;
            var start = 0;
            var span = 1 / FPS;
            var truncated = false;
            var keyStart = 0;
            var keyEnd = 0;
            if (animated) {
                start = range.min;
                keyStart = range.min;
                keyEnd = range.max;
                var end = Math.min(range.max, range.min + MAX_SPAN_SECONDS);
                truncated = range.max > end;
                span = Math.max(1 / FPS, end - start);
            } else {
                keyStart = 0;
                keyEnd = 0;
            }

            // comp 必须覆盖到最后一个关键帧，否则超出的部分渲不出来
            try {
                comp.duration = Math.max(1 / FPS, start + span + 1 / FPS);
            } catch (eDur) {}

            queueItem = app.project.renderQueue.items.add(comp);
            var outputModule = queueItem.outputModule(1);
            var template = pngTemplate(outputModule);
            if (!template) return result("error", [["reason", "no_png_template"]]);
            outputModule.applyTemplate(template);
            outputModule.file = new File(folder.fsName + "/" + rawBase + "_[####].png");
            queueItem.timeSpanStart = start;
            queueItem.timeSpanDuration = span;
            app.project.renderQueue.render();

            // 渲染队列按 6 fps 输出；6 秒最多保留 36 帧，避免被压缩成快放
            rawFiles = folder.getFiles(rawBase + "_*.png");
            if (!rawFiles || rawFiles.length === 0) {
                return result("error", [["reason", "no_frames"]]);
            }
            rawFiles.sort(function (a, b) {
                return String(a.name) < String(b.name) ? -1 : 1;
            });
            var wanted = animated ? Math.min(MAX_FRAMES, rawFiles.length) : 1;
            for (var k = 0; k < wanted; k++) {
                var idx = wanted === 1
                    ? Math.floor(rawFiles.length / 2)
                    : Math.round(k * (rawFiles.length - 1) / (wanted - 1));
                var srcFile = rawFiles[idx];
                var dest = new File(folder.fsName + "/" + baseName + "_" + pad(k, 4) + ".png");
                try {
                    srcFile.copy(dest);
                    kept.push(dest.name);
                } catch (eCopy) {}
            }
            if (kept.length === 0) return result("error", [["reason", "copy_frames_failed"]]);

            return result("ok", [
                ["sheet", String(sheetIndex)],
                ["frames", String(kept.length)],
                ["animated", animated ? "true" : "false"],
                ["keyStart", String(Math.round(keyStart * 1000) / 1000)],
                ["keyEnd", String(Math.round(keyEnd * 1000) / 1000)],
                ["duration", String(Math.round(span * 1000) / 1000)],
                ["fps", String(FPS)],
                ["truncated", truncated ? "true" : "false"],
                ["background", background],
                ["plugins", plugins.join(",")],
                ["files", kept.join(",")]
            ]);
        } catch (e) {
            return result("error", [
                ["reason", "render_failed:" + (e && e.message ? String(e.message) : String(e))]
            ]);
        } finally {
            // 只清 raw 与临时对象；成品帧已在渲染前清过、本次刚生成，不能删
            try { if (queueItem) queueItem.remove(); } catch (eQ) {}
            try { if (comp) comp.remove(); } catch (eC) {}
            var i;
            for (i = 0; i < trash.comps.length; i++) {
                try { trash.comps[i].remove(); } catch (eT1) {}
            }
            for (i = 0; i < trash.items.length; i++) {
                try { trash.items[i].remove(); } catch (eT2) {}
            }
            for (i = 0; i < rawFiles.length; i++) {
                try { if (rawFiles[i].exists) rawFiles[i].remove(); } catch (eT3) {}
            }
        }
    }

    return {
        VERSION: VERSION,
        backgroundsJson: backgroundsJson,
        importBackgroundJson: importBackgroundJson,
        writeIndexJson: writeIndexJson,
        renderJson: renderJson,
        BUILTIN_BACKGROUNDS: BUILTIN_BACKGROUNDS,
        MAX_FRAMES: MAX_FRAMES
    };
})();
