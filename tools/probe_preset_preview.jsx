// ============================================================
// probe_preset_preview.jsx —— 实机验证「预设预览生成」链路
//
// 跑法（先关闭正在使用的 AE，否则 -r 的新实例会被转发到旧实例）：
//   AfterFX.exe -r tools/probe_preset_preview.jsx
// 输出：<我的文档>/DreamEngineProbe/preset_preview.txt
//
// 验证点：
//   1. 静态预设 → frames=1 / animated=false
//   2. 含关键帧预设 → 覆盖 keyStart..keyEnd、均匀抽 ≤6 帧
//   3. 换背景能重新生成、PNG 产物确实落盘
//   4. 渲染完全在临时合成里做，用户工程图层数不变
//   5. 含第三方插件的预设被跳过（不会杀 AE）
// ============================================================

(function probePresetPreview() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();

    var lines = [];
    function flush() {
        var f = new File(OUT.fsName + "/preset_preview.txt");
        f.encoding = "UTF-8";
        if (f.open("w")) { f.write(lines.join("\r\n")); f.close(); }
    }
    function log(text) { lines.push(text); flush(); }
    function pad(value, width) {
        var t = String(value);
        while (t.length < width) t = "0" + t;
        return t;
    }

    var MODULES = [
        "engine/render_config.jsx",
        "engine/store.jsx",
        "engine/assets.jsx",
        "engine/recipe.jsx",
        "engine/preset_preview.jsx"
    ];
    for (var m = 0; m < MODULES.length; m++) {
        var file = new File(EXT + "/" + MODULES[m]);
        if (!file.exists) { log("MODULE_MISSING|" + MODULES[m]); return; }
        try {
            $.evalFile(file);
        } catch (eMod) {
            log("MODULE_FAIL|" + MODULES[m] + "|" + eMod);
            return;
        }
    }
    if (typeof AEV_PresetPreview === "undefined") {
        log("NO_MODULE|AEV_PresetPreview");
        return;
    }

    log("AE_VERSION|" + app.version);
    log("BACKGROUNDS|" + AEV_PresetPreview.backgroundsJson().substring(0, 400));
    log("PROJECT_ITEMS_BEFORE|" + app.project.items.length);

    /* 挑库内前 3 个 .ffx；库为空就用 AE 自带的「夜视」 */
    var lib = new Folder(Folder.myDocuments.fsName + "/DreamEngine/presets");
    var picked = [];
    if (lib.exists) {
        var all = lib.getFiles();
        for (var a = 0; a < all.length && picked.length < 3; a++) {
            if (!(all[a] instanceof File)) continue;
            if (!/\.ffx$/i.test(String(all[a].name))) continue;
            picked.push(all[a]);
        }
    }
    if (!picked.length) {
        var builtin = new File(
            "C:/Program Files/Adobe/Adobe After Effects 2021/Support Files/Presets/" +
            "Image - Special Effects/夜视.ffx"
        );
        if (builtin.exists) picked.push(builtin);
    }
    log("FOUND|" + picked.length);
    if (!picked.length) { log("DONE|no_presets"); return; }

    for (var i = 0; i < picked.length; i++) {
        var sheet = 900 + i;
        var opts = { extensionPath: EXT, background: "photo", cellSize: 128 };
        var beforeItems = app.project.items.length;
        var raw = "";
        try {
            raw = AEV_PresetPreview.renderJson(picked[i].fsName, sheet, opts);
        } catch (eRender) {
            log("RENDER_THROW|" + picked[i].name + "|" + eRender);
            continue;
        }
        log("RENDER|" + picked[i].name + "|" + raw.substring(0, 500));
        var data = null;
        try { data = eval("(" + raw + ")"); } catch (eParse) { data = null; }
        if (data && data.status === "ok") {
            var frames = Number(data.frames) || 1;
            for (var f = 0; f < frames; f++) {
                var png = new File(EXT + "/data/thumbs/preset_" + pad(sheet, 3) +
                                   "_" + pad(f, 4) + ".png");
                log("FILE|" + png.name + "|" + (png.exists ? png.length + " bytes" : "MISSING"));
            }
        }
        // 临时合成/素材必须全部回收，工程 item 数不能涨
        log("ITEMS_DELTA|" + picked[i].name + "|" + (app.project.items.length - beforeItems));
    }

    /* 换一个内置背景再渲一次，确认背景参数真的参与了渲染 */
    var opts2 = { extensionPath: EXT, background: "pattern", cellSize: 128 };
    var second = AEV_PresetPreview.renderJson(picked[0].fsName, 910, opts2);
    log("RENDER_PATTERN|" + picked[0].name + "|" + second.substring(0, 400));

    log("PROJECT_ITEMS_AFTER|" + app.project.items.length);
    log("DONE");

    try {
        app.quit(SaveOptions.DO_NOT_SAVE_CHANGES);
    } catch (eQuit) {
        try { app.quit(); } catch (e2) {}
    }
})();
