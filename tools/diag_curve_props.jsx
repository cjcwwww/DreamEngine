/* ============================================================
 * diag_curve_props.jsx —— 只读诊断：曲线面板为什么写不进去
 *
 * 面板报「写入被拒：write_failed」时跑这个：
 * 它列出 AE 里当前选中的属性，逐条给出「能不能吃 temporal ease」，
 * 以及会被新的 isNumericValue() 过滤掉哪几条。
 *
 * 全程只读，不改工程、不新增合成。
 * 结果写到 Documents/DreamEngineProbe/m4_props.txt
 *
 * 用法：AfterFX.exe -r "…/tools/diag_curve_props.jsx"
 * ============================================================ */

(function () {
    var OUT_DIR = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    var OUT_FILE = new File(OUT_DIR.fsName + "/m4_props.txt");
    var L = [];

    function isArr(v) {
        if (!v) return false;
        try {
            return typeof v.length === "number" && typeof v !== "string";
        } catch (e) {
            return false;
        }
    }

    function typeName(v) {
        if (v === null) return "null";
        if (v === undefined) return "undefined";
        var t = typeof v;
        if (t !== "object") return t;
        if (isArr(v)) return "array[" + v.length + "]";
        try {
            if (typeof Shape !== "undefined" && v instanceof Shape) return "Shape";
        } catch (e1) {}
        try {
            if (typeof TextDocument !== "undefined" && v instanceof TextDocument) return "TextDocument";
        } catch (e2) {}
        try {
            if (typeof MarkerValue !== "undefined" && v instanceof MarkerValue) return "MarkerValue";
        } catch (e3) {}
        return "object";
    }

    function isNumeric(prop) {
        var v;
        try {
            v = prop.value;
        } catch (e) {
            return false;
        }
        if (typeof v === "number") return true;
        if (isArr(v)) return true;
        return false;
    }

    function describe(prop, depth) {
        var pad = "";
        for (var p = 0; p < depth; p++) pad += "  ";
        var name = "?", keys = 0, vt = "?", spatial = "?";
        try { name = prop.name; } catch (e1) {}
        try { keys = prop.numKeys; } catch (e2) {}
        var valueType = "?";
        try { valueType = typeName(prop.value); } catch (e3) {}
        try { vt = String(prop.propertyValueType); } catch (e4) {}
        try { spatial = String(!!prop.isSpatial); } catch (e5) {}

        var line = pad + "· " + name +
            " | keys=" + keys +
            " | value=" + valueType +
            " | vt=" + vt +
            " | spatial=" + spatial +
            " | 可写ease=" + (keys > 0 ? (isNumeric(prop) ? "是" : "否") : "无关键帧");
        L.push(line);
        return isNumeric(prop);
    }

    L.push("AE=" + app.version + "  时间=" + new Date().toString());

    var comp = null;
    try {
        var active = app.project.activeItem;
        if (active && typeof active.numLayers === "number") comp = active;
    } catch (e0) {}

    if (!comp) {
        L.push("没有打开的合成。");
    } else {
        L.push("合成=" + comp.name + "  尺寸=" + comp.width + "x" + comp.height);

        var sp = [];
        try { sp = comp.selectedProperties || []; } catch (e1) {}
        L.push("");
        L.push("=== 选中的属性（selectedProperties = " + sp.length + "）===");
        var usable = 0;
        var filtered = 0;
        for (var i = 0; i < sp.length; i++) {
            var ok = describe(sp[i], 0);
            var k = 0;
            try { k = sp[i].numKeys; } catch (e2) {}
            if (k > 0) {
                if (ok) usable++;
                else filtered++;
            }
        }
        L.push("可写 ease 的：" + usable + " 条；不支持缓动：" + filtered + " 条");

        var sl = [];
        try { sl = comp.selectedLayers || []; } catch (e3) {}
        L.push("");
        L.push("=== 选中的图层（selectedLayers = " + sl.length + "）===");
        for (var l = 0; l < sl.length; l++) {
            var layer = sl[l];
            var lname = "?";
            try { lname = layer.name; } catch (e4) {}
            L.push("- " + lname);

            var lp = [];
            try { lp = layer.selectedProperties || []; } catch (e5) {}
            if (lp.length) {
                L.push("  图层内选中的属性：");
                for (var j = 0; j < lp.length; j++) describe(lp[j], 2);
            } else {
                L.push("  （图层里没单独选属性 → 面板会遍历整层）");
                var n = 0;
                try { n = layer.numProperties; } catch (e6) {}
                for (var g = 1; g <= n && g <= 12; g++) {
                    var grp = null;
                    try { grp = layer.property(g); } catch (e7) {}
                    if (!grp) continue;
                    var gn = "?";
                    try { gn = grp.name; } catch (e8) {}
                    var gk = 0;
                    try { gk = grp.numKeys; } catch (e9) {}
                    L.push("  ▸ " + gn + (gk > 0 ? "（本身有关键帧 keys=" + gk + "）" : ""));
                }
            }
        }
    }

    L.push("");
    L.push("提示：如果「不支持缓动」大于 0，说明选中的属性里有路径/文本/标记类，");
    L.push("      面板会跳过它们（旧版会因此整批 write_failed）。");

    try {
        OUT_DIR.create();
    } catch (e10) {}
    try {
        OUT_FILE.encoding = "UTF-8";
        if (OUT_FILE.open("w")) {
            OUT_FILE.write(L.join("\n"));
            OUT_FILE.close();
        }
    } catch (e11) {}

    // 不弹 alert：用户可能不在电脑前
})();
