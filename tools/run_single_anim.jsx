// ============================================================
// run_single_anim.jsx —— 最小实验：只渲一个效果，逐帧对比
//
// 目的：排除「索引坐标与帧文件对不上」这类干扰，
// 直接验证「打关键帧 → 渲染出来的帧到底有没有差别」。
//
// 运行：AfterFX.exe -r tools/run_single_anim.jsx
// 输出：<我的文档>/DreamEngineProbe/single_anim.txt + 用户目录下的帧文件
// 语法：ES3 only。
// ============================================================

(function runSingleAnim() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();
    var log = new File(OUT.fsName + "/single_anim.txt");
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

    var TARGET = "ADBE Drop Shadow";
    push("TARGET=" + TARGET);
    push("RECIPE=" + JSON.stringify(AEV_Recipe.recipes[TARGET]));

    // 单独建一个 256×256 的合成，不走 contact sheet，直接渲 6 帧
    var conf = AEV_PreviewGen.config();
    var frames = conf.animatedPreview.frameCount;
    var CELL_FPS = 30;
    var duration = frames / CELL_FPS;

    var comp = app.project.items.addComp("DE_single", 256, 256, 1, duration, CELL_FPS);
    var layer = comp.layers.add(AEV_Assets.get("photo", 256));
    var group = layer.property("ADBE Effect Parade").addProperty(TARGET);
    var applied = AEV_Recipe.apply(group, TARGET, 256);
    var animated = AEV_Recipe.animate(group, TARGET, duration);
    push("applied=" + applied.mode + "|writes=" + applied.writes + "|animated=" + animated);

    // 读回关键帧前后的值
    try {
        var v0 = group.property(1).valueAtTime(0);
        var v1 = group.property(1).valueAtTime(duration);
        push("prop1=" + group.property(1).name + " t0=" + v0 + " tEnd=" + v1);
    } catch (e) {
        push("prop1_read_fail|" + e);
    }

    var folder = AEV_Store.folderAt("cache/single");
    if (folder && !folder.exists) folder.create();
    var item = app.project.renderQueue.items.add(comp);
    var om = item.outputModule(1);
    om.applyTemplate(AEV_PreviewGen.pngTemplate(om));
    om.file = new File(folder.fsName + "/single_[####].png");
    item.timeSpanStart = 0;
    item.timeSpanDuration = duration;
    app.project.renderQueue.render();

    var produced = [];
    for (var f = 0; f < frames; f++) {
        var file = new File(folder.fsName + "/single_" + (f < 10 ? "000" + f : "00" + f) + ".png");
        if (file.exists) produced.push(file.name);
    }
    push("PRODUCED=" + produced.join(","));
    push("RESULT=OK");
    flush();
})();
