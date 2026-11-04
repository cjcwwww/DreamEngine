// ============================================================
// run_dropshadow_test.jsx —— 投影效果的关键帧到底动不动？
//
// 已知：距离 0 vs 40 的静态画面不同（参数有效），
// 但 0→12 的关键帧没让 6 帧产生任何差别。
// 这里一次渲 4 格：
//   0 格：关键帧 0 → 100（大跨度）
//   1 格：关键帧 0 → 12（当前配方用的跨度）
//   2 格：静态 12
//   3 格：静态 0
// 渲染 6 帧后由 node 侧逐格比对。
//
// 运行：AfterFX.exe -r tools/run_dropshadow_test.jsx
// 输出：<我的文档>/DreamEngineProbe/dropshadow_test.txt
// 语法：ES3 only。
// ============================================================

(function runDropShadowTest() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();
    var log = new File(OUT.fsName + "/dropshadow_test.txt");
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
        $.evalFile(new File(EXT + "/" + MODULES[i]));
    }

    var FRAMES = 6;
    var CELL_FPS = 30;
    var duration = FRAMES / CELL_FPS;

    var comp = app.project.items.addComp("DE_ds", 512, 512, 1, duration, CELL_FPS);
    var photo = AEV_Assets.get("photo", 256);

    // 0 格：关键帧 0→100；1 格：关键帧 0→12；2 格：静态 12；3 格：静态 0
    var MODES = ["key100", "key12", "static12", "static0"];
    for (var i = 0; i < MODES.length; i++) {
        var layer = comp.layers.add(photo);
        var x = (i % 2) * 256;
        var y = Math.floor(i / 2) * 256;
        layer.property("ADBE Transform Group").property("ADBE Position")
            .setValue([x + 128, y + 128]);
        var group = layer.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
        var count = group.numProperties;
        for (var p = 1; p <= count; p++) {
            var prop = group.property(p);
            if (prop.name !== "距离") continue;
            if (MODES[i] === "key100") {
                prop.setValueAtTime(0, 0);
                prop.setValueAtTime(duration, 100);
            } else if (MODES[i] === "key12") {
                prop.setValueAtTime(0, 0);
                prop.setValueAtTime(duration, 12);
            } else if (MODES[i] === "static12") {
                prop.setValue(12);
            } else {
                prop.setValue(0);
            }
            push("SET|" + MODES[i] + "|" + prop.name + "|keys=" + prop.numKeys);
            break;
        }
    }
    flush();

    var folder = AEV_Store.folderAt("cache/ds");
    if (folder && !folder.exists) folder.create();
    var rq = app.project.renderQueue.items.add(comp);
    var om = rq.outputModule(1);
    om.applyTemplate(AEV_PreviewGen.pngTemplate(om));
    om.file = new File(folder.fsName + "/ds_[####].png");
    rq.timeSpanStart = 0;
    rq.timeSpanDuration = duration;
    app.project.renderQueue.render();
    push("RESULT=OK");
    flush();
})();
