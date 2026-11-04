// ============================================================
// probe_fresh_batch.jsx —— 用「独立素材」重渲第 0 张网，与现有网图逐格比对
//
// 目的：现有 L1 网图是复用会话缓存素材渲的。若 AE 的嵌套合成缓存让后续渲染
// 吃旧帧，那些格子就是「别的画面」或「素材原样」——预览就指错了效果。
// 这里用 freshAssets 重渲同样 64 条（同一顺序），渲染后由 Node 侧逐格比较。
//
// 输入：<我的文档>/DreamEngineProbe/fresh_batch.tsv（每行 matchName \t 帧数）
// 输出：<我的文档>/DreamEngine/cache/thumbs/batch_4000_*.png（1024 整网）
// 语法：ES3 only。
// ============================================================

(function probeFreshBatch() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();

    var lines = [];
    function flush() {
        var f = new File(OUT.fsName + "/fresh_batch.txt");
        f.encoding = "UTF-8";
        if (f.open("w")) { f.write(lines.join("\r\n")); f.close(); }
    }
    function log(text) { lines.push(text); flush(); }

    var MODULES = [
        "engine/render_config.jsx",
        "engine/store.jsx",
        "engine/assets.jsx",
        "engine/recipe.jsx",
        "engine/previewgen.jsx"
    ];
    for (var m = 0; m < MODULES.length; m++) {
        try {
            $.evalFile(new File(EXT + "/" + MODULES[m]));
        } catch (eMod) {
            log("MODULE_FAIL|" + MODULES[m] + "|" + eMod);
            return;
        }
    }

    var list = new File(OUT.fsName + "/fresh_batch.tsv");
    if (!list.exists) {
        log("NO_LIST");
        return;
    }
    var names = [];
    list.encoding = "UTF-8";
    if (list.open("r")) {
        while (!list.eof) {
            var row = list.readln();
            if (!row || row.charAt(0) === "#") continue;
            var p = row.split("\t");
            if (p[0]) names.push(p[0]);
        }
        list.close();
    }
    log("TODO=" + names.length);
    if (names.length === 0) return;

    var raw = AEV_PreviewGen.renderBatch(names, 4000, {
        outputRoot: "user",
        extensionPath: EXT,
        freshAssets: true
    });
    log("FRESH|" + raw.substring(0, 260));

    log("DONE");
    try {
        app.quit(SaveOptions.DO_NOT_SAVE_CHANGES);
    } catch (eQuit) {}
})();
