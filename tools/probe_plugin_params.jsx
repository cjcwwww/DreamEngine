// ============================================================
// probe_plugin_params.jsx —— 抓插件效果的真实参数清单
//
// 目的：决定「插件参数该不该拨、拨到多少」必须有依据，不能拍脑袋。
// 这里把每个效果的一维数值参数（名称 / 当前值 / 上下限）全列出来，
// 用来区分「强度类」「尺寸类」「角度类」，其余一律不动。
//
// 运行：AfterFX.exe -r tools/probe_plugin_params.jsx
// 输出：<我的文档>/DreamEngineProbe/plugin_params.txt
// 语法：ES3 only。
// ============================================================

(function probePluginParams() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();

    var lines = [];
    function flush() {
        var f = new File(OUT.fsName + "/plugin_params.txt");
        f.encoding = "UTF-8";
        if (f.open("w")) { f.write(lines.join("\r\n")); f.close(); }
    }
    function log(text) { lines.push(text); flush(); }

    var TARGETS = [
        "S_Clouds",
        "S_CloudsPsyko",
        "S_CloudsVortex",
        "S_CloudsPerspective",
        "BCC_AMBIENTLIGHT",
        "S_ChannelSwitcher",
        "S_BrightnessContrast",
        "ADBE Glo2"
    ];

    var MODULES = ["engine/catalog.jsx", "engine/recipe.jsx"];
    for (var m = 0; m < MODULES.length; m++) {
        try {
            $.evalFile(new File(EXT + "/" + MODULES[m]));
        } catch (eMod) {
            log("MODULE_FAIL|" + MODULES[m] + "|" + eMod);
            return;
        }
    }

    for (var t = 0; t < TARGETS.length; t++) {
        var name = TARGETS[t];
        var comp = app.project.items.addComp("DE_param_probe_" + t, 64, 64, 1, 1, 30);
        var layer = comp.layers.addSolid([0.3, 0.5, 0.6], "bg", 64, 64, 1);
        var group = null;
        try {
            group = layer.property("ADBE Effect Parade").addProperty(name);
        } catch (eAdd) {
            log("---- " + name + " ----");
            log("ADD_FAIL|" + eAdd);
            try { comp.remove(); } catch (eR) {}
            continue;
        }
        log("---- " + name + " ----");
        var count = 0;
        try {
            count = group.numProperties;
        } catch (eC) {
            count = 0;
        }
        for (var p = 1; p <= count; p++) {
            var prop = null;
            try {
                prop = group.property(p);
            } catch (eP) {
                continue;
            }
            if (!prop) continue;
            var propName = "";
            try {
                propName = String(prop.name || "");
            } catch (eN) {}
            var type = "";
            try {
                type = String(prop.propertyValueType);
            } catch (eT) {}
            var sub = 0;
            try {
                sub = prop.numProperties;
            } catch (eS) {
                sub = 0;
            }
            if (sub > 0) {
                // 组：把子属性也列出来（插件常把滑杆包在组里）
                for (var q = 1; q <= sub; q++) {
                    var sub2 = null;
                    try {
                        sub2 = prop.property(q);
                    } catch (eQ) {
                        continue;
                    }
                    if (!sub2) continue;
                    log(paramLine(propName + " / " + String(sub2.name || ""), sub2));
                }
                continue;
            }
            log(paramLine(propName, prop));
        }
        try { comp.remove(); } catch (eR2) {}
    }

    function paramLine(label, prop) {
        var type = "?";
        try {
            type = String(prop.propertyValueType);
        } catch (e1) {}
        var value = "?";
        try {
            var v = prop.value;
            if (v && v.length !== undefined) {
                var parts = [];
                for (var i = 0; i < v.length; i++) parts.push(String(v[i]));
                value = "[" + parts.join(",") + "]";
            } else {
                value = String(v);
            }
        } catch (e2) {}
        var min = "";
        var max = "";
        try {
            if (prop.hasMin) min = String(prop.minValue);
            if (prop.hasMax) max = String(prop.maxValue);
        } catch (e3) {}
        return "  " + label + " | type=" + type + " | value=" + value +
               " | min=" + min + " | max=" + max;
    }

    log("DONE");
    try {
        app.quit(SaveOptions.DO_NOT_SAVE_CHANGES);
    } catch (eQuit) {
        try { app.quit(); } catch (e2) {}
    }
})();
