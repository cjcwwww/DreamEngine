// ============================================================
// probe_render_order.jsx —— 诊断：singleCell 模式下效果为何"渲不出来"
//
// 观察：singleCell 渲染下，「素材原样」与「素材+效果」两张图逐像素相同；
// 而整网模式（1024、64 格）里效果明显生效。怀疑是 AE 对嵌套素材 comp 的
// 渲染缓存：第一次渲染把素材 comp 缓存了，之后复用缓存帧 → 效果没被求值。
//
// 实验顺序很关键：
//   1) 先渲「带效果」(Glo2)
//   2) 紧接着渲「同一条、无效果」
//   3) 再渲「另一条、带效果」(Fill)
// 若第 3 张长得像第 1 张 → 缓存复用实锤（后面的渲染都复用第一次的帧）；
// 若第 3 张是 Fill 的实心色 → 没有缓存问题，问题在别处。
//
// 运行：AfterFX.exe -r tools/probe_render_order.jsx
// 输出：<我的文档>/DreamEngine/cache/thumbs/batch_30xx_0000.png
// 语法：ES3 only。
// ============================================================

(function probeRenderOrder() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();

    var lines = [];
    function flush() {
        var f = new File(OUT.fsName + "/render_order.txt");
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

    function render(name, sheet, noEffect) {
        var options = { outputRoot: "user", extensionPath: EXT, singleCell: true };
        if (noEffect) options.noEffect = true;
        var raw = AEV_PreviewGen.renderBatch([name], sheet, options);
        log(name + (noEffect ? "|bare" : "|real") + "|" + raw.substring(0, 200));
    }

    render("ADBE Glo2", 3000, false);   // 第一次：带效果
    render("ADBE Glo2", 3001, true);    // 第二次：同一条，不加效果
    render("ADBE Fill", 3002, false);   // 第三次：另一条，带效果
    render("ADBE Fill", 3003, true);    // 第四次：Fill，不加效果

    log("DONE");
    try {
        app.quit(SaveOptions.DO_NOT_SAVE_CHANGES);
    } catch (eQuit) {}
})();
