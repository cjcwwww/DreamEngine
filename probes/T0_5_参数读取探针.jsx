// ============================================================
// T0_5 参数读取能力探针（下拉选项 / 范围 / 单位）
// 回答 M0 未知数 #5 与 #6：propertyParameters、valueText 在当前版本是否可用，
//                          minValue/maxValue/unitsText 能读到什么，决定预览墙参数兜底显示
// ============================================================

(function probeParamRead() {
    // 用 app.effects 里"带下拉可能性"的效果各取若干个来测，避免猜具体效果
    var outDir = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!outDir.exists) outDir.create();

    var L = [];
    function push(s) { L.push(s); }
    push("PROBE=T0_5");
    push("AE_VERSION=" + app.version);

    var prj = app.project;
    var comp = prj.items.addComp("T0_5_probe", 640, 480, 1.0, 1, 30);
    var layer = comp.layers.addSolid([1, 1, 1], "s", 640, 480, 1.0);
    var parade = layer.property("ADBE Effect Parade");

    // 取前 40 个能成功添加的效果做参数读取样本
    var tried = 0, added = 0, popupLike = 0, ppOK = 0, vtOK = 0, minmaxOK = 0, unitsOK = 0;
    var errs = {};
    var list = app.effects;

    for (var i = 0; i < list.length && tried < 120 && added < 40; i++) {
        var fx = list[i];
        tried++;
        var eff = null;
        try { eff = parade.addProperty(fx.matchName); } catch (eAdd) {
            errs["addProperty失败"] = (errs["addProperty失败"] || 0) + 1;
            continue;
        }
        if (!eff) continue;
        added++;

        for (var p = 1; p <= eff.numProperties; p++) {
            var prop = null;
            try { prop = eff.property(p); } catch (eG) { continue; }
            if (!prop) continue;

            var pvt = "?";
            try { pvt = String(prop.propertyValueType); } catch (e1) {}

            var info = prop.name + "|type=" + pvt;

            // 范围
            try {
                if (prop.hasMin && prop.hasMax) {
                    info += "|min=" + prop.minValue + "|max=" + prop.maxValue;
                    minmaxOK++;
                }
            } catch (e2) {}

            // 单位文本
            try {
                if (prop.unitsText !== undefined && prop.unitsText !== "") {
                    info += "|units=" + prop.unitsText;
                    unitsOK++;
                }
            } catch (e3) {}

            // 下拉选项文字（26.0 新增，两个 API 都试）
            var isPopupish = (pvt.indexOf("OneD") >= 0); // 下拉在脚本里通常是 OneD
            if (isPopupish) {
                var got = false;
                try {
                    if (prop.propertyParameters) {
                        info += "|propertyParameters=" + String(prop.propertyParameters.join("/"));
                        ppOK++; got = true; popupLike++;
                    }
                } catch (e4) { errs["propertyParameters不可用"] = (errs["propertyParameters不可用"] || 0) + 1; }
                try {
                    if (prop.valueText !== undefined && String(prop.valueText) !== "") {
                        info += "|valueText=" + prop.valueText;
                        vtOK++;
                    }
                } catch (e5) { errs["valueText不可用"] = (errs["valueText不可用"] || 0) + 1; }
                if (!got) info += "|下拉选项名=读不到";
            }

            // 表达式可读性
            try {
                if (prop.expressionEnabled) info += "|有表达式";
            } catch (e6) {}

            if (popupLike <= 25) push("PARAM|" + fx.matchName + "|" + info);
        }

        try { eff.remove(); } catch (eClean) {}
    }

    push("SUMMARY|尝试=" + tried + "|成功添加=" + added +
         "|含下拉候选读取=" + popupLike +
         "|propertyParameters可用=" + ppOK +
         "|valueText可用=" + vtOK +
         "|minmax可用=" + minmaxOK + "|units可用=" + unitsOK);
    for (var k in errs) {
        if (errs.hasOwnProperty(k)) push("ERRCOUNT|" + k + "|" + errs[k]);
    }

    var outFile = new File(outDir.fsName + "/T0_5_参数读取.txt");
    outFile.open("w");
    outFile.write(L.join("\r\n"));
    outFile.close();

    var log = new File(outDir.fsName + "/探针日志.txt");
    log.open("a");
    log.write("T0_5 参数读取 | AE " + app.version + " | 添加成功=" + added +
              " | propertyParameters可用=" + ppOK + " | valueText可用=" + vtOK +
              " | 输出=T0_5_参数读取.txt\r\n");
    log.close();

    alert("T0_5 完成\n添加成功效果数=" + added +
          "\npropertyParameters 可用次数=" + ppOK +
          "\nvalueText 可用次数=" + vtOK +
          "\n\n结果：" + outFile.fsName +
          "\n\n【重要】不要 Ctrl+Z 清理，直接关闭项目且不保存。");
})();
