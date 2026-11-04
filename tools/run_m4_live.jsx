// ============================================================
// run_m4_live.jsx —— M4 实机验证（无人值守）
//
// 一次跑完三件事，全部写文件、不弹任何框：
//   1. 标定夹具（tools/curve_fixture.jsx）→ M4_curve_fixture.json
//   2. 往返验证：用**面板同一条写回路径**（applyPresetToSelectionJson）套缓动，
//      再把 AE 自己 valueAtTime 的采样与原始 ease 一起 dump → M4_live_checks.json
//   3. 并发 + 路径分离：指纹冲突必须拒绝写入；改时间缓动不能动空间切线，反之亦然
//
// 安全性（用户可能正开着 AE）：
//   · 只创建/删除自己的合成，结束时逐项 remove()，绝不 app.newProject()
//   · 不调用 app.quit()，除非 DreamEngineProbe/m4_quit.flag 存在（由驱动按
//     「AE 是不是本脚本拉起来的」决定）
//   · 不动用户的选区：只对自己的图层 layer.selected = true
//
// 用法：
//   AfterFX.exe -r "…/tools/run_m4_live.jsx"
//   或 在 AE 里执行 文件 > 脚本 > 运行脚本文件
//
// 语法：ES3 only。
// ============================================================

(function () {
    $.global.AEV_SILENT = true;

    var PROBE_DIR = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!PROBE_DIR.exists) PROBE_DIR.create();
    var OUT_FILE = new File(PROBE_DIR.fsName + "/M4_live_checks.json");
    var DONE_FILE = new File(PROBE_DIR.fsName + "/M4_live_done.txt");
    var QUIT_FLAG = new File(PROBE_DIR.fsName + "/m4_quit.flag");

    var scriptFile = new File($.fileName);
    var ROOT = scriptFile.parent.parent.fsName;
    var ENGINE_DIR = ROOT + "/cep/com.dreamengine.panel/engine";

    var errors = [];
    var notes = [];

    function log(text) {
        $.writeln("[m4] " + text);
    }

    function fail(text) {
        errors.push(String(text));
        log("ERR " + text);
    }

    /* ---------- 迷你 JSON ---------- */

    function jstr(value) {
        var out = String(value === undefined || value === null ? "" : value);
        out = out.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        out = out.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
        return '"' + out + '"';
    }

    function jnum(value) {
        var n = Number(value);
        if (isNaN(n) || !isFinite(n)) return "0";
        return String(Math.round(n * 1000000) / 1000000);
    }

    function writeText(file, text) {
        try {
            file.encoding = "UTF-8";
            if (!file.open("w")) return false;
            file.write(text);
            file.close();
            return true;
        } catch (e) {
            fail("写文件失败 " + file.fsName + " " + e.toString());
            return false;
        }
    }

    /* ---------- 载入引擎 ---------- */

    try {
        $.evalFile(new File(ENGINE_DIR + "/curve_math.js"));
        $.evalFile(new File(ENGINE_DIR + "/curvelib.jsx"));
    } catch (eLoad) {
        fail("引擎加载失败：" + eLoad.toString());
        writeText(OUT_FILE, '{"status":"error","errors":["engine_load"]}');
        writeText(DONE_FILE, "error");
        return;
    }
    if (typeof AEV_Curve === "undefined") {
        fail("AEV_Curve 未定义");
        writeText(OUT_FILE, '{"status":"error","errors":["AEV_Curve_missing"]}');
        writeText(DONE_FILE, "error");
        return;
    }

    /* ---------- 环境记录 ---------- */

    var itemsBefore = 0;
    var projectFile = "untitled";
    try {
        itemsBefore = app.project.items.length;
        if (app.project.file) projectFile = String(app.project.file.fsName);
    } catch (e0) {}

    log("项目：" + projectFile + "，合成/素材 " + itemsBefore + " 项");

    /* ---------- 1. 标定夹具 ---------- */

    var fixtureCases = 0;
    try {
        $.evalFile(new File(ROOT + "/tools/curve_fixture.jsx"));
        var fixtureFile = new File(PROBE_DIR.fsName + "/M4_curve_fixture.json");
        if (fixtureFile.exists) {
            fixtureFile.encoding = "UTF-8";
            if (fixtureFile.open("r")) {
                var text = fixtureFile.read();
                fixtureFile.close();
                // 不解析 JSON，只数样本个数与失败项
                var parts = text.split('"id":"');
                fixtureCases = parts.length - 1;
                log("夹具样本 " + fixtureCases + " 个");
            }
        } else {
            fail("夹具没有产出文件");
        }
    } catch (e1) {
        fail("夹具执行失败：" + e1.toString());
    }

    /* ---------- 工具 ---------- */

    var created = [];
    /* addSolid 会另建纯色素材项 —— 只删合成会在用户工程里留下素材 */
    var createdSolids = [];

    function newComp(name) {
        var comp = app.project.items.addComp(name, 1920, 1080, 1, 4, 25);
        created.push(comp);
        try {
            comp.openInViewer();
        } catch (e) {}
        return comp;
    }

    function newSolid(comp, name) {
        var layer = comp.layers.addSolid([0.2, 0.2, 0.2], name, comp.width, comp.height, 1);
        try {
            if (layer.source) createdSolids.push(layer.source);
        } catch (eSrc) {}
        try {
            layer.selected = true;   // 只动自己的图层（AE 2021 不能写 comp.selectedLayers）
        } catch (e) {}
        return layer;
    }

    /** 在 [t0,t1] 上等距取样，返回 JSON 数组 */
    function sampleJson(prop, t0, t1, count) {
        var out = [];
        for (var i = 0; i < count; i++) {
            var time = t0 + (t1 - t0) * (i / (count - 1));
            var value = prop.valueAtTime(time, false);
            var vals = [];
            if (value && typeof value === "object" && typeof value.length === "number") {
                for (var d = 0; d < value.length; d++) vals.push(jnum(value[d]));
            } else {
                vals.push(jnum(value));
            }
            out.push("{" + jstr("t") + ":" + jnum(time) + "," + jstr("v") + ":[" + vals.join(",") + "]}");
        }
        return "[" + out.join(",") + "]";
    }

    function easeOf(prop, keyIndex, side) {
        var raw = null;
        try {
            raw = side === "in" ? prop.keyInTemporalEase(keyIndex) : prop.keyOutTemporalEase(keyIndex);
        } catch (e) {}
        var out = [];
        if (raw && typeof raw.length === "number") {
            for (var i = 0; i < raw.length; i++) {
                out.push("{\"s\":" + jnum(raw[i].speed) + ",\"i\":" + jnum(raw[i].influence) + "}");
            }
        }
        return "[" + out.join(",") + "]";
    }

    function tangentOf(prop, keyIndex, side) {
        var raw = null;
        try {
            raw = side === "in" ? prop.keyInSpatialTangent(keyIndex) : prop.keyOutSpatialTangent(keyIndex);
        } catch (e) {}
        var out = [];
        if (raw && typeof raw.length === "number") {
            for (var i = 0; i < raw.length; i++) out.push(jnum(raw[i]));
        }
        return "[" + out.join(",") + "]";
    }

    /**
     * 一个往返样本：套预设 → dump 关键帧（含 AE 实际存的 ease）→ 采样 → 删合成。
     * preset 为空则只读（用于并发校验拿指纹）。
     */
    function roundtrip(preset, makeFixture, expectSig) {
        var comp = null;
        try {
            comp = newComp("M4_Live_RT_" + preset);
            var prop = makeFixture(comp);
            if (!prop) {
                fail("往返样本 " + preset + "：没拿到属性");
                return null;
            }
            var res = AEV_Curve.applyPresetToSelectionJson(preset, expectSig || "");
            var dump = AEV_Curve.dumpPropJson(prop, "live:" + preset, 0);
            var n = 0;
            try {
                n = prop.numKeys;
            } catch (e) {}
            var t0 = n ? prop.keyTime(1) : 0;
            var t1 = n ? prop.keyTime(n) : 1;
            return "{" + [
                jstr("id") + ":" + jstr("live-" + preset),
                jstr("preset") + ":" + jstr(preset),
                jstr("result") + ":" + res,
                jstr("prop") + ":" + dump,
                jstr("samples") + ":" + sampleJson(prop, t0, t1, 17)
            ].join(",") + "}";
        } catch (e2) {
            fail("往返样本 " + preset + " 异常：" + e2.toString());
            return null;
        } finally {
            if (comp) {
                try {
                    comp.remove();
                } catch (e3) {}
            }
        }
    }

    /* ---------- 2. 往返：一维 / 二维 / 三维 ---------- */

    var roundtrips = [];

    var rt1 = roundtrip("ease", function (comp) {
        var layer = newSolid(comp, "rt_1d");
        var slider = layer.property("ADBE Effect Parade").addProperty("ADBE Slider Control");
        var sp = slider.property(1);
        sp.setValueAtTime(0, 0);
        sp.setValueAtTime(1, 100);
        sp.setValueAtTime(2, 30);
        return sp;
    });
    if (rt1) roundtrips.push(rt1);

    var rt2 = roundtrip("strong", function (comp) {
        var layer = newSolid(comp, "rt_2d");
        var pos = layer.property("ADBE Transform Group").property("ADBE Position");
        pos.setValueAtTime(0, [300, 800]);
        pos.setValueAtTime(1, [900, 200]);
        pos.setValueAtTime(2, [1700, 800]);
        return pos;
    });
    if (rt2) roundtrips.push(rt2);

    var rt3 = roundtrip("ease-out", function (comp) {
        var layer = newSolid(comp, "rt_3d");
        layer.threeDLayer = true;
        var pos = layer.property("ADBE Transform Group").property("ADBE Position");
        pos.setValueAtTime(0, [300, 800, 0]);
        pos.setValueAtTime(1, [900, 300, 200]);
        pos.setValueAtTime(2, [1500, 700, 0]);
        return pos;
    });
    if (rt3) roundtrips.push(rt3);

    /* ---------- 3. 并发校验：外部改动后旧指纹必须被拒 ---------- */

    var conflictJson = "{}";
    try {
        var cComp = newComp("M4_Live_Conflict");
        var cLayer = newSolid(cComp, "conflict");
        var cSlider = cLayer.property("ADBE Effect Parade").addProperty("ADBE Slider Control");
        var cProp = cSlider.property(1);
        cProp.setValueAtTime(0, 0);
        cProp.setValueAtTime(1, 100);

        var readBack = AEV_Curve.applyPresetToSelectionJson("", "");
        // 从"只读"返回里抠出 sig（不解析 JSON，只做一次定向切片）
        var sigMarker = '"sig":"';
        var at = readBack.indexOf(sigMarker);
        var sigBefore = at >= 0 ? readBack.substring(at + sigMarker.length, readBack.indexOf('"', at + sigMarker.length)) : "";

        // 模拟「用户在时间轴上改了关键帧」
        cProp.setValueAtTime(1.5, 60);

        var conflictRes = AEV_Curve.applyPresetToSelectionJson("ease", sigBefore);
        conflictJson = "{" + [
            jstr("sigBefore") + ":" + jstr(sigBefore),
            jstr("result") + ":" + conflictRes
        ].join(",") + "}";
        log("并发校验：" + (conflictRes.indexOf('"status":"conflict"') >= 0 ? "拒绝写入（符合预期）" : "未拒绝！" + conflictRes));
    } catch (e4) {
        fail("并发校验异常：" + e4.toString());
    } finally {
        try {
            if (cComp) cComp.remove();
        } catch (e5) {}
    }

    /* ---------- 4. 路径与时间分离 ---------- */

    var pathJson = "{}";
    var pathApply = "";
    try {
        var pComp = newComp("M4_Live_Path");
        var pLayer = newSolid(pComp, "path");
        pLayer.threeDLayer = true;
        var pPos = pLayer.property("ADBE Transform Group").property("ADBE Position");
        pPos.setValueAtTime(0, [300, 800, 0]);
        pPos.setValueAtTime(1, [900, 300, 200]);
        pPos.setValueAtTime(2, [1500, 700, 0]);
        pPos.setSpatialTangentsAtKey(1, [0, 0, 0], [200, -150, 60]);
        pPos.setSpatialTangentsAtKey(2, [-200, -150, -60], [0, 0, 0]);

        var outTanBefore = tangentOf(pPos, 1, "out");
        var easeBefore = easeOf(pPos, 2, "in");

        // 只改时间缓动（把返回值也记下来，失败时才看得出是「没写进去」还是「写了没用」）
        pathApply = AEV_Curve.applyPresetToSelectionJson("ease", "");
        var outTanAfterTemporal = tangentOf(pPos, 1, "out");
        var easeAfterTemporal = easeOf(pPos, 2, "in");

        // 再只改空间切线，看时间缓动有没有被带走
        pPos.setSpatialTangentsAtKey(1, [0, 0, 0], [320, -40, 90]);
        var easeAfterTangent = easeOf(pPos, 2, "in");
        var outTanAfterTangent = tangentOf(pPos, 1, "out");

        pathJson = "{" + [
            jstr("outTanBefore") + ":" + outTanBefore,
            jstr("outTanAfterTemporal") + ":" + outTanAfterTemporal,
            jstr("easeBefore") + ":" + easeBefore,
            jstr("easeAfterTemporal") + ":" + easeAfterTemporal,
            jstr("easeAfterTangent") + ":" + easeAfterTangent,
            jstr("outTanAfterTangent") + ":" + outTanAfterTangent,
            jstr("apply") + ":" + pathApply
        ].join(",") + "}";
        log("路径分离：切线 " + outTanBefore + " → " + outTanAfterTemporal);
    } catch (e6) {
        fail("路径分离异常：" + e6.toString());
    } finally {
        try {
            if (pComp) pComp.remove();
        } catch (e7) {}
    }

    /* ---------- 收尾 ---------- */

    /* 先删纯色素材项，再核项数 —— 否则永远对不上 */
    for (var cs = 0; cs < createdSolids.length; cs++) {
        try {
            var srcItem = createdSolids[cs];
            if (srcItem && srcItem.parentItem !== null) srcItem.remove();
            else if (srcItem) srcItem.remove();
        } catch (eSolid) {}
    }

    var itemsAfter = 0;
    try {
        itemsAfter = app.project.items.length;
    } catch (e8) {}
    if (itemsBefore !== itemsAfter) {
        fail("工程项数变了：" + itemsBefore + " → " + itemsAfter + "（有残留）");
    }

    var errText = [];
    for (var q = 0; q < errors.length; q++) errText.push(jstr(errors[q]));
    var noteText = [];
    for (var w = 0; w < notes.length; w++) noteText.push(jstr(notes[w]));

    var version = "";
    try {
        version = String(app.version);
    } catch (e9) {}

    var json = "{" + [
        jstr("status") + ":" + jstr(errors.length ? "partial" : "ok"),
        jstr("ae") + ":" + jstr(version),
        jstr("project") + ":{" +
            jstr("file") + ":" + jstr(projectFile) + "," +
            jstr("itemsBefore") + ":" + jnum(itemsBefore) + "," +
            jstr("itemsAfter") + ":" + jnum(itemsAfter) + "}",
        jstr("fixtureCases") + ":" + jnum(fixtureCases),
        jstr("roundtrip") + ":[" + roundtrips.join(",") + "]",
        jstr("conflict") + ":" + conflictJson,
        jstr("path") + ":" + pathJson,
        jstr("errors") + ":[" + errText.join(",") + "]",
        jstr("notes") + ":[" + noteText.join(",") + "]"
    ].join(",") + "}";

    writeText(OUT_FILE, json);
    writeText(DONE_FILE, errors.length ? "partial" : "ok");
    log("完成，结果：" + OUT_FILE.fsName);

    // 只有在「AE 是本脚本拉起来的」时才退出，避免关掉用户正在用的 AE
    if (QUIT_FLAG.exists) {
        log("检测到退出标记，关闭 AE");
        app.quit();
    }
})();
