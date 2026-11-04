// ============================================================
// probe_preset_library.jsx —— 验证「自主添加预设」这条链路
//
// 面板上的流程是：点「添加预设」→ AE 弹文件选择框（多选）→ 复制进库 → 列表刷新。
// 文件选择框必须人工点，这里只验证后半段：复制入库 + 列出库内预设。
//
// 运行：AfterFX.exe -r tools/probe_preset_library.jsx
// 输出：<我的文档>/DreamEngineProbe/preset_library.txt
// 语法：ES3 only。
// ============================================================

(function probePresetLibrary() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();

    var lines = [];
    function flush() {
        var f = new File(OUT.fsName + "/preset_library.txt");
        f.encoding = "UTF-8";
        if (f.open("w")) { f.write(lines.join("\r\n")); f.close(); }
    }
    function log(text) { lines.push(text); flush(); }

    var MODULES = ["engine/store.jsx", "engine/presets.jsx"];
    for (var m = 0; m < MODULES.length; m++) {
        try {
            $.evalFile(new File(EXT + "/" + MODULES[m]));
        } catch (eMod) {
            log("MODULE_FAIL|" + MODULES[m] + "|" + eMod);
            return;
        }
    }

    var source = "C:/Program Files/Adobe/Adobe After Effects 2021/Support Files/Presets/" +
                 "Image - Special Effects/夜视.ffx";

    log("BEFORE|" + AEV_Presets.libraryJson().substring(0, 400));
    log("IMPORT|" + AEV_Presets.importOneJson(source).substring(0, 300));
    log("AFTER|" + AEV_Presets.libraryJson().substring(0, 600));

    /* 再导一次同名文件：应自动加序号，不覆盖 */
    log("IMPORT2|" + AEV_Presets.importOneJson(source).substring(0, 300));
    log("AFTER2|" + AEV_Presets.libraryJson().substring(0, 800));

    log("DONE");
    try {
        app.quit(SaveOptions.DO_NOT_SAVE_CHANGES);
    } catch (eQuit) {
        try {
            app.quit();
        } catch (e2) {}
    }
})();
