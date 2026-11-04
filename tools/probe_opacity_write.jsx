// ============================================================
// probe_opacity_write.jsx —— 拆开测「效果不透明度」能不能安全地写
//
// 已知：S_Clouds 在「关调参」时渲得出来，一开调参就报
//   「在需要数字、数组或属性的位置找到类型为 Error 的对象」。
// 调参做了两件事：setValue(70) + setValueAtTime(0→70)。
// 这里把两件事分开测，看是哪一件把效果弄坏的。
//
// 运行：AfterFX.exe -r tools/probe_opacity_write.jsx
// 输出：<我的文档>/DreamEngineProbe/opacity_probe.txt
// 语法：ES3 only。
// ============================================================

(function probeOpacity() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();

    var lines = [];
    function flush() {
        var f = new File(OUT.fsName + "/opacity_probe.txt");
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

    var TARGET = "S_Clouds";
    AEV_Recipe.setTuning(false);

    function render(sheet) {
        return AEV_PreviewGen.renderBatch([TARGET], sheet, {
            outputRoot: "user",
            extensionPath: EXT,
            singleCell: true,
            freshAssets: true,
            frames: 6
        });
    }

    /* 基线：不碰任何参数 */
    log("BASE|" + render(3200).substring(0, 200));

    /* 找到「效果不透明度」属性（名字含「不透明度」或 Opacity，范围 0-100） */
    var comp = app.project.items.addComp("DE_op_probe", 64, 64, 1, 1, 30);
    var layer = comp.layers.addSolid([0.3, 0.5, 0.6], "bg", 64, 64, 1);
    var group = null;
    try {
        group = layer.property("ADBE Effect Parade").addProperty(TARGET);
    } catch (eAdd) {
        log("ADD_FAIL|" + eAdd);
        try { comp.remove(); } catch (eR) {}
        return;
    }

    var opacityProp = null;
    function walk(g, depth) {
        if (depth > 2 || opacityProp) return;
        var count = 0;
        try {
            count = g.numProperties;
        } catch (e) {
            return;
        }
        for (var i = 1; i <= count; i++) {
            var prop = null;
            try {
                prop = g.property(i);
            } catch (e2) {
                continue;
            }
            if (!prop) continue;
            var sub = 0;
            try {
                sub = prop.numProperties;
            } catch (e3) {
                sub = 0;
            }
            if (sub > 0) {
                walk(prop, depth + 1);
                continue;
            }
            var name = "";
            try {
                name = String(prop.name || "");
            } catch (e4) {}
            var maxValue = 0;
            try {
                if (prop.hasMax) maxValue = Number(prop.maxValue);
            } catch (e5) {}
            if (name.indexOf("不透明度") >= 0 || name.toLowerCase().indexOf("opacity") >= 0) {
                if (maxValue >= 90 && maxValue <= 110) {
                    opacityProp = prop;
                    log("FOUND|" + name + "|max=" + maxValue);
                    return;
                }
            }
        }
    }
    walk(group, 0);
    try {
        comp.remove();
    } catch (eR2) {}

    if (!opacityProp) {
        log("NO_OPACITY_PROP");
        log("DONE");
        try {
            app.quit(SaveOptions.DO_NOT_SAVE_CHANGES);
        } catch (eQ) {
            try {
                app.quit();
            } catch (eQ2) {}
        }
        return;
    }

    /* 案例 1：只 setValue(70)，不动画 */
    try {
        opacityProp.setValue(70);
        log("SETVALUE_OK");
    } catch (eSet) {
        log("SETVALUE_FAIL|" + eSet);
    }
    log("AFTER_SETVALUE|" + render(3201).substring(0, 200));

    /* 案例 2：只打关键帧 0 → 70 */
    try {
        opacityProp.setValueAtTime(0, 0);
        opacityProp.setValueAtTime(0.2, 70);
        log("KEYFRAME_OK");
    } catch (eKey) {
        log("KEYFRAME_FAIL|" + eKey);
    }
    log("AFTER_KEYFRAME|" + render(3202).substring(0, 200));

    log("DONE");
    try {
        app.quit(SaveOptions.DO_NOT_SAVE_CHANGES);
    } catch (eQuit) {
        try {
            app.quit();
        } catch (e2) {}
    }
})();
