// ============================================================
// curve_fixture.jsx —— M4 曲线换算标定夹具（T5.1）
//
// 为什么需要它：面板画出来的曲线必须与 AE 原生图表编辑器一致，而
// 「influence 百分比 → 把手水平长度」「speed → 斜率」这两条换算只写在
// 文档里，没有任何地方给出可以对照的数值。靠推导极易处处差一点，
// 所以先造一批受控样本，把 AE **自己算出来的值** dump 出来：
//
//   · 每个样本在关键帧区间内取 17 个时间点，调 property.valueAtTime()
//     —— 这是 AE 内部的求值结果，等价于图表编辑器画出来的曲线
//   · 同时 dump 关键帧的原始 ease / 切线 / 插值类型 / 各标志位
//   · Node 侧（tools/check_curve_calibration.mjs）用 curvelib 的公式
//     重算同一条曲线，逐点比对，产出偏差表
//
// 为什么不用截图比对：像素比对要人眼看、无法自动化、也无法区分
// 「曲线错了」与「坐标轴映射错了」。采样值比对是纯数值，且用的就是
// 面板将来要画的同一套公式。
//
// 用法（二选一）：
//   · AE 菜单：文件 > 脚本 > 运行脚本文件 → 选本文件
//   · 命令行：AfterFX.exe -r "…/tools/curve_fixture.jsx"
//
// 产物：<我的文档>/DreamEngineProbe/M4_curve_fixture.json
// 清理：用完即删临时合成（remove()，不依赖 Ctrl+Z —— 见设计文档 §6.4）
// ============================================================

