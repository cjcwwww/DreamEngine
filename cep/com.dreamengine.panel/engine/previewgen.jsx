// ============================================================
// previewgen.jsx —— 运行时预览生成
//
// 核心策略（来自 M0 实测）：
//   · 逐效果各调一次 renderQueue.render() 的成本主要是队列启动开销
//     （T0.2 实测 16 次 ≈ 16.55 秒，单帧渲染本身只占很小一部分）
//     因此批量一律走 contact sheet：一张 8×8 网一次渲染出 N 帧
//   · OutputModule 的 Format 只读，必须通过 applyTemplate 切到
//     "DreamEngine PNG Sequence"，找不到 PNG 模板时直接失败，不兜底到其它格式
//   · 临时合成清理只用 remove()，不依赖 Ctrl+Z（copyToComp 的 undo 崩溃警告）
//
// 依赖：render_config.jsx、store.jsx、recipe.jsx
// 语法：ES3 only。
// ============================================================

var AEV_PreviewGen = (function () {
    var FALLBACK_CONFIG = {
        contactSheet: { columns: 8, cellSize: 256, width: 2048, height: 2048, effectsPerSheet: 64 },
        animatedPreview: { frameCount: 6, fps: 12 },
        render: { pngOutputTemplate: "DreamEngine PNG Sequence" }
    };

    function config() {
        if (typeof DREAM_ENGINE_RENDER_CONFIG !== "undefined" && DREAM_ENGINE_RENDER_CONFIG) {
            return DREAM_ENGINE_RENDER_CONFIG;
        }
        return FALLBACK_CONFIG;
    }

    function pad(value, width) {
        var text = String(value);
        while (text.length < width) text = "0" + text;
        return text;
    }

    /** 计算需要几张网、多少帧、多少格 —— 纯计算，便于测试与 UI 预估 */
    function plan(effectCount) {
        var conf = config();
        var perSheet = conf.contactSheet.effectsPerSheet;
        var frames = conf.animatedPreview.frameCount;
        var sheets = Math.ceil(effectCount / perSheet);
        return {
            effects: effectCount,
            perSheet: perSheet,
            sheets: sheets,
            frames: frames,
            cells: effectCount,
            totalRenders: sheets * frames
        };
    }

    function pngTemplate(outputModule) {
        var templates = outputModule.templates;
        for (var i = 0; i < templates.length; i++) {
            var name = String(templates[i]);
            if (name.toLowerCase().indexOf("png") >= 0) return name;
        }
        return null;
    }

    /** 标准素材场景：深色底 + 青色块 + 暖色块 + 文字，能同时体现模糊、发光、变形、调色 */
    function buildScene(size) {
        var scene = app.project.items.addComp("DE_scene_" + size, size, size, 1, 1, 30);

        var bg = scene.layers.addSolid([0.055, 0.065, 0.075], "bg", size, size, 1);
        bg.moveToEnd();

        var accent = scene.layers.addSolid([0.18, 0.68, 0.76], "accent", size * 0.59, size * 0.35, 1);
        accent.property("ADBE Transform Group").property("ADBE Position")
            .setValue([size * 0.5, size * 0.52]);

        var warm = scene.layers.addSolid([0.86, 0.32, 0.18], "warm", size * 0.23, size * 0.23, 1);
        warm.property("ADBE Transform Group").property("ADBE Position")
            .setValue([size * 0.28, size * 0.3]);

        var text = scene.layers.addText("AE");
        var textProp = text.property("ADBE Text Properties").property("ADBE Text Document");
        var doc = textProp.value;
        doc.fontSize = size * 0.25;
        doc.fillColor = [0.94, 0.94, 0.92];
        textProp.setValue(doc);
        text.property("ADBE Transform Group").property("ADBE Position")
            .setValue([size * 0.5, size * 0.57]);

        return scene;
    }

    function placeCell(grid, cellLayer, index, columns, cellSize) {
        var col = index % columns;
        var row = Math.floor(index / columns);
        try {
            cellLayer.property("ADBE Transform Group").property("ADBE Position")
                .setValue([col * cellSize + cellSize / 2, row * cellSize + cellSize / 2]);
        } catch (e) {
            return "ERR:定位失败";
        }
        return "OK";
    }

    /** 输出目录：默认写用户目录 cache/thumbs；dev 模式写扩展 data/thumbs */
    function outputFolder(options) {
        var mode = options && options.outputRoot ? options.outputRoot : "user";
        if (mode === "extension" && options && options.extensionPath) {
            return new Folder(options.extensionPath + "/data/thumbs");
        }
        if (typeof AEV_Store === "undefined") return null;
        var folder = AEV_Store.folderAt("cache/thumbs");
        if (folder && !folder.exists) folder.create();
        return folder;
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

    /**
     * 批量渲染一张 contact sheet。
     * matchNames：本次要渲的 matchName 数组（不超过每网格数）
     * sheetIndex：第几张网，决定输出文件名
     * options：{ extensionPath, outputRoot: "user"|"extension", startTime }
     */
    function renderBatch(matchNames, sheetIndex, options) {
        if (!matchNames || matchNames.length === 0) {
            return result("error", [["reason", "empty_batch"]]);
        }

        var conf = config();
        var columns = conf.contactSheet.columns;
        var cellSize = conf.contactSheet.cellSize;
        var width = conf.contactSheet.width;
        var height = conf.contactSheet.height;
        var frames = conf.animatedPreview.frameCount;
        var fps = conf.animatedPreview.fps;
        var templateName = conf.render.pngOutputTemplate;

        if (typeof AEV_Store !== "undefined") {
            var permission = AEV_Store.writePermission();
            if (permission === 0) {
                return result("error", [["reason", "script_write_disabled"]]);
            }
        }

        var targetFolder = outputFolder(options);
        if (!targetFolder) return result("error", [["reason", "no_output_folder"]]);
        if (!targetFolder.exists && !targetFolder.create()) {
            return result("error", [["reason", "cannot_create_output_folder"]]);
        }

        var scene = null;
        var cells = [];
        var grid = null;
        var queueItem = null;
        var started = new Date().getTime();

        try {
            scene = buildScene(cellSize);

            grid = app.project.items.addComp(
                "DE_sheet_" + pad(sheetIndex, 3),
                width, height, 1, frames / fps, 30
            );

            for (var i = 0; i < matchNames.length && i < columns * columns; i++) {
                var matchName = matchNames[i];
                var cell = app.project.items.addComp(
                    "DE_cell_" + pad(sheetIndex, 3) + "_" + pad(i, 2),
                    cellSize, cellSize, 1, frames / fps, 30
                );
                var layer = cell.layers.add(scene);
                var effectGroup = layer.property("ADBE Effect Parade").addProperty(matchName);
                if (typeof AEV_Recipe !== "undefined") {
                    AEV_Recipe.apply(effectGroup, matchName, cellSize);
                }
                var placedLayer = grid.layers.add(cell);
                placedLayer.moveToEnd();
                placeCell(grid, placedLayer, i, columns, cellSize);
                cells.push(cell);
            }

            queueItem = app.project.renderQueue.items.add(grid);
            var outputModule = queueItem.outputModule(1);
            var template = pngTemplate(outputModule);
            if (!template) {
                throw new Error("no_png_template");
            }
            outputModule.applyTemplate(template);

            var baseName = "batch_" + pad(sheetIndex, 3);
            outputModule.file = new File(targetFolder.fsName + "/" + baseName + "_[####].png");

            var requestedStart = options && options.startTime !== undefined ? options.startTime : 0;
            queueItem.timeSpanStart = requestedStart;
            queueItem.timeSpanDuration = frames / fps;

            app.project.renderQueue.render();

            var files = [];
            for (var f = 0; f < frames; f++) {
                var frameFile = new File(targetFolder.fsName + "/" + baseName + "_" + pad(f, 4) + ".png");
                if (frameFile.exists) files.push(frameFile.name);
            }

            var elapsed = (new Date().getTime() - started) / 1000;
            var detail = [
                ["reason", ""],
                ["sheet", baseName],
                ["folder", targetFolder.fsName],
                ["cells", String(cells.length)],
                ["frames", String(files.length)],
                ["seconds", String(Math.round(elapsed * 100) / 100)],
                ["template", template],
                ["files", files.join(",")]
            ];
            return result(files.length > 0 ? "ok" : "error", detail);
        } catch (e) {
            var message = e && e.message ? String(e.message) : String(e);
            return result("error", [["reason", "render_failed:" + message]]);
        } finally {
            try {
                if (queueItem) queueItem.remove();
            } catch (e1) {}
            for (var c = 0; c < cells.length; c++) {
                try { cells[c].remove(); } catch (e2) {}
            }
            try {
                if (grid) grid.remove();
            } catch (e3) {}
            try {
                if (scene) scene.remove();
            } catch (e4) {}
        }
    }

    /** 单效果单帧渲染，用于调试；正常批量不要走这条路径 */
    function renderOne(matchName, options) {
        return renderBatch([matchName], 999, options);
    }

    /**
     * 重写 manifest.json。
     *
     * 为什么由 jsx 来写：CEP 侧没有文件写能力（只有 XHR 读），而 manifest 必须
     * 落在扩展目录里才能被相对路径加载。jsx 侧手工拼 JSON 是本项目既定做法
     * （catalog.jsx 同样如此），不引入 JSON 库。
     *
     * entriesTsv 每行 5 列：
     *   matchName \t sheet \t cell \t frames \t frameTemplate
     * frameTemplate 为空表示单文件预览（src = thumbs/batch_XXX.png）
     */
    function writeManifest(entriesTsv, extensionPath) {
        var conf = config();
        var columns = conf.contactSheet.columns;
        var cellSize = conf.contactSheet.cellSize;
        var width = conf.contactSheet.width;
        var height = conf.contactSheet.height;

        var rows = [];
        var lines = String(entriesTsv || "").split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            var parts = lines[i].split("\t");
            if (parts.length < 4) continue;
            rows.push({
                matchName: parts[0],
                sheet: parseInt(parts[1], 10) || 0,
                cell: parseInt(parts[2], 10) || 0,
                frames: parseInt(parts[3], 10) || 1,
                frameTemplate: parts.length > 4 ? parts[4] : ""
            });
        }
        if (rows.length === 0) return result("error", [["reason", "empty_manifest"]]);

        // 按 sheet、cell 稳定排序（插入排序足够：量级是几十到几百条）
        for (var a = 1; a < rows.length; a++) {
            var current = rows[a];
            var b = a - 1;
            while (b >= 0 && (rows[b].sheet > current.sheet ||
                   (rows[b].sheet === current.sheet && rows[b].cell > current.cell))) {
                rows[b + 1] = rows[b];
                b--;
            }
            rows[b + 1] = current;
        }

        var items = [];
        var sheetsSeen = {};
        var sheets = [];
        for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            var fileName = "batch_" + pad(row.sheet, 3) + ".png";
            var src = row.frameTemplate ? "" : ("thumbs/" + fileName);
            var frameSrc = row.frameTemplate || "";
            var parts2 = ['"matchName":' + jsonText(row.matchName)];
            parts2.push('"sheet":' + row.sheet);
            parts2.push('"x":' + ((row.cell % columns) * cellSize));
            parts2.push('"y":' + (Math.floor(row.cell / columns) * cellSize));
            parts2.push('"width":' + cellSize + ',"height":' + cellSize);
            parts2.push('"frames":' + row.frames);
            if (src) parts2.push('"src":' + jsonText(src));
            if (frameSrc) parts2.push('"frameSrc":' + jsonText(frameSrc));
            items.push("{" + parts2.join(",") + "}");

            if (!sheetsSeen[String(row.sheet)]) {
                sheetsSeen[String(row.sheet)] = true;
                sheets.push("{\"index\":" + row.sheet + ",\"src\":" +
                            jsonText("thumbs/" + fileName) + ",\"width\":" + width +
                            ",\"height\":" + height + "}");
            }
        }

        var manifest = '{"version":2,"cellSize":' + cellSize +
            ',"columns":' + columns + ',"width":' + width + ',"height":' + height +
            ',"sheets":[' + sheets.join(",") + '],"items":[' + items.join(",") + "]}";

        var target = new File(String(extensionPath) + "/data/manifest.json");
        target.encoding = "UTF-8";
        if (!target.open("w")) {
            return result("error", [["reason", "manifest_open_failed:" + target.fsName]]);
        }
        target.write(manifest);
        target.close();
        return result("ok", [["items", String(items.length)], ["path", target.fsName]]);
    }

    return {
        config: config,
        plan: plan,
        pngTemplate: pngTemplate,
        buildScene: buildScene,
        renderBatch: renderBatch,
        renderOne: renderOne,
        writeManifest: writeManifest
    };
})();
