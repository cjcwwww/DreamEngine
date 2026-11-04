// ============================================================
// run_anim_check.jsx —— 验证「6 帧真的有差异」
//
// 背景：AE 效果默认不随时间变化，不打关键帧的话 6 帧逐像素相同，
// 缩略图轮播等于静止画面（实测 60 条里 59 条如此）。
// 这里渲染一网带配方的效果，输出到用户目录，由 node 侧逐帧比对像素。
//
// 运行：AfterFX.exe -r tools/run_anim_check.jsx
// 输出：<我的文档>/DreamEngineProbe/anim_check.txt + 用户目录下的帧文件
// 语法：ES3 only。
// ============================================================

(function runAnimCheck() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();
    var log = new File(OUT.fsName + "/anim_check.txt");
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
    push("RECIPE_VERSION=" + AEV_Recipe.RECIPE_VERSION);

    var TARGETS = [
        "ADBE Gaussian Blur 2",
        "CC Radial Blur",
        "ADBE Turbulent Displace",
        "CC Kaleida",
        "ADBE Mosaic"
    ];

    // 逐个效果单独打关键帧，报告哪些能动画
    for (var t = 0; t < TARGETS.length; t++) {
        var name = TARGETS[t];
        var comp = null;
        try {
            comp = app.project.items.addComp("DE_anim_" + t, 256, 256, 1, 0.2, 30);
            var layer = comp.layers.addSolid([0.4, 0.5, 0.6], "s", 256, 256, 1);
            var group = layer.property("ADBE Effect Parade").addProperty(name);
            var applied = AEV_Recipe.apply(group, name, 256);
            var animated = AEV_Recipe.animate(group, name, 0.2);
            push("ANIM|" + name + "|mode=" + applied.mode + "|writes=" + applied.writes +
                 "|animated=" + animated);
        } catch (e) {
            push("ANIM_FAIL|" + name + "|" + e);
        } finally {
            try { if (comp) comp.remove(); } catch (eRm) {}
        }
    }
    flush();

    // 渲一整网，输出到用户目录（不碰运行时索引）
    var raw = AEV_PreviewGen.renderBatch(TARGETS, 950, { outputRoot: "user" });
    push("RENDER=" + (raw.length > 400 ? raw.substring(0, 400) : raw));
    push("RESULT=OK");
    flush();
})();
