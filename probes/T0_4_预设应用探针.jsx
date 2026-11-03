// ============================================================
// T0_4 预设应用探针  applyPreset 行为实测
// 回答 M0 未知数 #2：有选中 / 无选中 / 图层类型不匹配 三种情况各自的真实行为
// 运行后会弹出文件选择框：请选一个 .ffx 预设
//   建议连跑 3 次，分别选：纯效果预设、文本动画预设、变换关键帧预设
// ============================================================

(function probeApplyPreset() {
    var outDir = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!outDir.exists) outDir.create();

    var preset = File.openDialog("选择要测试的 .ffx 预设文件", "After Effects 预设 (*.ffx)");
    if (!preset) { alert("未选择预设，探针结束。"); return; }
    if (!(preset instanceof File)) {
        // 某些版本多选时返回数组
        preset = preset[0];
    }

    var L = [];
    function push(s) { L.push(s); }
    push("PROBE=T0_4");
    push("AE_VERSION=" + app.version);
    push("PRESET=" + preset.fsName);
    push("PRESET_EXISTS=" + preset.exists);

    var prj = app.project;
    var comp = prj.items.addComp("T0_4_probe", 640, 480, 1.0, 3, 30);

    // ---------- 场景 A：选中一个纯色层 ----------
    var solid = comp.layers.addSolid([1, 1, 1], "solidA", 640, 480, 1.0);
    try { solid.selected = true; } catch (eSelA) { push("SELECT_SET_FAIL|" + String(eSelA)); }
    var beforeEffects = countEffects(solid);
    var beforeKeys = countKeyedProps(solid);
    var errA = null;
    try { solid.applyPreset(preset); } catch (eA) { errA = String(eA); }
    push("A_solid_selected|err=" + (errA ? errA : "无") +
         "|效果数 " + beforeEffects + "->" + countEffects(solid) +
         "|动画属性数 " + beforeKeys + "->" + countKeyedProps(solid) +
         "|图层数=" + comp.numLayers);
    dumpChangedProps("A", solid);

    // ---------- 场景 B：无任何选中层 ----------
    clearSelection(comp);
    var layersBefore = comp.numLayers;
    var errB = null;
    var solid2 = comp.layers.addSolid([0.2, 0.6, 0.2], "solidB", 320, 240, 1.0);
    clearSelection(comp); // 新建层会被选中，这里强制清空
    try { solid2.applyPreset(preset); } catch (eB) { errB = String(eB); }
    push("B_no_selection|err=" + (errB ? errB : "无") +
         "|调用前图层数=" + layersBefore + "|调用后图层数=" + comp.numLayers +
         "|solidB效果数=" + countEffects(solid2));

    // ---------- 场景 C：文本层 ----------
    var tx = comp.layers.addText("Hello 预设测试");
    clearSelection(comp);
    tx.selected = true;
    var errC = null;
    try { tx.applyPreset(preset); } catch (eC) { errC = String(eC); }
    push("C_text_selected|err=" + (errC ? errC : "无") +
         "|效果数=" + countEffects(tx) + "|动画属性数=" + countKeyedProps(tx) +
         "|图层数=" + comp.numLayers);
    dumpChangedProps("C", tx);

    // ---------- 场景 D：调整层 ----------
    var adj = comp.layers.addSolid([1, 1, 1], "adj", 640, 480, 1.0);
    try { adj.adjustmentLayer = true; } catch (eAdj) { push("D_adj_flag_fail"); }
    clearSelection(comp);
    adj.selected = true;
    var errD = null;
    try { adj.applyPreset(preset); } catch (eD) { errD = String(eD); }
    push("D_adjustment|err=" + (errD ? errD : "无") +
         "|效果数=" + countEffects(adj));

    // ---------- 记录新图层的命名线索（判断是否 AE 自动建了纯色层） ----------
    var names = [];
    for (var n = 1; n <= comp.numLayers; n++) names.push(comp.layer(n).name);
    push("LAYER_NAMES_AFTER=" + names.join(" / "));

    var presetSafe = preset.name.replace(/\.ffx$/i, "").replace(/[\\\/:*?"<>|]/g, "_");
    var outFile = new File(outDir.fsName + "/T0_4_预设应用_" + presetSafe + ".txt");
    outFile.encoding = "UTF-8";
    outFile.open("w");
    outFile.write(L.join("\r\n"));
    outFile.close();

    var log = new File(outDir.fsName + "/探针日志.txt");
    log.open("a");
    log.write("T0_4 预设探针 | " + preset.name + " | A=" + (errA ? "报错" : "成功") +
              " B=" + (errB ? "报错" : "成功") + " C=" + (errC ? "报错" : "成功") +
              " D=" + (errD ? "报错" : "成功") + " | 输出=" + outFile.name + "\r\n");
    log.close();

    alert("T0_4 完成：" + preset.name +
          "\n\nA 纯色选中：" + (errA ? "报错" : "无错") +
          "\nB 无选中：" + (errB ? "报错" : "无错") + "（图层数 " + layersBefore + " -> " + comp.numLayers + "）" +
          "\nC 文本层：" + (errC ? "报错" : "无错") +
          "\nD 调整层：" + (errD ? "报错" : "无错") +
          "\n\n结果：" + outFile.fsName +
          "\n\n【重要】不要按 Ctrl+Z 撤销清理！请直接关闭项目且不保存。");

    // ---------- helpers ----------
    function countEffects(layer) {
        try {
            var ep = layer.property("ADBE Effect Parade");
            return ep ? ep.numProperties : -1;
        } catch (e) { return -2; }
    }
    function countKeyedProps(layer) {
        var c = 0;
        walk(layer, 0);
        return c;
        function walk(pg, depth) {
            if (depth > 6) return;
            var cnt = 0;
            try { cnt = pg.numProperties; } catch (eC) { return; }
            for (var i = 1; i <= cnt; i++) {
                var p = null;
                try { p = pg.property(i); } catch (eG) { continue; }
                if (!p) continue;
                try { if (p.canVaryOverTime && p.numKeys > 0) c++; } catch (e) {}
                if (p.numProperties !== undefined && p.numProperties > 0 && p.property) {
                    try { walk(p, depth + 1); } catch (e2) {}
                }
            }
        }
    }
    function clearSelection(cmp) {
        for (var i = 1; i <= cmp.numLayers; i++) {
            try { cmp.layer(i).selected = false; } catch (e) {}
        }
    }
    function dumpChangedProps(tag, layer) {
        try {
            for (var i = 1; i <= layer.numProperties; i++) {
                var g = layer.property(i);
                if (!g || !g.name) continue;
                var nm = String(g.name);
                if (nm.indexOf("效果") >= 0 || nm.indexOf("Effects") >= 0 ||
                    nm.indexOf("Transform") >= 0 || nm.indexOf("变换") >= 0) {
                    push(tag + "_GRP|" + nm + "|numProperties=" + g.numProperties);
                }
            }
        } catch (e) { push(tag + "_DUMPFAIL"); }
    }
})();
