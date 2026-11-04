// ============================================================
// run_plugin_preview.jsx —— 第三方插件效果预览（离线 / 逐条隔离）
//
// 为什么不能复用面板的「生成缺失预览」：
//   实测 BCC / Sapphire / Universe 与内置效果混在同一张整网时 AE 进程直接
//   消失，脚本里 catch 不到。面板与 AE 是同一个进程，点了就等于把用户正在
//   用的 AE 杀掉。所以插件预览走独立离线通道：关闭 AE 后用
//   AfterFX.exe -r tools/run_plugin_preview.jsx 启动。
//
// 安全机制：
//   1. 一条效果 = 一张 1×1 单格网（singleCell），绝不混渲
//   2. 渲之前先落盘心跳 BEGIN；AE 崩了日志就停在 BEGIN 上
//   3. 下次启动把未配对的 BEGIN 拉进黑名单，自动跳过元凶
//   4. 每条成功立刻写独立索引，中途崩溃不丢已渲结果
//   5. 索引写 data/plugin_manifest.json，不碰 L1 主索引（install_l1 会覆盖它）
//
// 输入：<我的文档>/DreamEngineProbe/next_plugin_batch.tsv
//       （由 tools/pick_plugin_candidates.mjs 产出，每行 matchName \t 帧数 \t 插件包）
// 输出：data/plugin_manifest.json + data/plugin_previews.tsv +
//       data/plugin_blacklist.json + data/thumbs/batch_1XXX_*.png
// 日志：<我的文档>/DreamEngineProbe/plugin_run.log
//
// 运行：AfterFX.exe -r tools/run_plugin_preview.jsx（先关闭正在运行的 AE）
// 语法：ES3 only。
// ============================================================

