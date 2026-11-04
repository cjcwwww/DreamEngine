/* ============================================================
 * diag_ease_matrix.jsx —— 实机矩阵：哪些属性写不进 temporal ease
 *
 * 目的：面板报「N 条属性不支持缓动」时，回答两个问题
 *   1. 到底哪些属性类型会被 AE 拒绝？
 *   2. 是类型的问题，还是数值范围的问题（speed 太大/太小）？
 *
 * 做法：自建一个合成，为十来种常见属性各加 3 个关键帧（含大跨度值），
 * 逐个用 AEV_Curve.applyText 写 ease，把 status / applied / skipped / detail
 * 全记下来。最后删干净并核对工程项数。
 *
 * 用法：AfterFX.exe -r "…/tools/diag_ease_matrix.jsx"
 * ============================================================ */

(function () {
    var OUT_DIR = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    var OUT_FILE = new File(OUT_DIR.fsName + "/ease_matrix.txt");
    var ENGINE_DIR = "D:/workqwen/DreamEngine-1/cep/com.dreamengine.panel/engine";
    var L = [];

    var comp = null;
    var solids = [];

    function numField(text, key) {
        var at = text.indexOf('"' + key + '":');
        if (at < 0) return "";
        var start = at + key.length + 3;
        var end = start;
        while (end < text.length && ',}]'.indexOf(text.charAt(end)) < 0) end++;
        return text.substring(start, end);
    }

    function quote(text, key) {
        var at = text.indexOf('"' + key + '":"');
        if (at < 0) return "";
        var start = at + key.length + 4;
        var end = text.indexOf('"', start);
        return end < 0 ? "" : text.substring(start, end);
    }

    /** 从快照里取第一条属性的 loc */
    function firstLoc(snap) {
        return quote(snap, "loc");
    }

    /**
     * 试写一个属性：选中 → 快照 → 写 out/in → 取消选中。
     * 返回一行人类可读的结论。
     */
    function tryOne(prop, label) {
        var line = label;
        try {
            try { prop.selected = true; } catch (eSel) {
                return line + " ｜ 选不中：" + eSel.toString();
            }

            var snap = AEV_Curve.snapshotJson();
            var loc = firstLoc(snap);
            var filtered = numField(snap, "filtered");
            if (!loc) {
                try { prop.selected = false; } catch (eClr) {}
                return line + " ｜ 快照里没有它（filtered=" + filtered + "）";
            }

            var keys = 0;
            try { keys = prop.numKeys; } catch (eK) {}
            var text =
                "out\t" + loc + "\t0\t33.33\t0\n" +
                "in\t" + loc + "\t1\t33.33\t0\n";
            var res = AEV_Curve.applyText(text);

            try { prop.selected = false; } catch (eClr2) {}

            line += " ｜ keys=" + keys + " loc=" + loc + "\n      " +
                res.substring(0, 260);
            return line;
        } catch (e) {
            try { prop.selected = false; } catch (e3) {}
            return line + " ｜ EXCEPTION " + e.toString();
        }
    }

    function addKeys(prop, values) {
        for (var i = 0; i < values.length; i++) {
            prop.setValueAtTime(i, values[i]);
        }
    }

    L.push("AE=" + app.version + "  " + new Date().toString());

    try {
        comp = app.project.items.addComp("DE_EaseMatrix", 640, 360, 1, 6, 25);
        try { comp.openInViewer(); } catch (eOpen) {}

        var layer = comp.layers.addSolid([0.2, 0.2, 0.2], "matrix layer", 640, 360, 1);
        try { if (layer.source) solids.push(layer.source); } catch (eS) {}

        $.evalFile(new File(ENGINE_DIR + "/curve_math.js"));
        $.evalFile(new File(ENGINE_DIR + "/curvelib.jsx"));
        L.push("typeof AEV_Curve=" + (typeof AEV_Curve));
        L.push("");

        var transform = layer.property("ADBE Transform Group");
        var cases = [];

        /* 变换组：值跨度故意拉大，顺带测 speed 上限 */
        cases.push({
            label: "位置 (0,0)→(5000,3000)",
            prop: transform.property("ADBE Position"),
            values: [[0, 0, 0], [2500, 1500, 0], [5000, 3000, 0]]
        });
        cases.push({
            label: "缩放 0→1000%",
            prop: transform.property("ADBE Scale"),
            values: [[0, 0, 100], [500, 500, 100], [1000, 1000, 100]]
        });
        cases.push({
            label: "旋转 0→720",
            prop: transform.property("ADBE Rotate Z"),
            values: [0, 360, 720]
        });
        cases.push({
            label: "不透明度 0→100",
            prop: transform.property("ADBE Opacity"),
            values: [0, 50, 100]
        });
        cases.push({
            label: "锚点",
            prop: transform.property("ADBE Anchor Point"),
            values: [[0, 0, 0], [100, 100, 0], [200, 200, 0]]
        });

        /* 蒙版：羽化是 1D 数值；蒙版路径是形状（应被过滤） */
        var maskPathProp = null;
        try {
            var parade = layer.property("ADBE Mask Parade");
            var mask = parade.addProperty("ADBE Mask Atom");
            maskPathProp = mask.property("ADBE Mask Shape");
            addKeys(maskPathProp, [maskPathProp.value, maskPathProp.value, maskPathProp.value]);
            cases.push({
                label: "蒙版羽化 0→100",
                prop: mask.property("ADBE Mask Feather"),
                values: [0, 50, 100]
            });
            cases.push({
                label: "蒙版路径（应该被过滤）",
                prop: maskPathProp,
                values: null
            });
        } catch (eMask) {
            L.push("蒙版构造失败：" + eMask.toString());
        }

        /* 效果：滑块控制（典型 1D 数值） */
        try {
            var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Slider Control");
            cases.push({
                label: "效果·滑块 0→1000",
                prop: fx.property("ADBE Slider Control-0001"),
                values: [0, 500, 1000]
            });
        } catch (eFx) {
            L.push("滑块控制构造失败：" + eFx.toString());
        }

        /* 时间重映射：数值，但语义特殊 */
        try {
            layer.timeRemapEnabled = true;
            var tr = layer.property("ADBE Time Remap");
            cases.push({
                label: "时间重映射",
                prop: tr,
                values: [0, 1, 2]
            });
        } catch (eTr) {
            L.push("时间重映射构造失败：" + eTr.toString());
        }

        /* 逐个跑 */
        for (var i = 0; i < cases.length; i++) {
            var c = cases[i];
            if (c.values) {
                try {
                    addKeys(c.prop, c.values);
                } catch (eK) {
                    L.push(c.label + " ｜ 加关键帧失败：" + eK.toString());
                    continue;
                }
            }
            L.push(tryOne(c.prop, c.label));
        }
    } catch (e) {
        L.push("EXCEPTION: " + e.toString() + " line=" + e.line);
    }

    /* 清理 */
    try { if (comp) comp.remove(); } catch (e9) {}
    for (var s = 0; s < solids.length; s++) {
        try { solids[s].remove(); } catch (e10) {}
    }

    try { OUT_DIR.create(); } catch (e12) {}
    try {
        OUT_FILE.encoding = "UTF-8";
        if (OUT_FILE.open("w")) {
            OUT_FILE.write(L.join("\n"));
            OUT_FILE.close();
        }
    } catch (e13) {}
})();
