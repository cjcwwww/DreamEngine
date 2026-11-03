// ============================================================
// T0_2 准备 aerender 测试工程
//
// 目的：不依赖 GUI 的 PNG 输出模块模板，先建立一个可保存的工程，
// 供 aerender 用 -outputSettings 显式覆盖输出格式。
// ============================================================

(function () {
    var outDir = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!outDir.exists) outDir.create();

    var report = new File(outDir.fsName + "/T0_2_prepare_aerender.txt");
    var projectFile = new File(outDir.fsName + "/T0_2_aerender_test.aep");
    var lines = [];
    function push(s) { lines.push(s); }

    push("PROBE=T0_2_PREPARE_AERENDER");
    push("AE_VERSION=" + app.version);

    var prj = app.project;
    var comp = prj.items.addComp("T0_2_AR_preview", 256, 256, 1, 1, 30);
    var solid = comp.layers.addSolid([0.2, 0.4, 0.8], "solid", 256, 256, 1);
    try {
        solid.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2");
        push("EFFECT=ADBE Gaussian Blur 2|ADD=OK");
    } catch (eEffect) {
        push("EFFECT=ADBE Gaussian Blur 2|ADD=FAIL|" + eEffect.toString());
    }

    var rq = prj.renderQueue.items.add(comp);
    rq.timeSpanStart = 0;
    rq.timeSpanDuration = comp.frameDuration;
    try {
        rq.outputModule(1).file = new File(outDir.fsName + "/T0_2_aerender_preview.png");
        push("OUTPUT_FILE_SET=OK");
    } catch (eFile) {
        push("OUTPUT_FILE_SET=FAIL|" + eFile.toString());
    }

    try {
        prj.save(projectFile);
        push("SAVE_PROJECT=OK|" + projectFile.fsName);
    } catch (eSave) {
        push("SAVE_PROJECT=FAIL|" + eSave.toString());
    }

    report.encoding = "UTF-8";
    report.open("w");
    report.write(lines.join("\r\n"));
    report.close();

    alert("T0_2 测试工程已准备：\n" + projectFile.fsName +
          "\n\n下一步用 aerender 验证 PNG outputSettings。");
})();
