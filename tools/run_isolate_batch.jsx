// ============================================================
// run_isolate_batch.jsx —— 一次运行完成「候选筛选 + 逐条渲染 + 合并索引」
//
// 为什么不用面板按钮：CEP 面板内部的按钮无法从外部稳定注入点击，
// 而「文件 > 脚本 > 运行脚本文件」是原生菜单，可靠得多。
// 本脚本复刻面板的候选筛选规则，逐条渲染以隔离坏效果，成功的并入 manifest。
//
// 运行方式：AE 菜单 文件 > 脚本 > 运行脚本文件
// 输出：<我的文档>/DreamEngineProbe/isolate_batch.txt
// 语法：ES3 only。
// ============================================================

(function runIsolateBatch() {
    var LIMIT = 10;          // 本次最多测几条
    var START_SHEET = -1;    // -1 表示从 manifest 里最大 sheet + 1 开始

    var ext = new Folder(Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel");
    var logDir = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!logDir.exists) logDir.create();
    var logFile = new File(logDir.fsName + "/isolate_batch.txt");
    logFile.encoding = "UTF-8";

    var lines = [];
    function push(t) { lines.push(t); }
    function flush() {
        logFile.open("w");
        logFile.write(lines.join("\r\n"));
        logFile.close();
    }

    var modules = [
        "engine/render_config.jsx",
        "engine/store.jsx",
        "engine/recipe.jsx",
        "engine/previewgen.jsx",
        "engine/queue.jsx"
    ];

    try {
        push("PROBE=ISOLATE_BATCH");
        push("AE_VERSION=" + app.version);
        for (var i = 0; i < modules.length; i++) {
            $.evalFile(new File(ext.fsName + "/" + modules[i]));
        }
        push("LOAD=OK");

        // ---------- 1. 读现有 manifest ----------
        var manifestPath = ext.fsName + "/data/manifest.json";
        var manifestFile = new File(manifestPath);
        var entries = [];
        var maxSheet = 0;
        var existing = [];
        if (manifestFile.exists) {
            manifestFile.encoding = "UTF-8";
            manifestFile.open("r");
            var text = manifestFile.read();
            manifestFile.close();
            var re = /"matchName":"([^"]+)","sheet":(\d+),"x":(\d+),"y":(\d+),"width":\d+,"height":\d+,"frames":(\d+)/g;
            var hit = re.exec(text);
            while (hit) {
                var sheetNo = parseInt(hit[2], 10);
                var cellNo = Math.floor(parseInt(hit[4], 10) / 256) * 8 +
                             Math.floor(parseInt(hit[3], 10) / 256);
                entries.push({
                    matchName: hit[1], sheet: sheetNo, cell: cellNo,
                    frames: parseInt(hit[5], 10), frameTemplate: frameTemplateOf(hit[1], sheetNo, parseInt(hit[5], 10), text)
                });
                existing.push(hit[1]);
                if (sheetNo > maxSheet) maxSheet = sheetNo;
                hit = re.exec(text);
            }
        }
        push("MANIFEST_BEFORE=" + entries.length + "|maxSheet=" + maxSheet);

        // ---------- 2. 选候选 ----------
        var candidates = pickCandidates(existing);
        push("CANDIDATE_COUNT=" + candidates.length);
        var batch = [];
        for (var c = 0; c < candidates.length && batch.length < LIMIT; c++) {
            batch.push(candidates[c]);
        }
        push("BATCH=" + batch.join(","));

        // ---------- 3. 逐条渲染 ----------
        var sheetCursor = (START_SHEET >= 0) ? START_SHEET : maxSheet + 1;
        var okList = [];
        var failList = [];

        for (var b = 0; b < batch.length; b++) {
            var name = batch[b];
            var started = new Date().getTime();
            var raw;
            try {
                raw = AEV_PreviewGen.renderBatch([name], sheetCursor, {
                    cellOffset: 0,
                    outputRoot: "extension",
                    extensionPath: ext.fsName
                });
            } catch (e) {
                raw = '{"status":"error","reason":"exception:' + String(e) + '"}';
            }
            var elapsed = Math.round(((new Date().getTime() - started) / 1000) * 100) / 100;

            if (raw.indexOf('"status":"ok"') >= 0) {
                push("ITEM|" + name + "|OK|" + elapsed + "s|sheet=" + sheetCursor);
                okList.push({ name: name, sheet: sheetCursor });
                entries.push({
                    matchName: name,
                    sheet: sheetCursor,
                    cell: 0,
                    frames: 6,
                    frameTemplate: "thumbs/batch_" + pad(sheetCursor, 3) + "_%04d.png"
                });
            } else {
                push("ITEM|" + name + "|FAIL|" + elapsed + "s|" + clip(raw));
                failList.push(name);
            }
            sheetCursor++;
        }

        // ---------- 4. 写回 manifest ----------
        var tsvLines = [];
        for (var e = 0; e < entries.length; e++) {
            tsvLines.push([
                entries[e].matchName, entries[e].sheet, entries[e].cell,
                entries[e].frames, entries[e].frameTemplate || ""
            ].join("\t"));
        }
        push("WRITE_MANIFEST=" + AEV_PreviewGen.writeManifest(tsvLines.join("\n"), ext.fsName));
        push("MANIFEST_AFTER=" + entries.length);

        push("SUMMARY|ok=" + okList.length + "|fail=" + failList.length);
        push("FAILED=" + failList.join(","));
        push("RESULT=DONE");
    } catch (e2) {
        push("EXCEPTION=" + e2.toString());
        push("RESULT=EXCEPTION");
    }

    flush();

    // ---------- helpers ----------

    function frameTemplateOf(matchName, sheetNo, frames, manifestText) {
        if (frames <= 1) return "";
        var needle = '"matchName":"' + matchName + '"';
        var at = manifestText.indexOf(needle);
        if (at < 0) return "";
        var windowText = manifestText.substring(at, at + 400);
        if (windowText.indexOf("frameSrc") >= 0) {
            return "thumbs/batch_" + pad(sheetNo, 3) + "_%04d.png";
        }
        return "";
    }

    function pickCandidates(existingNames) {
        var rows = readCatalog();
        var buckets = {};
        var order = [];
        var CAT_ORDER = [
            "模糊和锐化", "颜色校正", "扭曲", "风格化", "生成", "杂色和颗粒",
            "透视", "过渡", "抠像", "模拟", "声道", "时间", "实用工具", "遮罩", "文本"
        ];

        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (indexOfText(existingNames, row.matchName) >= 0) continue;
            if (isExcluded(row.matchName, row.category)) continue;
            var cat = row.category || "未分类";
            if (!buckets[cat]) { buckets[cat] = []; order.push(cat); }
            buckets[cat].push(row.matchName);
        }

        order.sort(function (a, b) {
            var ra = indexOfText(CAT_ORDER, a);
            var rb = indexOfText(CAT_ORDER, b);
            if (ra < 0) ra = 500;
            if (rb < 0) rb = 500;
            return ra - rb;
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

    function isExcluded(matchName, category) {
        if (matchName.indexOf("Pseudo") === 0) return true;
        if (/Obsolete|过时/i.test(category)) return true;
        if (matchName.indexOf("CS") === 0) return true;
        if (category === "3D 通道" || category === "3D Channel") return true;
        if (category === "表达式控制" || category === "Expression Controls") return true;
        if (category === "音频" || category === "Audio") return true;
        if (/Tracker|Glasses|Stereo|Camera|Extracto/i.test(matchName)) return true;
        return false;
    }

    function readCatalog() {
        var paths = [
            ext.fsName + "/../../probe-results/AE2021/T0_1_full.tsv",
            "D:/workqwen/DreamEngine-1/probe-results/AE2021/T0_1_full.tsv",
            "C:/Users/31371/WorkBuddy/Worktrees/DreamEngine-1/main-d673b851/probe-results/AE2021/T0_1_full.tsv"
        ];
        var file = null;
        for (var i = 0; i < paths.length; i++) {
            var candidate = new File(paths[i]);
            if (candidate.exists) { file = candidate; break; }
        }
        var rows = [];
        if (!file) return rows;
        file.encoding = "UTF-8";
        file.open("r");
        var header = file.readln();
        while (!file.eof) {
            var line = file.readln();
            if (!line) continue;
            var cols = line.split("\t");
            if (cols.length < 3) continue;
            rows.push({ matchName: cols[0], category: cols[2] });
        }
        file.close();
        return rows;
    }

    function indexOfText(list, value) {
        for (var i = 0; i < list.length; i++) {
            if (list[i] === value) return i;
        }
        return -1;
    }

    function pad(value, width) {
        var text = String(value);
        while (text.length < width) text = "0" + text;
        return text;
    }

    function clip(text) {
        var s = String(text);
        return s.length > 180 ? s.substring(0, 180) + "…" : s;
    }
})();
