// ============================================================
// run_recipe_check.jsx —— 配方效果验证
//
// 渲染一批"之前看不出效果"和"新写配方"的效果，用于目视核对配方是否生效。
// 输出：<我的文档>/DreamEngineProbe/recipe_check.txt
// 语法：ES3 only。
// ============================================================

(function runRecipeCheck() {
    var CASES = [
        { matchName: "ADBE Bulge", sheet: 30 },
        { matchName: "ADBE Twirl", sheet: 31 },
        { matchName: "ADBE Sharpen", sheet: 32 },
        { matchName: "ADBE Radial Blur", sheet: 33 },
        { matchName: "ADBE Mosaic", sheet: 34 },
        { matchName: "ADBE Glo2", sheet: 35 }
    ];

    var ext = new Folder(Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel");
    var logDir = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!logDir.exists) logDir.create();
    var logFile = new File(logDir.fsName + "/recipe_check.txt");
    logFile.encoding = "UTF-8";

    var lines = [];
    function push(t) { lines.push(t); }
    function flush() {
        logFile.open("w");
        logFile.write(lines.join("\r\n"));
        logFile.close();
    }

    var modules = [
        "engine/render_config.jsx", "engine/store.jsx", "engine/names.jsx",
        "engine/assets.jsx", "engine/recipe.jsx", "engine/previewgen.jsx",
        "engine/queue.jsx", "engine/catalog.jsx"
    ];

    try {
        push("PROBE=RECIPE_CHECK");
        for (var i = 0; i < modules.length; i++) {
            $.evalFile(new File(ext.fsName + "/" + modules[i]));
        }
        push("RECIPE_VERSION=" + AEV_Recipe.RECIPE_VERSION);
        flush();

        var okCount = 0;
        for (var c = 0; c < CASES.length; c++) {
            var item = CASES[c];
            var started = new Date().getTime();
            var raw = AEV_PreviewGen.renderBatch([item.matchName], item.sheet, {
                cellOffset: 0,
                outputRoot: "extension",
                extensionPath: ext.fsName
            });
            var elapsed = Math.round(((new Date().getTime() - started) / 1000) * 100) / 100;
            var ok = raw.indexOf('"status":"ok"') >= 0;
            if (ok) okCount++;
            push("ITEM|" + item.matchName + "|" + (ok ? "OK" : "FAIL") + "|" + elapsed + "s|" +
                 (ok ? "sheet=" + item.sheet : String(raw).substring(0, 160)));
            flush();
        }
        push("SUMMARY|ok=" + okCount + "/" + CASES.length);
        push("RESULT=DONE");
    } catch (e) {
        push("EXCEPTION=" + e.toString());
        push("RESULT=EXCEPTION");
    }

    flush();
})();
