// ============================================================
// run_anim_debug.jsx —— 查清哪些效果打不上关键帧
//
// 现象：60 条里只有 27 条的 6 帧有差异，其余 33 条 6 帧逐像素相同。
// 这里逐条报告：有没有配方、配方命中几个参数、animate 选了哪个参数、什么类型。
//
// 运行：AfterFX.exe -r tools/run_anim_debug.jsx
// 输出：<我的文档>/DreamEngineProbe/anim_debug.txt
// 语法：ES3 only。
// ============================================================

(function runAnimDebug() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();
    var log = new File(OUT.fsName + "/anim_debug.txt");
    log.encoding = "UTF-8";

    var lines = [];
    function push(t) { lines.push(t); }
    function flush() { if (log.open("w")) { log.write(lines.join("\r\n")); log.close(); } }

    var MODULES = [
        "engine/render_config.jsx", "engine/store.jsx", "engine/names.jsx",
        "engine/assets.jsx", "engine/recipe.jsx", "engine/previewgen.jsx",
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

    // 读运行时索引里的全部 matchName
    var names = [];
    var tsv = new File(EXT + "/data/previews.tsv");
    tsv.encoding = "UTF-8";
    if (tsv.open("r")) {
        var first = true;
        while (!tsv.eof) {
            var line = tsv.readln();
            if (first) { first = false; continue; }
            if (!line) continue;
            var p = line.split("\t");
            if (p[0]) names.push(p[0]);
        }
        tsv.close();
    }
    push("COUNT=" + names.length);

    for (var n = 0; n < names.length; n++) {
        var name = names[n];
        var comp = null;
        try {
            comp = app.project.items.addComp("DE_dbg_" + n, 256, 256, 1, 0.2, 30);
            var layer = comp.layers.addSolid([0.4, 0.5, 0.6], "s", 256, 256, 1);
            var group = layer.property("ADBE Effect Parade").addProperty(name);

            var applied = AEV_Recipe.apply(group, name, 256);
            var animated = AEV_Recipe.animate(group, name, 0.2);

            // 把配方里的每个参数名列出来，方便看是名字没命中还是类型不对
            var steps = AEV_Recipe.recipes[name];
            var detail = "";
            if (steps) {
                for (var s = 0; s < steps.length; s++) {
                    detail += " [" + steps[s].names.join("/") + "=" + steps[s].value + "]";
                }
            }
            push("ROW|" + name + "|mode=" + applied.mode + "|writes=" + applied.writes +
                 "|animated=" + animated + (steps ? detail : "|无配方"));
        } catch (e) {
            push("ROW_FAIL|" + name + "|" + e);
        } finally {
            try { if (comp) comp.remove(); } catch (eRm) {}
        }
    }
    push("RESULT=OK");
    flush();
})();
