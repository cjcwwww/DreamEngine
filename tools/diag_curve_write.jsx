/* ============================================================
 * diag_curve_write.jsx —— 实机验证：路径属性和数值属性混选时能不能写进去
 *
 * 背景：面板曾报「写入被拒：write_failed」。根因是蒙版路径 / 形状路径 /
 * 源文本这类属性的关键帧没有时间缓动，把 ease 写进去 AE 会抛异常，
 * 而那一抛会把整批写入变成失败。
 *
 * 这个脚本自建一个合成，同时选中「位置」（数值，能写）与「蒙版路径」
 * （形状，不能写），然后：
 *   1. 跑 AEV_Curve.snapshotJson() → 看 props 里是不是只有位置、filtered 是不是 1
 *   2. 跑 AEV_Curve.applyText(...)   → 看 applied 是否 > 0、有没有 failed
 * 全程只动自己建的合成，收尾删干净并核对工程项数。
 *
 * 用法：AfterFX.exe -r "…/tools/diag_curve_write.jsx"
 * ============================================================ */

(function () {
    var OUT_DIR = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    var OUT_FILE = new File(OUT_DIR.fsName + "/m4_write_diag.txt");
    var ENGINE_DIR = "D:/workqwen/DreamEngine-1/cep/com.dreamengine.panel/engine";
    var CURVE_MATH = new File(ENGINE_DIR + "/curve_math.js");
    var CURVE = new File(ENGINE_DIR + "/curvelib.jsx");
    var L = [];

    function numField(text, key) {
        var at = text.indexOf('"' + key + '":');
        if (at < 0) return -1;
        var start = at + key.length + 3;
        var end = start;
        while (end < text.length && "0123456789-.".indexOf(text.charAt(end)) >= 0) end++;
        return parseFloat(text.substring(start, end));
    }

    function strField(text, key) {
        var at = text.indexOf('"' + key + '":"');
        if (at < 0) return "";
        var start = at + key.length + 4;
        var end = text.indexOf('"', start);
        return end < 0 ? "" : text.substring(start, end);
    }

    L.push("AE=" + app.version);

    var itemsBefore = 0;
    try { itemsBefore = app.project.items.length; } catch (e0) {}

    var comp = null;
    var solids = [];

    try {
        /* ---- 1. 自建场景 ---- */
        var prevActive = null;
        try { prevActive = app.project.activeItem; } catch (eP) {}
        comp = app.project.items.addComp("DE_WriteDiag", 640, 360, 1, 4, 25);
        /* addComp 只是建出来，不一定成为 activeItem；引擎只认 activeItem，
           不激活的话它读的是用户原来那个合成 —— 于是「选中 3 条属性」
           却「props 0 条」。 */
        try { comp.openInViewer(); } catch (eOpen) {
            L.push("openInViewer 失败：" + eOpen.toString());
        }
        var activeName = "";
        try { activeName = app.project.activeItem ? app.project.activeItem.name : "(none)"; } catch (eA) {}
        L.push("activeItem=" + activeName);
        var layer = comp.layers.addSolid([0.2, 0.2, 0.2], "diag layer", 640, 360, 1);
        try { if (layer.source) solids.push(layer.source); } catch (eS) {}

        // 位置：3 把关键帧（数值属性，能吃 ease）
        var pos = layer.property("ADBE Transform Group").property("ADBE Position");
        pos.setValueAtTime(0, [100, 100]);
        pos.setValueAtTime(1, [400, 220]);
        pos.setValueAtTime(2, [560, 320]);

        // 蒙版路径：2 把关键帧（形状属性，没有 temporal ease）
        var maskPath = null;
        try {
            var parade = layer.property("ADBE Mask Parade");
            var mask = parade.addProperty("ADBE Mask Atom");
            maskPath = mask.property("ADBE Mask Shape");
            maskPath.setValueAtTime(0, maskPath.value);
            maskPath.setValueAtTime(1, maskPath.value);
        } catch (eMask) {
            L.push("蒙版路径构造失败：" + eMask.toString());
        }

        L.push("位置 keys=" + pos.numKeys +
            " value=" + (typeof pos.value) +
            "  ｜ 蒙版路径 keys=" + (maskPath ? maskPath.numKeys : "n/a") +
            " value=" + (maskPath ? typeof maskPath.value : "n/a"));

        /* ---- 2. 同时选中两者 ---- */
        var selOk = "no";
        try {
            pos.selected = true;
            if (maskPath) maskPath.selected = true;
            selOk = "yes";
        } catch (eSel) {
            L.push("设置 selected 失败：" + eSel.toString());
        }
        var spCount = 0;
        try { spCount = comp.selectedProperties.length; } catch (e2) {}
        L.push("选中属性数=" + spCount + "（selected 可写=" + selOk + "）");

        /* ---- 3. 加载引擎并读快照 ---- */
        if (!CURVE.exists || !CURVE_MATH.exists) {
            L.push("找不到引擎文件：" + CURVE.fsName);
        } else {
            // 与 bridge 的加载顺序一致：curve_math 必须先于 curvelib
            $.evalFile(CURVE_MATH);
            $.evalFile(CURVE);
            L.push("typeof AEV_Curve=" + (typeof AEV_Curve));

            var snap = AEV_Curve.snapshotJson();
            L.push("");
            L.push("--- snapshotJson ---");
            L.push("props 数量=" + (function () {
                var at = snap.indexOf('"props":[');
                if (at < 0) return "?";
                var body = snap.substring(at + 9);
                var n = 0;
                var depth = 0;
                for (var i = 0; i < body.length; i++) {
                    var c = body.charAt(i);
                    if (c === "{") { if (depth === 0) n++; depth++; }
                    else if (c === "}") depth--;
                    else if (c === "]" && depth === 0) break;
                }
                return n;
            })());
            L.push("filtered=" + numField(snap, "filtered"));
            L.push("status=" + strField(snap, "status"));

            var posLoc = "";
            var at2 = snap.indexOf('"name":"位置"');
            if (at2 < 0) at2 = snap.indexOf('"name":"Position"');
            if (at2 >= 0) {
                var back = snap.lastIndexOf('"loc":"', at2);
                if (back >= 0) {
                    var s2 = back + 7;
                    var e2b = snap.indexOf('"', s2);
                    posLoc = snap.substring(s2, e2b);
                }
            }
            L.push("位置的 loc=" + posLoc);

            /* ---- 4. 写一条 ease（相当于面板点「应用」） ---- */
            if (posLoc) {
                var text = "expect\t" + posLoc + "\t" + strField(
                    snap.substring(snap.indexOf('"loc":"' + posLoc + '"')),
                    "sig") + "\n" +
                    "out\t" + posLoc + "\t0\t33.33\t0\n" +
                    "in\t" + posLoc + "\t1\t33.33\t0\n";
                // 指纹：直接从快照里取该属性的 sig（上面那步可能取不到，失败就让 AE 自己判）
                if (text.indexOf("expect\t" + posLoc + "\t\n") >= 0) {
                    text = "out\t" + posLoc + "\t0\t33.33\t0\n" +
                        "in\t" + posLoc + "\t1\t33.33\t0\n";
                }
                var res = AEV_Curve.applyText(text);
                L.push("");
                L.push("--- applyText ---");
                L.push("status=" + strField(res, "status"));
                L.push("applied=" + numField(res, "applied"));
                L.push("reason=" + strField(res, "reason"));
                L.push("detail=" + strField(res, "detail"));
                L.push("raw=" + res.substring(0, 300));
            }
        }
    } catch (e) {
        L.push("EXCEPTION: " + e.toString() + " line=" + e.line);
    }

    /* ---- 5. 清理 ---- */
    try {
        if (comp) comp.remove();
    } catch (e9) {}
    for (var s = 0; s < solids.length; s++) {
        try { solids[s].remove(); } catch (e10) {}
    }
    var itemsAfter = 0;
    try { itemsAfter = app.project.items.length; } catch (e11) {}
    L.push("");
    L.push("工程项数 " + itemsBefore + " -> " + itemsAfter +
        (itemsBefore === itemsAfter ? "（干净）" : "（有残留！）"));

    try { OUT_DIR.create(); } catch (e12) {}
    try {
        OUT_FILE.encoding = "UTF-8";
        if (OUT_FILE.open("w")) {
            OUT_FILE.write(L.join("\n"));
            OUT_FILE.close();
        }
    } catch (e13) {}

    // 用户可能在用 AE，不弹窗
})();
