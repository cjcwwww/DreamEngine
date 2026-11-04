// ============================================================
// run_batch_generate.jsx —— 离线批量生成（不依赖面板点击）
//
// 面板上的「生成缺失预览」走的是 CEP 按钮，自动化点不进 CEF 子窗口
// （实测：外部鼠标注入到不了面板内部）。这个脚本把同一条链路搬到 AE 侧：
//   读现有索引 → 取待渲名单 → 每 64 个渲一张网 → 追加条目 → 重写索引
//
// 输入：<我的文档>/DreamEngineProbe/next_batch.tsv（由 tools/pick_candidates.mjs 产出）
//      每行 "matchName \t 帧数"
// 输出：data/manifest.json + data/previews.tsv + thumbs/batch_XXX_*.png
// 日志：<我的文档>/DreamEngineProbe/batch_generate.txt
//
// 运行：AfterFX.exe -r tools/run_batch_generate.jsx
// 语法：ES3 only。
// ============================================================

(function runBatchGenerate() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();
    var log = new File(OUT.fsName + "/batch_generate.txt");
    log.encoding = "UTF-8";

    var lines = [];
    function push(text) { lines.push(text); }
    function flush() {
        if (log.open("w")) {
            log.write(lines.join("\r\n"));
            log.close();
        }
    }

    var MODULES = [
        "engine/render_config.jsx",
        "engine/store.jsx",
        "engine/names.jsx",
        "engine/assets.jsx",
        "engine/recipe.jsx",
        "engine/previewgen.jsx",
        "engine/queue.jsx"
    ];

    for (var i = 0; i < MODULES.length; i++) {
        try {
            $.evalFile(new File(EXT + "/" + MODULES[i]));
        } catch (e) {
            push("MODULE_FAIL|" + MODULES[i] + "|" + e);
            flush();
            return;
        }
    }
    push("PROBE=BATCH_GENERATE");
    push("RECIPE_VERSION=" + AEV_Recipe.RECIPE_VERSION);

    var conf = AEV_PreviewGen.config();
    var perSheet = conf.contactSheet.effectsPerSheet;
    var cellSize = conf.contactSheet.cellSize;
    var columns = conf.contactSheet.columns;

    /**
     * 读现有条目。优先读 previews.tsv（writeManifest 的副产物），
     * 没有就从 manifest.json 里正则提取——manifest 是本项目自己生成的，
     * 字段顺序固定，不值得为它写一个完整 JSON 解析器。
     */
    function readEntries() {
        var out = [];
        var tsv = new File(EXT + "/data/previews.tsv");
        if (tsv.exists) {
            tsv.encoding = "UTF-8";
            if (tsv.open("r")) {
                var first = true;
                while (!tsv.eof) {
                    var line = tsv.readln();
                    if (first) { first = false; continue; }
                    if (!line) continue;
                    var p = line.split("\t");
                    if (p.length < 5) continue;
                    out.push({
                        matchName: p[0],
                        sheet: parseInt(p[1], 10) || 0,
                        cell: parseInt(p[2], 10) || 0,
                        frames: parseInt(p[3], 10) || 6,
                        frameTemplate: p[4] || ""
                    });
                }
                tsv.close();
                return out;
            }
        }

        var mf = new File(EXT + "/data/manifest.json");
        if (!mf.exists) return out;
        mf.encoding = "UTF-8";
        if (!mf.open("r")) return out;
        var text = mf.read();
        mf.close();

        var re = /\{"matchName":"([^"]*)","sheet":(\d+),"x":(\d+),"y":(\d+),"width":\d+,"height":\d+,"frames":(\d+)([^}]*)\}/g;
        var match = re.exec(text);
        while (match) {
            var x = parseInt(match[3], 10) || 0;
            var y = parseInt(match[4], 10) || 0;
            var tail = match[6] || "";
            var tmpl = "";
            var at = tail.indexOf("\"frameSrc\":\"");
            if (at >= 0) {
                var rest = tail.substring(at + 12);
                tmpl = rest.substring(0, rest.indexOf("\""));
            }
            out.push({
                matchName: match[1],
                sheet: parseInt(match[2], 10) || 0,
                cell: Math.floor(y / cellSize) * columns + Math.floor(x / cellSize),
                frames: parseInt(match[5], 10) || 6,
                frameTemplate: tmpl
            });
            match = re.exec(text);
        }
        return out;
    }

    var entries = readEntries();
    push("EXISTING_ENTRIES=" + entries.length);

    var nextSheet = 0;
    for (var e = 0; e < entries.length; e++) {
        if (entries[e].sheet >= nextSheet) nextSheet = entries[e].sheet + 1;
    }
    push("NEXT_SHEET=" + nextSheet);

    // ---- 读待渲名单 ----
    var todo = [];
    var list = new File(OUT.fsName + "/next_batch.tsv");
    if (!list.exists) {
        push("NO_TODO_FILE");
        flush();
        return;
    }
    list.encoding = "UTF-8";
    if (list.open("r")) {
        while (!list.eof) {
            var row = list.readln();
            if (!row) continue;
            var parts = row.split("\t");
            if (!parts[0]) continue;
            todo.push({ matchName: parts[0], frames: parseInt(parts[1], 10) || 6 });
        }
        list.close();
    }
    push("TODO=" + todo.length);
    flush();

    if (todo.length === 0) {
        push("RESULT=NOTHING_TO_DO");
        flush();
        return;
    }

    // ---- 分批渲染 ----
    // 每批刻意小于整网容量：48 格一次渲时 AE 直接崩溃（进程消失，日志断在半路）。
    // 分批后一批崩了只丢这一批，而且「渲染前先写名单」能定位到具体是哪个效果。
    var CHUNK = 8;
    var rendered = 0;
    var failed = 0;
    var sheetIndex = nextSheet;
    var cursor = 0;
    while (cursor < todo.length) {
        var chunk = [];
        while (cursor < todo.length && chunk.length < CHUNK) {
            chunk.push(todo[cursor]);
            cursor++;
        }
        var names = [];
        for (var c = 0; c < chunk.length; c++) names.push(chunk[c].matchName);

        push("BEGIN_SHEET|" + sheetIndex + "|" + names.join(","));
        flush();

        var started = new Date().getTime();
        var raw = AEV_PreviewGen.renderBatch(names, sheetIndex, {
            outputRoot: "extension",
            extensionPath: EXT,
            cellOffset: 0
        });
        var seconds = Math.round((new Date().getTime() - started) / 100) / 10;
        var ok = raw.indexOf("\"status\":\"ok\"") >= 0;
        push("SHEET|" + sheetIndex + "|" + names.length + "|" + seconds + "s|" +
             (ok ? "OK" : "FAIL") + "|" + raw.substring(0, 200));

        if (ok) {
            for (var n = 0; n < chunk.length; n++) {
                entries.push({
                    matchName: chunk[n].matchName,
                    sheet: sheetIndex,
                    cell: n,
                    frames: chunk[n].frames,
                    frameTemplate: "thumbs/batch_" + pad3(sheetIndex) + "_%04d.png"
                });
                rendered++;
            }
            sheetIndex++;
            // 每成功一批就落盘一次。整批跑完才写的话，中途 AE 崩溃会把前面
            // 已经渲好的几十张全丢掉（实测踩过：10~12 张网渲完但索引没写）。
            AEV_PreviewGen.writeManifest(entriesToTsv(entries), EXT);
        } else {
            failed += chunk.length;
        }
        flush();
    }

    function entriesToTsv(list) {
        var rows = [];
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            rows.push([
                it.matchName,
                String(it.sheet),
                String(it.cell),
                String(it.frames),
                it.frameTemplate || ""
            ].join("\t"));
        }
        return rows.join("\r\n");
    }

    function pad3(value) {
        var text = String(value);
        while (text.length < 3) text = "0" + text;
        return text;
    }

    // ---- 重写索引（同时产出 previews.tsv 给 staleList 用）----
    var result = AEV_PreviewGen.writeManifest(entriesToTsv(entries), EXT);
    push("MANIFEST=" + result);
    push("RENDERED=" + rendered + "|FAILED=" + failed);
    push("STALE_AFTER=" + AEV_PreviewGen.staleList(EXT));
    push("RESULT=OK");
    flush();
})();
