// ============================================================
// probe_apply.jsx —— 实机验证「双击预览 → 效果加到选中图层」
//
// 验证链路（每一步都写日志，崩了也能看出停在哪）：
//   1. 建一个合成 + 纯色层，选中该层
//   2. AEV_Apply.addToSelectedJson("ADBE Glo2") → 效果挂上、参数套配方
//   3. 再试一个插件效果（S_Clouds）→ 挂上但一个参数都不动
//   4. 查属性组里的效果数量，确认确实加进去了
//
// 运行：AfterFX.exe -r tools/probe_apply.jsx（先关闭正在运行的 AE）
// 语法：ES3 only。
// ============================================================

(function probeApply() {
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();
    var LOG = OUT.fsName + "/apply_probe.txt";

    function writeText(path, text) {
        var f = new File(path);
        f.encoding = "UTF-8";
        if (f.open("w")) {
            f.write(text);
            f.close();
        }
    }

    var lines = [];
    function log(text) {
        lines.push(String(text));
        writeText(LOG, lines.join("\r\n"));
    }

    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var MODULES = [
        "engine/render_config.jsx",
        "engine/store.jsx",
        "engine/names.jsx",
        "engine/assets.jsx",
        "engine/recipe.jsx",
        "engine/apply.jsx"
    ];
    for (var m = 0; m < MODULES.length; m++) {
        try {
            $.evalFile(new File(EXT + "/" + MODULES[m]));
        } catch (eMod) {
            log("MODULE_FAIL|" + MODULES[m] + "|" + eMod);
            return;
        }
    }
    log("MODULES_OK");

    var comp = null;
    var layer = null;
    try {
        comp = app.project.items.addComp("DE_apply_probe", 320, 240, 1, 2, 30);
        layer = comp.layers.addSolid([0.2, 0.4, 0.6], "bg", 320, 240, 1);
        // AE 2021 上给合成写 selectedLayers 数组会崩 AE —— 用 layer.selected
        layer.selected = true;
        log("COMP_OK|" + comp.name + "|layers=" + comp.numLayers);
    } catch (eComp) {
        log("COMP_FAIL|" + eComp);
        return;
    }

    function effectCount(target) {
        var group = null;
        try {
            group = target.property("ADBE Effect Parade");
        } catch (e) {
            return -1;
        }
        try {
            return group.numProperties;
        } catch (e2) {
            return -1;
        }
    }

    function effectNames(target) {
        var out = [];
        var group = null;
        try {
            group = target.property("ADBE Effect Parade");
        } catch (e) {
            return out;
        }
        for (var i = 1; i <= group.numProperties; i++) {
            try {
                out.push(String(group.property(i).name));
            } catch (e2) {}
        }
        return out.join(",");
    }

    // ---- 1) 内置效果：应挂上并套用显式配方 ----
    var before = effectCount(layer);
    log("BEFORE|" + before);
    var r1 = AEV_Apply.addToSelectedJson("ADBE Glo2");
    log("ADD_BUILTIN|" + r1);
    var after1 = effectCount(layer);
    log("AFTER_BUILTIN|count=" + after1 + "|names=" + effectNames(layer));

    // 配方参数是否真的写进去了（发光半径应为 30）
    try {
        var g = layer.property("ADBE Effect Parade").property(1);
        for (var p = 1; p <= g.numProperties; p++) {
            var prop = g.property(p);
            log("BUILTIN_PARAM|" + String(prop.name) + "|" + String(prop.value));
        }
    } catch (eParam) {
        log("BUILTIN_PARAM_FAIL|" + eParam);
    }

    // ---- 2) 插件效果：应挂上，但参数一个都不动 ----
    var r2 = "";
    try {
        r2 = AEV_Apply.addToSelectedJson("S_Clouds");
    } catch (ePlugin) {
        r2 = "THROW|" + ePlugin;
    }
    log("ADD_PLUGIN|" + r2);
    var after2 = effectCount(layer);
    log("AFTER_PLUGIN|count=" + after2 + "|names=" + effectNames(layer));

    // ---- 3) 没选中层时的行为：应报 no_layer 而不是崩 ----
    try {
        layer.selected = false;
        var r3 = AEV_Apply.addToSelectedJson("ADBE Glo2");
        log("ADD_NO_SELECTION|" + r3);
    } catch (eNone) {
        log("ADD_NO_SELECTION|THROW|" + eNone);
    }

    // ---- 4) 不存在的效果：应报 add_failed 而不是崩 ----
    var r4 = "";
    try {
        r4 = AEV_Apply.addToSelectedJson("NOT_A_REAL_EFFECT_XYZ");
    } catch (eBad) {
        r4 = "THROW|" + eBad;
    }
    log("ADD_BAD|" + r4);

    try {
        comp.remove();
    } catch (eRemove) {}

    log("DONE");
})();
