// ============================================================
// dump_param_trees.jsx —— 批量导出常用效果的参数清单
//
// 用途：写配方必须知道本机真实参数名。中文界面下 prop.name 是「模糊度」而不是
// "Blurriness"，靠猜英文名会大面积落空。这里把常用效果的顶层参数全导出来。
//
// 输出：<我的文档>/DreamEngineProbe/param_trees.tsv
//   matchName \t 参数名 \t 类型 \t min \t max
//
// 运行方式：AE 菜单 文件 > 脚本 > 运行脚本文件
// 语法：ES3 only。
// ============================================================

(function dumpParamTrees() {
    var TARGETS = [
        "ADBE Gaussian Blur 2", "ADBE Box Blur2", "ADBE Radial Blur",
        "ADBE Directional Blur", "ADBE Sharpen", "ADBE Unsharp Mask2",
        "ADBE Brightness & Contrast 2", "ADBE HUE SATURATION", "ADBE Tint",
        "ADBE CurvesCustom", "ADBE Easy Levels2", "ADBE Color Balance2",
        "ADBE Invert", "ADBE Mosaic", "ADBE Find Edges", "ADBE Glo2",
        "ADBE Turbulent Displace", "ADBE Wave Warp", "ADBE Ripple",
        "ADBE Bulge", "ADBE Twirl", "ADBE Polar Coordinates",
        "ADBE Drop Shadow", "ADBE Bevel Alpha", "ADBE Fractal Noise",
        "ADBE Ramp", "ADBE Stroke", "ADBE Fill"
    ];

    var ext = new Folder(Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel");
    var outDir = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!outDir.exists) outDir.create();

    var tsv = new File(outDir.fsName + "/param_trees.tsv");
    tsv.encoding = "UTF-8";
    var lines = ["matchName\tparamName\ttype\tmin\tmax"];

    var TYPE_NAMES = null;
    function typeMap() {
        if (TYPE_NAMES) return TYPE_NAMES;
        var map = {};
        try {
            map[String(PropertyValueType.OneD)] = "OneD";
            map[String(PropertyValueType.TwoD)] = "TwoD";
            map[String(PropertyValueType.TwoD_SPATIAL)] = "TwoD_Spatial";
            map[String(PropertyValueType.ThreeD)] = "ThreeD";
            map[String(PropertyValueType.ThreeD_SPATIAL)] = "ThreeD_Spatial";
            map[String(PropertyValueType.COLOR)] = "Color";
            map[String(PropertyValueType.LAYER_INDEX)] = "LayerIndex";
            map[String(PropertyValueType.MASK_INDEX)] = "MaskIndex";
            map[String(PropertyValueType.SHAPE)] = "Shape";
            map[String(PropertyValueType.TEXT_DOCUMENT)] = "TextDocument";
        } catch (e) {}
        TYPE_NAMES = map;
        return map;
    }

    function nameOfType(prop) {
        try {
            var t = prop.propertyValueType;
            if (t === undefined || t === null) return "";
            return typeMap()[String(t)] || String(t);
        } catch (e) {
            return "";
        }
    }

    function cell(v) {
        var s = (v === undefined || v === null) ? "" : String(v);
        return s.replace(/\t/g, " ").replace(/[\r\n]+/g, " ");
    }

    for (var i = 0; i < TARGETS.length; i++) {
        var matchName = TARGETS[i];
        var comp = null;
        try {
            comp = app.project.items.addComp("DE_dump_" + i, 256, 256, 1, 0.1, 30);
            var layer = comp.layers.addSolid([0.5, 0.5, 0.5], "s", 256, 256, 1);
            var effect = layer.property("ADBE Effect Parade").addProperty(matchName);
            var count = effect.numProperties;
            lines.push("#EFFECT\t" + cell(matchName) + "\t" + cell(count) + "\t\t");
            for (var p = 1; p <= count; p++) {
                var prop = null;
                try { prop = effect.property(p); } catch (eP) { continue; }
                if (!prop) continue;
                var hasChildren = false;
                try { hasChildren = (prop.numProperties || 0) > 0; } catch (eC) {}
                var minText = "";
                var maxText = "";
                try { if (prop.hasMin) minText = String(prop.minValue); } catch (eMin) {}
                try { if (prop.hasMax) maxText = String(prop.maxValue); } catch (eMax) {}
                lines.push([
                    cell(matchName),
                    cell(prop.name),
                    cell(nameOfType(prop)) + (hasChildren ? "+" : ""),
                    cell(minText),
                    cell(maxText)
                ].join("\t"));
            }
        } catch (e) {
            lines.push("#FAIL\t" + cell(matchName) + "\t" + cell(e.toString()) + "\t\t");
        } finally {
            try { if (comp) comp.remove(); } catch (eRm) {}
        }
    }

    lines.push("#DONE\t" + TARGETS.length + "\t\t\t");
    tsv.open("w");
    tsv.write(lines.join("\r\n"));
    tsv.close();
})();