(function runPluginPreview() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();

    var LOG = OUT.fsName + "/plugin_run.log";
    var TODO = OUT.fsName + "/next_plugin_batch.tsv";
    var LIMIT_FILE = OUT.fsName + "/plugin_limit.txt";
    var BLACKLIST = OUT.fsName + "/plugin_blacklist.tsv";
    var PANEL_BLACKLIST = EXT + "/data/plugin_blacklist.json";
    var ENTRIES = EXT + "/data/plugin_previews.tsv";
    var MANIFEST = EXT + "/data/plugin_manifest.json";

    function readText(path) {
        var f = new File(path);
        if (!f.exists) return "";
        f.encoding = "UTF-8";
        if (!f.open("r")) return "";
        var text = f.read();
        f.close();
        return text;
    }

    function writeText(path, text) {
        var f = new File(path);
        f.encoding = "UTF-8";
        if (!f.open("w")) return false;
        f.write(text);
        f.close();
        return true;
    }

    function pad3(value) {
        var s = String(value);
        while (s.length < 3) s = "0" + s;
        return s;
    }

    var MODULES = [
        "engine/render_config.jsx",
        "engine/store.jsx",
        "engine/names.jsx",
        "engine/assets.jsx",
        "engine/recipe.jsx",
        "engine/previewgen.jsx",
        "engine/plugin_state.jsx"
    ];
    for (var m = 0; m < MODULES.length; m++) {
        try {
            $.evalFile(new File(EXT + "/" + MODULES[m]));
        } catch (eMod) {
            writeText(LOG, "MODULE_FAIL|" + MODULES[m] + "|" + eMod);
            return;
        }
    }

    var PS = AEV_PluginState;
    var parsed = PS.parseLog(readText(LOG));
    var logLines = parsed.lines;

    /** 每条状态都先落盘：AE 被插件杀掉时，日志里留下的是最后一条 BEGIN */
    function appendLog(kind, name, extra) {
        logLines.push(PS.logLine(kind, name, extra));
        writeText(LOG, logLines.join("\r\n"));
    }

    // ---- 崩溃恢复：把上次没有 OK / FAIL 收尾的条目拉黑 ----
    var blacklist = PS.readBlacklist(readText(BLACKLIST));
    var crashed = parsed.crashed;
    if (crashed.length > 0) {
        blacklist = PS.mergeBlacklist(blacklist, crashed, "crash");
        writeText(BLACKLIST, PS.blacklistTsv(blacklist));
        for (var c = 0; c < crashed.length; c++) {
            appendLog("SKIP", crashed[c], "crash_blacklisted");
        }
    }
    // 面板读 JSON；即使黑名单为空也要写，避免首次安装时读文件报错
    writeText(PANEL_BLACKLIST, PS.blacklistJson(blacklist));

    // ---- 待渲名单 ----
    var todo = [];
    var rawTodo = readText(TODO).replace(/^\uFEFF/, "").split(/\r?\n/);
    for (var t = 0; t < rawTodo.length; t++) {
        var row = rawTodo[t];
        if (!row || row.charAt(0) === "#") continue;
        var p = row.split("\t");
        if (!p[0]) continue;
        todo.push({
            matchName: p[0],
            frames: parseInt(p[1], 10) || 6,
            plugin: p[2] || "其它插件"
        });
    }
    if (todo.length === 0) {
        appendLog("RESULT", "", "no_todo_file");
        return;
    }

    var entries = PS.readEntries(readText(ENTRIES));
    var limit = 24;
    var wanted = parseInt(readText(LIMIT_FILE), 10);
    if (wanted > 0) limit = wanted;
    var run = PS.planRun(todo, entries, blacklist, limit);
    appendLog("RUN", "", "todo=" + todo.length + " pending=" + run.length +
              " done=" + entries.length + " blacklisted=" + crashed.length);

    if (run.length === 0) {
        appendLog("RESULT", "", "nothing_to_do");
        return;
    }

    // 单格图的尺寸取自定版配置；网号从 1000 起，避开 L1 的 0..N 整网
    var conf = AEV_PreviewGen.config();
    var size = {
        cellSize: conf.contactSheet.cellSize,
        columns: 1,
        width: conf.contactSheet.cellSize,
        height: conf.contactSheet.cellSize
    };
    var nextSheet = 1000;
    for (var e = 0; e < entries.length; e++) {
        if (entries[e].sheet >= nextSheet) nextSheet = entries[e].sheet + 1;
    }

    var okCount = 0;
    var failCount = 0;
    for (var r = 0; r < run.length; r++) {
        var item = run[r];
        var sheetIndex = nextSheet++;
        appendLog("BEGIN", item.matchName, "sheet=" + sheetIndex);

        var raw = "";
        try {
            raw = AEV_PreviewGen.renderBatch([item.matchName], sheetIndex, {
                outputRoot: "extension",
                extensionPath: EXT,
                singleCell: true
            });
        } catch (eRender) {
            raw = '{"status":"error","reason":"throw:' + eRender + '"}';
        }

        var ok = raw.indexOf('"status":"ok"') >= 0;
        // 效果没加上时 renderBatch 仍会渲出原始素材（假预览），
        // cellErrors 里带着 "matchName|addProperty|..." —— 这种不能算成功。
        if (ok && raw.indexOf(item.matchName + "|") >= 0) ok = false;

        if (ok) {
            var tmpl = "thumbs/batch_" + pad3(sheetIndex) + "_%04d.png";
            entries = PS.addEntry(entries, {
                matchName: item.matchName,
                sheet: sheetIndex,
                frames: item.frames,
                frameTemplate: tmpl,
                plugin: item.plugin
            });
            // 每条立刻落盘：中途 AE 崩溃也不会丢掉前面渲好的图
            writeText(ENTRIES, PS.entriesTsv(entries));
            writeText(MANIFEST, PS.buildManifest(entries, size));
            appendLog("OK", item.matchName, "sheet=" + sheetIndex);
            okCount++;
        } else {
            appendLog("FAIL", item.matchName, raw.substring(0, 180));
            // 渲染报错（非崩溃）也拉黑，避免每次运行都在同一条上死循环；
            // 想重试就手动从 plugin_blacklist.tsv 删掉这一行。
            blacklist = PS.mergeBlacklist(blacklist, [item.matchName], "render_error");
            writeText(BLACKLIST, PS.blacklistTsv(blacklist));
            writeText(PANEL_BLACKLIST, PS.blacklistJson(blacklist));
            failCount++;
        }
    }

    appendLog("RESULT", "", "ok=" + okCount + " fail=" + failCount +
              " total=" + entries.length);

    // 这是专用实例：渲完直接退出，别把 AE 留在后台占着用户机器。
    // 真崩了的话 AE 进程已经没了，这句不会执行。
    try {
        app.quit(SaveOptions.DO_NOT_SAVE_CHANGES);
    } catch (eQuit) {}
})();
