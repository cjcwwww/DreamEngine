// ============================================================
// T0_6 导入入口探针（AE 侧能测的部分）
// 回答 M0 未知数 #9（前半）：File.openDialog 多选是否可用、返回形态、
//                            Folder.selectDialog 递归取 .ffx 的数量与耗时
// 说明：拖拽能否拿到真实路径必须在 CEP 壳里测，本探针不覆盖
// ============================================================

(function probeImportBasics() {
    var outDir = new Folder(Folder.myDocuments.fsName + "/AEViewerProbe");
    if (!outDir.exists) outDir.create();
    var L = [];
    function push(s) { L.push(s); }
    push("PROBE=T0_6");
    push("AE_VERSION=" + app.version);

    // ---------- 1. 多选文件对话框 ----------
    var t0 = new Date().getTime();
    var picked = null;
    try {
        picked = File.openDialog("请按住 Ctrl 选中 3 个以上 .ffx 文件", "*.ffx", true);
    } catch (eDialog) {
        push("MULTISELECT_THROW|" + String(eDialog));
    }
    push("DIALOG_MS=" + (picked ? (new Date().getTime() - t0) : 0) + "ms");

    if (picked === null || picked === false) {
        push("RESULT=用户取消，探针结束");
    } else if (picked instanceof File) {
        push("MULTISELECT_RETURN_TYPE=File(单对象)");
        push("PICKED_1|" + picked.fsName + "|" + picked.length + " bytes");
        push("VERDICT_MULTI=多选参数未生效，只拿到一个文件");
    } else {
        push("MULTISELECT_RETURN_TYPE=Array");
        push("PICKED_COUNT=" + picked.length);
        var totalBytes = 0;
        for (var i = 0; i < picked.length && i < 20; i++) {
            var f = picked[i];
            if (f instanceof File) {
                totalBytes += f.length;
                push("PICKED_" + i + "|" + f.fsName + "|" + f.length + " bytes");
            } else {
                push("PICKED_" + i + "|非File对象,类型=" + typeof f + "|值=" + String(f));
            }
        }
        push("CALC|平均每个ffx字节=" + (picked.length > 0 ? Math.round(totalBytes / Math.min(picked.length, 20)) : 0) +
             " 样本数=" + Math.min(picked.length, 20));
        push("VERDICT_MULTI=多选可用，返回数组");
    }

    // ---------- 2. 文件夹递归扫描耗时 ----------
    var folder = Folder.selectDialog("选择一个包含较多 .ffx 的预设目录（用来测递归耗时）");
    if (folder) {
        var st = new Date().getTime();
        var count = 0, depthMax = 0;
        scan(folder, 1);
        var cost = new Date().getTime() - st;
        push("FOLDER=" + folder.fsName);
        push("CALC|ffx文件数=" + count + "|扫描耗时ms=" + cost +
             "|平均每文件ms=" + (count > 0 ? Math.round(cost / count) : 0) +
             "|最大层级=" + depthMax);

        // 只用一次 getFiles 通配的方式做对比
        var st2 = new Date().getTime();
        var flat = folder.getFiles("*.ffx");
        push("CALC|单层getFiles(*.ffx)数量=" + flat.length + "|耗时ms=" + (new Date().getTime() - st2));
        push("VERDICT_SCAN=递归实现需在工程里用上面的耗时判断是否需要异步分批");

        function scan(dir, depth) {
            if (depth > depthMax) depthMax = depth;
            if (depth > 8) return;
            var items = dir.getFiles();
            for (var j = 0; j < items.length; j++) {
                var it = items[j];
                if (it instanceof Folder) {
                    scan(it, depth + 1);
                } else if (it instanceof File && /\.ffx$/i.test(it.name)) {
                    count++;
                }
            }
        }
    } else {
        push("RESULT=未选择文件夹，跳过递归测试");
    }

    var outFile = new File(outDir.fsName + "/T0_6_导入探针.txt");
    outFile.open("w");
    outFile.write(L.join("\r\n"));
    outFile.close();

    var log = new File(outDir.fsName + "/探针日志.txt");
    log.open("a");
    log.write("T0_6 导入探针 | 多选返回类型已记录 | 输出=T0_6_导入探针.txt\r\n");
    log.close();

    alert("T0_6 完成\n结果：" + outFile.fsName + "\n\n请一并回传该文件。");
})();