(function () {
    var OUT_DIR = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    var OUT_FILE = new File(OUT_DIR.fsName + "/M4_curve_fixture.json");
    var SAMPLE_COUNT = 17;   // 每个区间 17 点：0%, 6.25%, … 100%

    /* ---------- 极小的 JSON 输出工具（ExtendScript 无 JSON） ---------- */

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

    function jbool(value) {
        return value ? "true" : "false";
    }

    /* ---------- 环境 ---------- */

    var scriptFile = new File($.fileName);
    var engineDir = scriptFile.parent.parent.fsName + "/cep/com.dreamengine.panel/engine";
    var mathFile = new File(engineDir + "/curve_math.js");
    var curveFile = new File(engineDir + "/curvelib.jsx");
    if (!mathFile.exists || !curveFile.exists) {
        alert("找不到引擎文件：\n" + engineDir);
        return;
    }
    // 顺序固定：纯数学先加载，curvelib 依赖它
    $.evalFile(mathFile);
    $.evalFile(curveFile);
    if (typeof AEV_Curve === "undefined") {
        alert("curvelib.jsx 加载失败（AEV_Curve 未定义）");
        return;
    }

    if (!OUT_DIR.exists) OUT_DIR.create();

    /* ---------- 样本容器 ---------- */

    var cases = [];
    var failures = [];
    var comp = null;
    var createdItems = [];

    function log(text) {
        $.writeln(text);
    }

    /** 建一个只给一个样本用的图层，避免样本之间互相干扰 */
    function newLayer(name) {
        var layer = comp.layers.addSolid([0.2, 0.2, 0.2], name, comp.width, comp.height, 1);
        layer.moveToEnd();
        return layer;
    }

    /** 取样：在 [t0, t1] 上等距取 SAMPLE_COUNT 个点 */
    function sampleProp(prop, t0, t1) {
        var out = [];
        var i, t, v;
        for (i = 0; i < SAMPLE_COUNT; i++) {
            t = t0 + (t1 - t0) * (i / (SAMPLE_COUNT - 1));
            v = [];
            try {
                var value = prop.valueAtTime(t, false);
                if (value && typeof value === "object" && typeof value.length === "number") {
                    for (var d = 0; d < value.length; d++) v.push(jnum(value[d]));
                } else {
                    v.push(jnum(value));
                }
            } catch (e) {
                v.push("0");
            }
            out.push("{" + jstr("t") + ":" + jnum(t) + "," + jstr("v") + ":[" + v.join(",") + "]}");
        }
        return "[" + out.join(",") + "]";
    }

    function addCase(id, desc, prop) {
        if (!prop) {
            failures.push(id + ":属性不存在");
            return;
        }
        var dump;
        try {
            dump = AEV_Curve.dumpPropJson(prop, id, cases.length);
        } catch (e) {
            failures.push(id + ":dump 失败 " + e.toString());
            return;
        }
        var n = 0;
        try {
            n = prop.numKeys;
        } catch (e2) {}
        if (n < 2) {
            failures.push(id + ":关键帧不足（" + n + "）");
            return;
        }
        var t0 = prop.keyTime(1);
        var t1 = prop.keyTime(n);
        cases.push("{" + [
            jstr("id") + ":" + jstr(id),
            jstr("desc") + ":" + jstr(desc),
            jstr("prop") + ":" + dump,
            jstr("samples") + ":" + sampleProp(prop, t0, t1)
        ].join(",") + "}");
        log("  [ok] " + id + "  keys=" + n + "  " + t0 + "s → " + t1 + "s");
    }

    /* ---------- 造样本 ---------- */

    try {
        comp = app.project.items.addComp("M4_CurveFixture", 1920, 1080, 1, 6, 25);
        createdItems.push(comp);
    } catch (e0) {
        alert("建合成失败：" + e0.toString());
        return;
    }

    log("=== M4 曲线标定夹具 ===");

    /* 1. 一维：滑杆，两段，覆盖默认缓动 / 不同 influence */
    try {
        var layer1 = newLayer("m4_1d");
        var slider = layer1.property("ADBE Effect Parade").addProperty("ADBE Slider Control");
        var sp = slider.property(1);
        // 滑杆默认 0..100，直接用
        sp.setValueAtTime(0, 0);
        sp.setValueAtTime(1, 100);
        sp.setValueAtTime(2, 30);
        // 第一段：两端都缓（speed 0 / influence 33.33）
        sp.setTemporalEaseAtKey(1, [new KeyframeEase(0, 33.33)], [new KeyframeEase(0, 33.33)]);
        sp.setTemporalEaseAtKey(2, [new KeyframeEase(0, 33.33)], [new KeyframeEase(100, 50)]);
        // 第二段：入侧强缓（75），出侧无
        sp.setTemporalEaseAtKey(3, [new KeyframeEase(0, 75)], [new KeyframeEase(0, 33.33)]);
        addCase("1d-slider", "一维滑杆：0→100→30，混合 33.33/50/75 influence", sp);
    } catch (e1) {
        failures.push("1d-slider:" + e1.toString());
    }

    /* 2. 二维位置（未分离）：检验「统一时间重映射」假设 ——
          若各维 speed 与各自弦斜率成正比，说明 m 是共享的。 */
    try {
        var layer2 = newLayer("m4_2d");
        var pos = layer2.property("ADBE Transform Group").property("ADBE Position");
        pos.setValueAtTime(0, [100, 900]);
        pos.setValueAtTime(1, [900, 200]);
        pos.setValueAtTime(2, [1700, 800]);
        pos.setTemporalEaseAtKey(1,
            [new KeyframeEase(0, 33.33), new KeyframeEase(0, 33.33)],
            [new KeyframeEase(0, 33.33), new KeyframeEase(0, 33.33)]);
        pos.setTemporalEaseAtKey(2,
            [new KeyframeEase(0, 33.33), new KeyframeEase(0, 33.33)],
            [new KeyframeEase(400, 60), new KeyframeEase(-200, 60)]);
        addCase("2d-position", "二维位置未分离：检验各维 speed 是否按弦斜率同比", pos);
    } catch (e2) {
        failures.push("2d-position:" + e2.toString());
    }

    /* 3. 三维位置 + 空间切线：路径形状与时间曲线必须分开 */
    try {
        var layer3 = newLayer("m4_3d");
        layer3.threeDLayer = true;
        var pos3 = layer3.property("ADBE Transform Group").property("ADBE Position");
        pos3.setValueAtTime(0, [300, 800, 0]);
        pos3.setValueAtTime(1, [900, 300, 200]);
        pos3.setValueAtTime(2, [1500, 700, 0]);
        // 明确给一段弯曲的空间路径（切线是绝对偏移量）
        pos3.setSpatialTangentsAtKey(1, [0, 0, 0], [200, -150, 60]);
        pos3.setSpatialTangentsAtKey(2, [-200, -150, -60], [0, 0, 0]);
        pos3.setTemporalEaseAtKey(1,
            [new KeyframeEase(0, 33.33), new KeyframeEase(0, 33.33), new KeyframeEase(0, 33.33)],
            [new KeyframeEase(0, 33.33), new KeyframeEase(0, 33.33), new KeyframeEase(0, 33.33)]);
        addCase("3d-spatial", "三维位置 + 显式空间切线：路径与时间分轨", pos3);
    } catch (e3) {
        failures.push("3d-spatial:" + e3.toString());
    }

    /* 4. 分离维度：X/Y 各自独立成属性 */
    try {
        var layer4 = newLayer("m4_sep");
        var pos4 = layer4.property("ADBE Transform Group").property("ADBE Position");
        pos4.setValueAtTime(0, [200, 500]);
        pos4.setValueAtTime(1, [1200, 500]);
        pos4.setValueAtTime(2, [1200, 900]);
        try {
            pos4.dimensionsSeparated = true;
        } catch (eSep) {
            failures.push("separated:dimensionsSeparated 赋值失败 " + eSep.toString());
        }
        var sepX = layer4.property("ADBE Transform Group").property("ADBE Position_0");
        var sepY = layer4.property("ADBE Transform Group").property("ADBE Position_1");
        if (sepX) {
            sepX.setTemporalEaseAtKey(1, [new KeyframeEase(0, 50)], [new KeyframeEase(0, 50)]);
            addCase("sep-x", "分离维度 X：influence 50", sepX);
        } else {
            failures.push("sep-x:ADBE Position_0 取不到");
        }
        if (sepY) {
            addCase("sep-y", "分离维度 Y：默认 ease", sepY);
        } else {
            failures.push("sep-y:ADBE Position_1 取不到");
        }
    } catch (e4) {
        failures.push("separated:" + e4.toString());
    }

    /* 5. 自动贝塞尔：AE 自己算把手，脚本写的 ease 会被覆盖 */
    try {
        var layer5 = newLayer("m4_auto");
        var pos5 = layer5.property("ADBE Transform Group").property("ADBE Position");
        pos5.setValueAtTime(0, [300, 800]);
        pos5.setValueAtTime(1, [1000, 300]);
        pos5.setValueAtTime(2, [1700, 800]);
        pos5.setTemporalAutoBezierAtKey(2, true);
        addCase("auto-bezier", "自动贝塞尔关键帧：把手由 AE 重算", pos5);
    } catch (e5) {
        failures.push("auto-bezier:" + e5.toString());
    }

    /* 6. roving：时间由 AE 自己排，写 ease 无意义 */
    try {
        var layer6 = newLayer("m4_roving");
        var pos6 = layer6.property("ADBE Transform Group").property("ADBE Position");
        pos6.setValueAtTime(0, [300, 800]);
        pos6.setValueAtTime(1, [1000, 300]);
        pos6.setValueAtTime(2, [1700, 800]);
        pos6.setRovingAtKey(2, true);
        addCase("roving", "roving 关键帧：时间轴由 AE 排布", pos6);
    } catch (e6) {
        failures.push("roving:" + e6.toString());
    }

    /* 7. 定格插值：不参与曲线求值 */
    try {
        var layer7 = newLayer("m4_hold");
        var pos7 = layer7.property("ADBE Transform Group").property("ADBE Position");
        pos7.setValueAtTime(0, [300, 800]);
        pos7.setValueAtTime(1, [1000, 300]);
        pos7.setValueAtTime(2, [1700, 800]);
        pos7.setInterpolationTypeAtKey(1,
            KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
        addCase("hold", "定格插值：区间内值不变", pos7);
    } catch (e7) {
        failures.push("hold:" + e7.toString());
    }

    /* 8. influence 极值：0.1 与 100，检验钳位与把手长度上限 */
    try {
        var layer8 = newLayer("m4_extreme");
        var pos8 = layer8.property("ADBE Transform Group").property("ADBE Position");
        pos8.setValueAtTime(0, [300, 800]);
        pos8.setValueAtTime(1, [1700, 800]);
        pos8.setTemporalEaseAtKey(1,
            [new KeyframeEase(0, 0.1), new KeyframeEase(0, 0.1)],
            [new KeyframeEase(0, 100), new KeyframeEase(0, 100)]);
        addCase("extreme-influence", "influence 极值：出侧 100 / 入侧 0.1", pos8);
    } catch (e8) {
        failures.push("extreme-influence:" + e8.toString());
    }

    /* 9. 超过弦斜率的 speed：检验过冲（anticipation / overshoot） */
    try {
        var layer9 = newLayer("m4_overshoot");
        var pos9 = layer9.property("ADBE Transform Group").property("ADBE Position");
        pos9.setValueAtTime(0, [300, 800]);
        pos9.setValueAtTime(1, [1700, 800]);
        pos9.setTemporalEaseAtKey(1,
            [new KeyframeEase(0, 33.33), new KeyframeEase(0, 33.33)],
            [new KeyframeEase(-900, 60), new KeyframeEase(-900, 60)]);
        addCase("overshoot", "负向 speed：把手反向，曲线过冲", pos9);
    } catch (e9) {
        failures.push("overshoot:" + e9.toString());
    }

    /* ---------- 落盘 ---------- */

    var aeVersion = "";
    try {
        aeVersion = String(app.version);
    } catch (e10) {}

    var json = "{" + [
        jstr("version") + ":" + jstr(AEV_Curve.VERSION),
        jstr("ae") + ":" + jstr(aeVersion),
        jstr("sampleCount") + ":" + SAMPLE_COUNT,
        jstr("cases") + ":[" + cases.join(",") + "]",
        jstr("failures") + ":[" + (function () {
            var out = [];
            for (var i = 0; i < failures.length; i++) out.push(jstr(failures[i]));
            return out.join(",");
        })() + "]"
    ].join(",") + "}";

    var written = false;
    try {
        OUT_FILE.encoding = "UTF-8";
        if (OUT_FILE.open("w")) {
            OUT_FILE.write(json);
            OUT_FILE.close();
            written = true;
        }
    } catch (e11) {
        failures.push("写文件失败：" + e11.toString());
    }

    /* ---------- 清理：remove() 而不是 Ctrl+Z ---------- */

    for (var c = 0; c < createdItems.length; c++) {
        try {
            createdItems[c].remove();
        } catch (e12) {}
    }

    var summary = "样本 " + cases.length + " 个，失败 " + failures.length + " 项\n" +
        (written ? "已写入：\n" + OUT_FILE.fsName : "写文件失败（检查「允许脚本写入文件」）") +
        (failures.length ? "\n\n" + failures.join("\n") : "") +
        "\n\n下一步：在仓库里跑\nnode tools/check_curve_calibration.mjs";
    log(summary);
    alert(summary);
})();
