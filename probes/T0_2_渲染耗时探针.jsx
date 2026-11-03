// ============================================================
// T0_2 渲染耗时与体积探针
// 回答 M0 未知数 #2：单帧耗时、整网批量耗时、每格每帧平均秒数与平均 KB
// 这两个数是 M2 内置包规模 / 动画帧数的唯一依据
// ============================================================

(function probeRenderCost() {
    // ---------- 可调参数（首次跑就用默认值即可） ----------
    var SINGLE_LIST = ["ADBE Gaussian Blur 2", "ADBE CurvesCustom", "ADBE Drop Shadow",
                       "APC Colorama", "ADBE Turbulent Displace", "ADBE Tint",
                       "ADBE Invert", "ADBE Brightness & Contrast 2", "ADBE HUE SATURATION",
                       "ADBE Easy Levels2", "ADBE Glo2", "ADBE Motion Blur",
                       "ADBE Ripple", "ADBE Wave Warp", "ADBE Mosaic", "ADBE Find Edges"];
    var SINGLE_SIZE = 256;      // 逐效果模式：每个合成的边长(px)
    var GRID_COLS = 8;          // 目标规模：8x8=2048px 整网
    var GRID_CELL = 256;
    var GRID_FRAMES = 6;        // 整网模式：渲染帧数

    var outDir = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!outDir.exists) outDir.create();
    var tmpDir = new Folder(outDir.fsName + "/render_tmp");
    if (!tmpDir.exists) tmpDir.create();

    var outFile = new File(outDir.fsName + "/T0_2_渲染耗时.txt");
    outFile.encoding = "UTF-8";
    var aerenderProject = new File(outDir.fsName + "/T0_2_aerender_test.aep");
    var logFile = new File(outDir.fsName + "/探针日志.txt");
    var L = [];
    function push(s) { L.push(s); }

    push("PROBE=T0_2");
    push("AE_VERSION=" + app.version);
    push("PARAM|singleSize=" + SINGLE_SIZE + "|gridCols=" + GRID_COLS +
         "|cell=" + GRID_CELL + "|frames=" + GRID_FRAMES);

    // ---------- 工具：找一个 PNG 类输出模块模板 ----------
    // 已知约束：OutputModule 的 Format 不可直接 setSettings，只能靠切模板
    function pickPngTemplate(om) {
        var names = om.templates;
        for (var i = 0; i < names.length; i++) {
            var n = String(names[i]);
            if (n.toLowerCase().indexOf("png") >= 0) return n;
        }
        return null;
    }

    function dirSizeKB(dir) {
        var files = dir.getFiles("*.png");
        var bytes = 0, cnt = 0;
        for (var i = 0; i < files.length; i++) {
            if (files[i] instanceof File) {
                files[i].open("r");
                bytes += files[i].length;
                files[i].close();
                cnt++;
            }
        }
        return { kb: Math.round(bytes / 1024), count: cnt };
    }

    function renderOne(rqItem, label) {
        var t0 = new Date().getTime();
        rqItem.render = true;
        app.project.renderQueue.render();
        var wall = (new Date().getTime() - t0) / 1000;
        var el = null;
        try { el = rqItem.elapsedSeconds; } catch (e) {}
        push("RENDER|" + label + "|wallSec=" + wall + "|elapsedSeconds=" + el);
        return wall;
    }

    var prj = app.project;
    var createdItems = [];

    clearTmp(tmpDir);

    // ---------- 模式 A：逐效果单帧（最朴素做法，用来算批量收益的分母） ----------
    var secA = 0, okA = 0, failA = 0;
    for (var a = 0; a < SINGLE_LIST.length; a++) {
        var mn = SINGLE_LIST[a];
        var comp = prj.items.addComp("T0_2_A_" + mn, SINGLE_SIZE, SINGLE_SIZE, 1.0, 1.0, 30);
        createdItems.push(comp);
        var sol = comp.layers.addSolid([1, 1, 1], "s", SINGLE_SIZE, SINGLE_SIZE, 1.0);
        var applied = false;
        try { sol.property("ADBE Effect Parade").addProperty(mn); applied = true; } catch (eAdd) {
            push("ADDFAIL|" + mn + "|" + eAdd.toString());
        }
        if (!applied) { failA++; continue; }

        var outBase = tmpDir.fsName + "/A_" + a;
        var rq = prj.renderQueue.items.add(comp);
        var om = rq.outputModule(1);
        var tpl = pickPngTemplate(om);
        if (!tpl) {
            push("BLOCK_NO_PNG_TEMPLATE|templates=" + om.templates.join(" | "));
            try {
                om.file = new File(outDir.fsName + "/T0_2_aerender_preview.png");
                push("AERENDER_OUTPUT_FILE_SET=OK");
            } catch (eFilePrep) {
                push("AERENDER_OUTPUT_FILE_SET=FAIL|" + eFilePrep.toString());
            }
            try {
                prj.save(aerenderProject);
                push("AERENDER_PROJECT_SAVED=OK|" + aerenderProject.fsName);
            } catch (eSavePrep) {
                push("AERENDER_PROJECT_SAVED=FAIL|" + eSavePrep.toString());
            }
            outFile.open("w");
            outFile.write(L.join("\r\n"));
            outFile.close();
            alert("T0_2 已中止：当前 AE 没有可用的 PNG 输出模块模板。\n\n" +
                  "已保存 aerender 测试工程：\n" + aerenderProject.fsName + "\n" +
                  "诊断已写入：\n" + outFile.fsName);
            return;
        }
        try { om.applyTemplate(tpl); } catch (eTpl) {
            push("BLOCK_APPLY_PNG_TEMPLATE|" + tpl + "|" + eTpl.toString());
            outFile.open("w");
            outFile.write(L.join("\r\n"));
            outFile.close();
            alert("T0_2 已中止：PNG 模板应用失败。\n\n" + tpl + "\n" + eTpl.toString());
            return;
        }
        push("TPL_USED_A|index" + a + "|" + tpl);
        try {
            rq.timeSpanStart = 0;
            rq.timeSpanDuration = comp.frameDuration;
        } catch (eSpan) { push("TIMESPAN_FAIL|" + eSpan.toString()); }
        var f = new File(outBase + "_[###].png");
        try { om.file = f; } catch (eFile) {
            try {
                om.setSettings({"Output File Info": {"Base Path": tmpDir.fsName,
                                                     "File Name": "A_" + a + "_[###].png"}});
            } catch (eSet) { push("PATH_FAIL|" + eSet.toString()); }
        }
        secA += renderOne(rq, "single_" + mn);
        okA++;
    }
    var sizeA = dirSizeKB(tmpDir);
    push("MODE_A_SUM|ok=" + okA + "|fail=" + failA + "|totalSec=" + Math.round(secA * 100) / 100 +
         "|files=" + sizeA.count + "|totalKB=" + sizeA.kb);
    if (okA > 0) {
        push("CALC_A|平均单帧秒=" + (Math.round((secA / okA) * 100) / 100) +
             " 公式=" + secA + "/" + okA);
        push("CALC_A|平均单图KB=" + (sizeA.count > 0 ? Math.round(sizeA.kb / sizeA.count) : 0) +
             " 公式=" + sizeA.kb + "/" + sizeA.count);
    }

    // ---------- 清空已产出，方便统计整网模式的体积 ----------
    clearTmp(tmpDir);

    // ---------- 模式 B：Contact Sheet 整网多帧 ----------
    var gridW = GRID_COLS * GRID_CELL, gridH = GRID_COLS * GRID_CELL;
    var grid = prj.items.addComp("T0_2_B_grid", gridW, gridH, 1.0,
                                 GRID_FRAMES / 30, 30);
    createdItems.push(grid);
    var placed = 0;
    var cellCount = GRID_COLS * GRID_COLS;
    for (var gi = 0; gi < cellCount; gi++) {
        var effectName = SINGLE_LIST[gi % SINGLE_LIST.length];
        var cell = prj.items.addComp("T0_2_B_cell_" + effectName + "_" + gi, GRID_CELL, GRID_CELL, 1.0,
                                     GRID_FRAMES / 30, 30);
        createdItems.push(cell);
        var cs = cell.layers.addSolid([0.5, 0.5, 0.5], "s", GRID_CELL, GRID_CELL, 1.0);
        try { cs.property("ADBE Effect Parade").addProperty(effectName); }
        catch (e2) { push("CELL_ADDFAIL|" + effectName); }
        var gl = grid.layers.add(cell);
        var col = placed % GRID_COLS, row = Math.floor(placed / GRID_COLS);
        gl.moveToEnd();
        try {
            gl.property("ADBE Transform Group").property("ADBE Position")
              .setValue([col * GRID_CELL + GRID_CELL / 2, row * GRID_CELL + GRID_CELL / 2]);
        } catch (ePos) { push("CELL_POSFAIL"); }
        placed++;
    }
    push("GRID_CELLS_PLACED=" + placed);

    var rqB = prj.renderQueue.items.add(grid);
    var omB = rqB.outputModule(1);
    var tplB = pickPngTemplate(omB);
    if (!tplB) {
        push("BLOCK_NO_PNG_TEMPLATE_B|templates=" + omB.templates.join(" | "));
        outFile.open("w");
        outFile.write(L.join("\r\n"));
        outFile.close();
        alert("T0_2 已中止：整网模式找不到 PNG 输出模块模板。");
        return;
    }
    try { omB.applyTemplate(tplB); } catch (e3) {
        push("BLOCK_APPLY_PNG_TEMPLATE_B|" + tplB + "|" + e3.toString());
        outFile.open("w");
        outFile.write(L.join("\r\n"));
        outFile.close();
        alert("T0_2 已中止：整网模式 PNG 模板应用失败。\n\n" + tplB + "\n" + e3.toString());
        return;
    }
    push("TPL_USED_B|" + tplB);
    try {
        rqB.timeSpanStart = 0;
        rqB.timeSpanDuration = grid.duration;
    } catch (e4) { push("GRID_SPAN_FAIL|" + e4.toString()); }
    try { omB.file = new File(tmpDir.fsName + "/B_[###].png"); } catch (e5) {}

    var secB = renderOne(rqB, "grid_" + GRID_COLS + "x" + GRID_COLS + "_f" + GRID_FRAMES);
    var sizeB = dirSizeKB(tmpDir);
    push("MODE_B_SUM|frames=" + GRID_FRAMES + "|cells=" + placed +
         "|totalSec=" + Math.round(secB * 100) / 100 +
         "|files=" + sizeB.count + "|totalKB=" + sizeB.kb);
    if (placed > 0 && GRID_FRAMES > 0) {
        push("CALC_B|每格每帧秒=" + (Math.round((secB / (placed * GRID_FRAMES)) * 1000) / 1000) +
             " 公式=" + secB + "/(" + placed + "*" + GRID_FRAMES + ")");
        push("CALC_B|每张整网KB=" + (sizeB.count > 0 ? Math.round(sizeB.kb / sizeB.count) : 0) +
             " 公式=" + sizeB.kb + "/" + sizeB.count);
    }
    push("CALC_批量收益|朴素渲染" + placed + "效果x" + GRID_FRAMES + "帧=" +
         (placed * GRID_FRAMES) + " 次；整网只渲染 " + GRID_FRAMES + " 次(本实现合并为1个队列项)");

    // ---------- 写文件 ----------
    outFile.open("w");
    outFile.write(L.join("\r\n"));
    outFile.close();

    var msg = "T0_2 完成：逐效果 " + Math.round(secA) + "s / 整网 " + Math.round(secB) +
              "s（" + placed + "格 x " + GRID_FRAMES + "帧）";
    logFile.open("a"); logFile.write(msg + " | 输出=T0_2_渲染耗时.txt\r\n"); logFile.close();

    alert(msg + "\n\n结果已写入：\n" + outFile.fsName +
          "\n\n【重要】临时合成的清理：请手动关闭当前项目且不保存，或全选名称以 T0_2_ 开头的合成删除。");

    function clearTmp(d) {
        var fs = d.getFiles("*");
        for (var i = 0; i < fs.length; i++) {
            if (fs[i] instanceof File) { try { fs[i].remove(); } catch (eDel) {} }
        }
    }
})();
