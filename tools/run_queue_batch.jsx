// ============================================================
// run_queue_batch.jsx —— 队列 + 渲染 + manifest 迁移的端到端验证
//
// 面板里的「生成缺失预览」按钮走的就是这条链路：
//   AEV_Queue.ensure → AEV_Queue.drain → AEV_PreviewGen.renderBatch
//   → AEV_PreviewGen.writeManifest
// CEP 内部按钮无法从外部注入点击，所以用本脚本验证同一条链路。
//
// 行为：
//   1. 读现有 manifest.json（v1 单文件格式），保留已有条目
//   2. 从 T0_1 实测清单里挑 8 个"还没有预览"的内置效果
//   3. 渲一张新网（sheet 1），写回 manifest v2（帧序列格式）
//
// 运行方式：AE 菜单 文件 > 脚本 > 运行脚本文件
// 输出：<我的文档>/DreamEngineProbe/engine_batch.txt
// 语法：ES3 only。
// ============================================================

(function runQueueBatch() {
    var SMOKE_SHEET = 1;
    var SMOKE_LIMIT = 8;

    // 已有预览的 20 个效果（与 tools/generate_m1_previews.jsx 保持一致）
    var EXISTING = [
        "ADBE Gaussian Blur 2", "ADBE Drop Shadow", "APC Colorama",
        "ADBE Turbulent Displace", "ADBE Tint", "ADBE Invert", "ADBE Glo2",
        "ADBE Motion Blur", "ADBE Ripple", "ADBE Wave Warp", "ADBE Mosaic",
        "ADBE Find Edges", "CC Ball Action", "CC Bubbles",
        "CC Particle Systems II", "CC Star Burst", "CC Toner",
        "CC Radial Fast Blur", "CC Lens", "CC Twister"
    ];

    var ext = new Folder(Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel");
    var logDir = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!logDir.exists) logDir.create();
    var logFile = new File(logDir.fsName + "/engine_batch.txt");
    logFile.encoding = "UTF-8";

    var lines = [];
    function push(text) { lines.push(text); }
    function flush() {
        if (!logFile.open("w")) return false;
        logFile.write(lines.join("\r\n"));
        logFile.close();
        return true;
    }

    var modules = [
        "engine/render_config.jsx",
        "engine/store.jsx",
        "engine/recipe.jsx",
        "engine/previewgen.jsx",
        "engine/queue.jsx"
    ];

    try {
        push("PROBE=QUEUE_BATCH");
        push("AE_VERSION=" + app.version);

        for (var i = 0; i < modules.length; i++) {
            $.evalFile(new File(ext.fsName + "/" + modules[i]));
        }
        push("LOAD=OK");

        // ---------- 1. 读现有 manifest ----------
        var manifestFile = new File(ext.fsName + "/data/manifest.json");
        var entries = [];
        if (manifestFile.exists) {
            manifestFile.encoding = "UTF-8";
            manifestFile.open("r");
            var manifestText = manifestFile.read();
            manifestFile.close();
            var re = /"matchName":"([^"]+)","sheet":(\d+),"x":(\d+),"y":(\d+),"width":\d+,"height":\d+,"frames":(\d+)/g;
            var hit = re.exec(manifestText);
            while (hit) {
                entries.push({
                    matchName: hit[1],
                    sheet: parseInt(hit[2], 10),
                    cell: Math.floor(parseInt(hit[4], 10) / 256) * 8 +
                          Math.floor(parseInt(hit[3], 10) / 256),
                    frames: parseInt(hit[5], 10),
                    frameTemplate: ""
                });
                hit = re.exec(manifestText);
            }
        }
        push("EXISTING_ENTRIES=" + entries.length);

        // ---------- 2. 从实测清单里挑候选 ----------
        var candidates = [];
        var tsvFile = new File(ext.fsName + "/../../probe-results/AE2021/T0_1_full.tsv");
        if (!tsvFile.exists) {
            // 扩展目录在 APPDATA，实测清单在仓库里，走仓库绝对路径兜底
            tsvFile = new File("D:/workqwen/DreamEngine-1/probe-results/AE2021/T0_1_full.tsv");
        }
        if (tsvFile.exists) {
            tsvFile.encoding = "UTF-8";
            tsvFile.open("r");
            var line = tsvFile.readln();
            while (!tsvFile.eof) {
                line = tsvFile.readln();
                if (!line) continue;
                var cols = line.split("\t");
                var matchName = cols[0];
                if (!matchName) continue;
                if (matchName.indexOf("ADBE") !== 0) continue;
                if (indexOfText(EXISTING, matchName) >= 0) continue;
                if (indexOfText(candidates, matchName) >= 0) continue;
                candidates.push(matchName);
                if (candidates.length >= SMOKE_LIMIT) break;
            }
            tsvFile.close();
        }
        push("CANDIDATES=" + candidates.join(","));

        // ---------- 3. 入队并推进一批 ----------
        push("ENSURE=" + AEV_Queue.ensure(candidates));
        var raw = AEV_Queue.drain(SMOKE_SHEET, {
            limit: SMOKE_LIMIT,
            cellOffset: 0,
            outputRoot: "extension",
            extensionPath: ext.fsName
        });
        push("DRAIN=" + raw);
        push("QUEUE=" + AEV_Queue.stats());

        var ok = raw.indexOf("\"status\":\"ok\"") >= 0;
        if (!ok) {
            push("RESULT=DRAIN_ERROR");
            flush();
            alert("队列渲染失败，详见日志：\n" + logFile.fsName);
            return;
        }

        // ---------- 4. 把本批结果并入 manifest ----------
        var names = extractNames(raw);
        for (var n = 0; n < names.length; n++) {
            entries.push({
                matchName: names[n],
                sheet: SMOKE_SHEET,
                cell: n,
                frames: 6,
                frameTemplate: "thumbs/batch_001_%04d.png"
            });
        }
        push("MERGED_ENTRIES=" + entries.length);

        var tsvLines = [];
        for (var e = 0; e < entries.length; e++) {
            tsvLines.push([
                entries[e].matchName,
                entries[e].sheet,
                entries[e].cell,
                entries[e].frames,
                entries[e].frameTemplate || ""
            ].join("\t"));
        }
        push("WRITE_MANIFEST=" + AEV_PreviewGen.writeManifest(
            tsvLines.join("\n"), ext.fsName
        ));
        push("RESULT=OK");
    } catch (e) {
        push("EXCEPTION=" + e.toString());
        push("RESULT=EXCEPTION");
    }

    flush();
    alert("队列批次结束，详见日志：\n" + logFile.fsName);

    function indexOfText(list, value) {
        for (var k = 0; k < list.length; k++) {
            if (list[k] === value) return k;
        }
        return -1;
    }

    function extractNames(raw) {
        var out = [];
        var start = raw.indexOf("\"names\":[");
        if (start < 0) return out;
        var end = raw.indexOf("]", start);
        if (end < 0) return out;
        var body = raw.substring(start + 9, end);
        var parts = body.split(",");
        for (var k = 0; k < parts.length; k++) {
            var item = parts[k].replace(/"/g, "");
            if (item) out.push(item);
        }
        return out;
    }
})();
