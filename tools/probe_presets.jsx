// ============================================================
// probe_presets.jsx —— 预设库实机验证
//
// 验证三件事：
//   1. 能扫到 AE 内置预设目录下的 .ffx（递归）
//   2. applyJson 的安全包装真的有效：只选目标层、比对效果数、
//      自动新建的图层被 remove() 掉（图层数不残留）
//   3. 依赖检查能列出合成里用到但本机没装的效果
//
// 运行：AfterFX.exe -r tools/probe_presets.jsx
// 输出：<我的文档>/DreamEngineProbe/preset_probe.txt
// 语法：ES3 only。
// ============================================================

(function probePresets() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();

    var lines = [];
    function flush() {
        var f = new File(OUT.fsName + "/preset_probe.txt");
        f.encoding = "UTF-8";
        if (f.open("w")) { f.write(lines.join("\r\n")); f.close(); }
    }
    function log(text) { lines.push(text); flush(); }

    var MODULES = [
        "engine/render_config.jsx",
        "engine/store.jsx",
        "engine/assets.jsx",
        "engine/recipe.jsx",
        "engine/previewgen.jsx",
        "engine/catalog.jsx",
        "engine/presets.jsx"
    ];
    for (var m = 0; m < MODULES.length; m++) {
        try {
            $.evalFile(new File(EXT + "/" + MODULES[m]));
        } catch (eMod) {
            log("MODULE_FAIL|" + MODULES[m] + "|" + eMod);
            return;
        }
    }

    /* 0) 诊断：AE 安装目录能不能列出来 */
    var diag = [];
    try {
        var base = new Folder("C:/Program Files/Adobe");
        diag.push("base_exists=" + base.exists);
        var fs = base.getFiles();
        diag.push("entries=" + fs.length);
        for (var d = 0; d < fs.length && d < 12; d++) {
            diag.push((fs[d] instanceof Folder ? "D:" : "F:") + fs[d].name);
        }
    } catch (eDiag) {
        diag.push("ERR:" + eDiag);
    }
    log("DIAG|" + diag.join(" | "));

    /* 1) 内置预设目录 */
    var roots = AEV_Presets.defaultRootJson();
    log("ROOTS|" + roots);
    var root = "";
    var parsed = eval("(" + roots + ")");
    for (var i = 0; i < parsed.candidates.length; i++) {
        if (parsed.candidates[i].exists) { root = parsed.candidates[i].path; break; }
    }
    if (!root) {
        log("NO_PRESET_ROOT");
        return;
    }

    /* 2) 扫描 */
    var scan = AEV_Presets.scanJson(root, 800);
    log("SCAN|" + scan.substring(0, 200));
    var scanned = eval("(" + scan + ")");
    log("SCAN_COUNT|" + scanned.count + "|TOTAL|" + scanned.total);
    if (!scanned.count) {
        log("NOTHING_FOUND");
        return;
    }

    /* 挑一个「效果类」预设（Image - Special Effects 之类） */
    var target = null;
    for (var t = 0; t < scanned.items.length; t++) {
        if (String(scanned.items[t].category).indexOf("Image") >= 0) {
            target = scanned.items[t];
            break;
        }
    }
    if (!target) target = scanned.items[0];
    log("TARGET|" + target.name + "|" + target.category + "|" + target.path);

    /* 3) 建一个临时合成：纯色层 + 文本层，测不同图层类型 */
    var comp = app.project.items.addComp("DE_preset_probe", 320, 240, 1, 2, 30);
    var solid = comp.layers.addSolid([0.2, 0.5, 0.6], "solid", 320, 240, 1);
    var text = comp.layers.addText("Ae");
    log("COMPOSITE|" + comp.name + "|layers=" + comp.numLayers);

    var before = comp.numLayers;
    var applied = AEV_Presets.applyJson(comp.name, target.path, 0);
    log("APPLY|" + applied);
    var after = comp.numLayers;
    log("LAYERS_BEFORE|" + before + "|LAYERS_AFTER|" + after);
    log("VERDICT_LAYERS|" + (after === before ? "CLEAN" : "LEFTOVER"));

    /* 4) 依赖检查 */
    var deps = AEV_Presets.dependenciesJson(comp.name);
    log("DEPS|" + deps.substring(0, 400));

    try { comp.remove(); } catch (e) {}

    log("DONE");
    try {
        app.quit(SaveOptions.DO_NOT_SAVE_CHANGES);
    } catch (eQuit) {
        try { app.quit(); } catch (e2) {}
    }
})();
