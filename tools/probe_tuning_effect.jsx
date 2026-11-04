// ============================================================
// probe_tuning_effect.jsx —— 定位「调参把效果调坏」的元凶
//
// 现象：S_BrightnessContrast 在插件调参开启时报
//   「在需要数字、数组或属性的位置找到类型为 Error 的对象」，整条渲不出来。
// 问：是「调参」弄坏的，还是这个效果本身就有问题？
// 答法：同一个效果渲两次 —— 一次关掉调参，一次开着 —— 对比结果。
//
// 运行：AfterFX.exe -r tools/probe_tuning_effect.jsx
// 输出：<我的文档>/DreamEngineProbe/tuning_probe.txt
// 语法：ES3 only。
// ============================================================

(function probeTuning() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();

    var lines = [];
    function flush() {
        var f = new File(OUT.fsName + "/tuning_probe.txt");
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

    var TARGETS = ["S_BrightnessContrast", "S_Clouds"];

    function render(target, sheet) {
        return AEV_PreviewGen.renderBatch([target], sheet, {
            outputRoot: "user",
            extensionPath: EXT,
            singleCell: true,
            freshAssets: true,
            frames: 6
        });
    }

    for (var t = 0; t < TARGETS.length; t++) {
        var target = TARGETS[t];
        AEV_Recipe.setTuning(false);
        var off = render(target, 3100 + t * 2);
        log(target + "|tuning_off|" + off.substring(0, 220));

        AEV_Recipe.setTuning(true);
        var on = render(target, 3101 + t * 2);
        log(target + "|tuning_on|" + on.substring(0, 220));
    }

    log("DONE");
    try {
        app.quit(SaveOptions.DO_NOT_SAVE_CHANGES);
    } catch (eQuit) {
        try { app.quit(); } catch (e2) {}
    }
})();
