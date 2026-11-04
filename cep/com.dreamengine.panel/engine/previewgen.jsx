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

    /** 标准素材场景：深色底 + 青色块 + 暖色块 + 文字，能同时体现模糊、发光、变形、调色。
     *  注意：addSolid 的 width/height 必须是整数，AE 2021 会以
     *  "151.04 不是整数" 直接抛错，所以比例尺寸一律 Math.round。
     */
    function buildScene(size) {
        var scene = app.project.items.addComp("DE_scene_" + size, size, size, 1, 1, 30);

        var bg = scene.layers.addSolid([0.055, 0.065, 0.075], "bg", size, size, 1);
        bg.moveToEnd();

        var accentW = Math.round(size * 0.59);
        var accentH = Math.round(size * 0.35);
        var accent = scene.layers.addSolid([0.18, 0.68, 0.76], "accent", accentW, accentH, 1);
        accent.property("ADBE Transform Group").property("ADBE Position")
            .setValue([Math.round(size * 0.5), Math.round(size * 0.52)]);

        var warmSide = Math.round(size * 0.23);
        var warm = scene.layers.addSolid([0.86, 0.32, 0.18], "warm", warmSide, warmSide, 1);
        warm.property("ADBE Transform Group").property("ADBE Position")
            .setValue([Math.round(size * 0.28), Math.round(size * 0.3)]);

        var text = scene.layers.addText("AE");
        var textProp = text.property("ADBE Text Properties").property("ADBE Text Document");
        var doc = textProp.value;
        doc.fontSize = Math.round(size * 0.25);
        doc.fillColor = [0.94, 0.94, 0.92];
        textProp.setValue(doc);
        text.property("ADBE Transform Group").property("ADBE Position")
            .setValue([Math.round(size * 0.5), Math.round(size * 0.57)]);

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
     * options：{ extensionPath, outputRoot, startTime, cellOffset, singleCell }
     *   cellOffset —— 本批从网格第几格开始摆。整张新网传 0；
     *   往已有网里补空位时才用得上（要与 manifest 里的 cell 编号一致）。
     *   singleCell —— 插件 L2 预览专用：1×1 单格网，输出 128×128 帧序列，
     *   不与其它效果混渲（第三方插件混渲会直接杀掉 AE 进程）。
     */
    function renderBatch(matchNames, sheetIndex, options) {
        if (!matchNames || matchNames.length === 0) {
            return result("error", [["reason", "empty_batch"]]);
        }

        var conf = config();
        var cellSize = conf.contactSheet.cellSize;
        // 插件 L2 预览走 singleCell：一张图只渲一个格子（128×128），
        // 不必为一条效果生成一整张 1024×1024 的网。默认路径完全不变。
        var singleCell = !!(options && options.singleCell);
        var columns = singleCell ? 1 : conf.contactSheet.columns;
        var width = singleCell ? cellSize : conf.contactSheet.width;
        var height = singleCell ? cellSize : conf.contactSheet.height;
        var frames = conf.animatedPreview.frameCount;

        // 合成帧率固定 30，而 config 里的 fps(12) 只是面板播放帧率。
        // 两者混用会把"6 帧"算成 0.5 秒 → 30fps 下实际渲出 15 帧（实测踩过）。
        var CELL_FPS = 30;
        var durationSeconds = frames / CELL_FPS;
        var cellOffset = singleCell ? 0 : ((options && options.cellOffset) || 0);

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

        var scenes = {};
        var cells = [];
        var cellErrors = [];
        var grid = null;
        var queueItem = null;
        var started = new Date().getTime();

        /** 按素材类型取（必要时生成）标准素材；同一批内复用同一个 comp */
        function sceneOf(kind) {
            if (!scenes[kind]) {
                scenes[kind] = (typeof AEV_Assets !== "undefined")
                    ? AEV_Assets.get(kind, cellSize)
                    : buildScene(cellSize);
            }
            return scenes[kind];
        }

        try {
            grid = app.project.items.addComp(
                "DE_sheet_" + pad(sheetIndex, 3),
                width, height, 1, durationSeconds, CELL_FPS
            );

            for (var i = 0; i < matchNames.length; i++) {
                var cellIndex = cellOffset + i;
                if (cellIndex >= columns * columns) break;
                var matchName = matchNames[i];
                var cell = app.project.items.addComp(
                    "DE_cell_" + pad(sheetIndex, 3) + "_" + pad(cellIndex, 2),
                    cellSize, cellSize, 1, durationSeconds, CELL_FPS
                );

                // 场景决定临时合成怎么搭（设计文档 §4.3 的八类枚举）：
                //   文本类必须落在文本层，否则文本效果静默失效；
                //   两层输入类必须在下面垫背景 + 高对比图案，否则效果加上了但画面不变。
                // AE 里图层 1 在最上面，后 add 的盖在前面，所以按「背景 → 图案 → 效果层」
                // 的顺序添加，就得到 [effect, pattern, bg] 这个目标叠层。
                var layout = { base: "photo", needBg: false, needSource: false };
                if (typeof AEV_Recipe !== "undefined") {
                    layout = AEV_Recipe.layoutFor(AEV_Recipe.sceneFor(matchName));
                }
                if (layout.needBg) {
                    // 背景层刻意用「纯色」而不是 photo：遮罩/填充把上层吃掉一部分时，
                    // 露出来的必须是明显不同的颜色，否则下面垫着同样的画面，
                    // 透明和透明+相同背景看起来一模一样，等于白垫。
                    cell.layers.add(sceneOf("solid"));
                }
                if (layout.needSource) {
                    var sourceLayer = cell.layers.add(sceneOf("pattern"));
                    // 第二输入层必须关掉可见性——这是 AE 里用置换/遮罩图层的标准做法：
                    // 它只作为输入参与运算，不该出现在画面上。留着可见会把效果结果盖住。
                    try {
                        sourceLayer.enabled = false;
                    } catch (eSrc) {}
                }
                var layer = cell.layers.add(sceneOf(layout.base));

                // 逐格独立保护：addProperty 与配方各自捕获。
                // 这样"效果加不上"或"参数设不上"能定位到具体 matchName，
                // 而不是整批失败只回一条 AE 错误。
                var effectGroup = null;
                // noEffect：只放素材、不加效果，渲出「素材原样」当对照图。
                // 插件预览首轮就栽在这里——渲出来的图与素材逐像素相同，
                // 必须能区分「效果没生效」和「效果生效但看不出差别」。
                var bareScene = !!(options && options.noEffect);
                if (!bareScene) {
                    try {
                        // 有替代方案时挂替代效果（Lumetri 渲染会挂死，用饱和度调整代表）
                        var effectName = (typeof AEV_Recipe !== "undefined")
                            ? AEV_Recipe.effectNameFor(matchName)
                            : matchName;
                        effectGroup = layer.property("ADBE Effect Parade").addProperty(effectName);
                    } catch (eAdd) {
                        cellErrors.push(matchName + "|addProperty|" + eAdd);
                        try { cell.remove(); } catch (eRm) {}
                        continue;
                    }
                }
                try {
                    if (effectGroup && typeof AEV_Recipe !== "undefined") {
                        var applied = AEV_Recipe.apply(effectGroup, matchName, cellSize);
                        // 两层输入类：把「图层」选择器接到第 2 层（图案层），
                        // 默认值是「无」，不接的话效果等于没加。
                        if (layout.needSource) {
                            AEV_Recipe.bindLayers(effectGroup, 2);
                        }
                        // 给主参数打关键帧，让 6 帧真正有差异。
                        // AE 效果默认不随时间变化，不打关键帧的话 6 帧逐像素相同，
                        // 缩略图轮播就是静止画面（实测 60 条里 59 条如此）。
                        if (applied && applied.mode === "recipe") {
                            AEV_Recipe.animate(effectGroup, matchName, durationSeconds);
                        } else {
                            // 走启发式的效果同样要动起来，否则大半缩略图是静止的
                            AEV_Recipe.animateAny(effectGroup, durationSeconds);
                        }
                    }
                } catch (eRecipe) {
                    cellErrors.push(matchName + "|recipe|" + eRecipe);
                }

                var placedLayer = grid.layers.add(cell);
                placedLayer.moveToEnd();
                placeCell(grid, placedLayer, cellIndex, columns, cellSize);
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

            // 清掉同名历史帧：上一次渲染帧数与本次不同时（比如改过 frameCount），
            // 残留的高位帧会被面板误当成有效帧轮播。
            var stale = targetFolder.getFiles(baseName + "_*.png");
            for (var s = 0; s < stale.length; s++) {
                if (stale[s] instanceof File) {
                    try { stale[s].remove(); } catch (eStale) {}
                }
            }

            outputModule.file = new File(targetFolder.fsName + "/" + baseName + "_[####].png");

            var requestedStart = options && options.startTime !== undefined ? options.startTime : 0;
            queueItem.timeSpanStart = requestedStart;
            queueItem.timeSpanDuration = durationSeconds;

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
                ["cellErrors", cellErrors.join(" ;; ")],
                ["files", files.join(",")]
            ];
            return result(files.length > 0 ? "ok" : "error", detail);
        } catch (e) {
            var message = e && e.message ? String(e.message) : String(e);
            return result("error", [
                ["reason", "render_failed:" + message],
                ["cellErrors", cellErrors.join(" ;; ")]
            ]);
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
            // 标准素材（scenes）刻意不删：它们由 AEV_Assets 缓存，跨批次复用，
            // 每批重建会让 64 格的批量生成慢上一个数量级。
        }
    }

    /** 单效果单帧渲染，用于调试；正常批量不要走这条路径 */
    function renderOne(matchName, options) {
        return renderBatch([matchName], 999, options);
    }

    /**
     * 单条预览的缓存指纹（设计文档 §4.5）。
     * 参与因子：matchName + 配方版本 + 素材类型与素材版本 + 格子尺寸 + 帧数。
     * AE 版本号刻意不参与——否则每次升级 AE 都要全量重渲。
     *
     * 素材指纹带上 kind：photo 与 pattern 用同一张网时，换素材不会误判命中。
     */
    function itemKey(matchName, cellSize, frames) {
        if (typeof AEV_Recipe === "undefined") return "";
        var kind = AEV_Recipe.assetKindFor(AEV_Recipe.sceneFor(matchName));
        var assetVersion = (typeof AEV_Assets !== "undefined") ? AEV_Assets.fingerprint() : "na";
        return AEV_Recipe.cacheKey(matchName, kind + "@" + assetVersion, cellSize, frames);
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
     *
     * 同时把同样的条目写一份 data/previews.tsv（多带 cacheKey 一列）：
     * json 给 CEF 读，tsv 给 ExtendScript 读——ExtendScript 没有 JSON.parse，
     * 校验缓存是否过期必须在 AE 侧做，所以需要这份可被 split 的副本。
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
        var indexRows = ["matchName\tsheet\tcell\tframes\tframeTemplate\tkey"];
        for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            var fileName = "batch_" + pad(row.sheet, 3) + ".png";
            var src = row.frameTemplate ? "" : ("thumbs/" + fileName);
            var frameSrc = row.frameTemplate || "";
            var key = itemKey(row.matchName, cellSize, row.frames);
            var parts2 = ['"matchName":' + jsonText(row.matchName)];
            parts2.push('"sheet":' + row.sheet);
            parts2.push('"x":' + ((row.cell % columns) * cellSize));
            parts2.push('"y":' + (Math.floor(row.cell / columns) * cellSize));
            parts2.push('"width":' + cellSize + ',"height":' + cellSize);
            parts2.push('"frames":' + row.frames);
            if (key) parts2.push('"key":' + jsonText(key));
            if (src) parts2.push('"src":' + jsonText(src));
            if (frameSrc) parts2.push('"frameSrc":' + jsonText(frameSrc));
            items.push("{" + parts2.join(",") + "}");
            indexRows.push([
                row.matchName.replace(/\t/g, " "),
                String(row.sheet),
                String(row.cell),
                String(row.frames),
                row.frameTemplate,
                key
            ].join("\t"));

            if (!sheetsSeen[String(row.sheet)]) {
                sheetsSeen[String(row.sheet)] = true;
                // 帧序列网的实体文件是 batch_XXX_0000.png，不是 batch_XXX.png；
                // sheets.src 必须指向真实存在的文件，否则按 sheet 取图会 404。
                var sheetFile = row.frames > 1
                    ? ("batch_" + pad(row.sheet, 3) + "_0000.png")
                    : ("batch_" + pad(row.sheet, 3) + ".png");
                sheets.push("{\"index\":" + row.sheet + ",\"src\":" +
                            jsonText("thumbs/" + sheetFile) + ",\"width\":" + width +
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

        var indexFile = new File(String(extensionPath) + "/data/previews.tsv");
        indexFile.encoding = "UTF-8";
        if (indexFile.open("w")) {
            indexFile.write(indexRows.join("\r\n"));
            indexFile.close();
        }

        return result("ok", [["items", String(items.length)], ["path", target.fsName]]);
    }

    /**
     * 校验缓存：把 previews.tsv 里每条的指纹与当前配方/素材/尺寸重算的结果对比。
     * 返回 {"checked":N,"stale":["matchName",...]}。
     *
     * 这是「改了配方或换素材后旧图自动失效」的实现点。没有指纹的旧条目
     * （key 列为空）视为有效——它们是在引入指纹之前渲的，不该被一次性清空。
     */
    function staleList(extensionPath) {
        var conf = config();
        var cellSize = conf.contactSheet.cellSize;
        var file = new File(String(extensionPath) + "/data/previews.tsv");
        var stale = [];
        var checked = 0;
        if (!file.exists) {
            return "{\"checked\":0,\"stale\":[]}";
        }
        file.encoding = "UTF-8";
        if (!file.open("r")) {
            return "{\"checked\":0,\"stale\":[]}";
        }
        var first = true;
        while (!file.eof) {
            var line = file.readln();
            if (first) { first = false; continue; }   // 表头
            if (!line || line.length === 0) continue;
            var parts = line.split("\t");
            if (parts.length < 6) continue;
            var matchName = parts[0];
            var frames = parseInt(parts[3], 10) || 1;
            var storedKey = parts[5];
            checked++;
            if (!storedKey) continue;
            var currentKey = itemKey(matchName, cellSize, frames);
            if (currentKey && currentKey !== storedKey) stale.push(matchName);
        }
        file.close();

        var quoted = [];
        for (var i = 0; i < stale.length; i++) quoted.push(jsonText(stale[i]));
        return "{\"checked\":" + checked + ",\"stale\":[" + quoted.join(",") + "]}";
    }

    return {
        config: config,
        plan: plan,
        pngTemplate: pngTemplate,
        buildScene: buildScene,
        itemKey: itemKey,
        renderBatch: renderBatch,
        renderOne: renderOne,
        writeManifest: writeManifest,
        staleList: staleList
    };
})();
