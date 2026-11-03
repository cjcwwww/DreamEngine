// ============================================================
// probe_effect_isolate.jsx —— 逐条隔离渲染探针
//
// 背景：整网批量渲染是"一损俱损"，一个格子报错（如"滤镜无效"）会让整张网失败，
// 而错误信息里看不出是哪个效果。本探针逐个效果单独渲染，定位坏条目。
//
// 运行方式：AE 菜单 文件 > 脚本 > 运行脚本文件
// 输出：<我的文档>/DreamEngineProbe/effect_isolate.txt
// 语法：ES3 only。
// ============================================================

(function probeEffectIsolate() {
    // 2026-11-03 面板点「生成缺失预览」时整批报
    //   Line 1849: var center = cs.convertPoint([0.5, 0.5]) / cs is not defined
    // 整网一损俱损，队列里 64 条被写了同一条 reason，无法定位。
    // 下面这批就是当时入队的前 8 个，末尾两个是已知可渲染的对照。
    var TARGETS = [
        "CC Radial Blur",
        "CC Color Offset",
        "CC Bender",
        "CC Burn Film",
        "CC Glue Gun",
        "VISINF Grain Implant",
        "CC Cylinder",
        "CC Glass Wipe",
        "CC Lens",
        "ADBE Gaussian Blur 2"
    ];

    var ext = new Folder(Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel");
    var outDir = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!outDir.exists) outDir.create();
    var tmpDir = new Folder(outDir.fsName + "/isolate");
    if (!tmpDir.exists) tmpDir.create();

    var logFile = new File(outDir.fsName + "/effect_isolate.txt");
    logFile.encoding = "UTF-8";
    var lines = [];
    function push(t) { lines.push(t); }
    function flush() {
        logFile.open("w");
        logFile.write(lines.join("\r\n"));
        logFile.close();
    }

    try {
        $.evalFile(new File(ext.fsName + "/engine/render_config.jsx"));
        $.evalFile(new File(ext.fsName + "/engine/recipe.jsx"));

        push("PROBE=EFFECT_ISOLATE");
        push("AE_VERSION=" + app.version);

        var scene = null;
        var okCount = 0;
        var failCount = 0;

        for (var i = 0; i < TARGETS.length; i++) {
            var matchName = TARGETS[i];
            var comp = null;
            var rq = null;
            try {
                if (!scene) scene = buildScene(256);

                comp = app.project.items.addComp("ISO_" + i, 256, 256, 1, 6 / 30, 30);
                var layer = comp.layers.add(scene);
                var fx = layer.property("ADBE Effect Parade").addProperty(matchName);
                var applied = AEV_Recipe.apply(fx, matchName, 256);

                rq = app.project.renderQueue.items.add(comp);
                var om = rq.outputModule(1);
                var template = pickPng(om);
                if (!template) throw new Error("no_png_template");
                om.applyTemplate(template);
                om.file = new File(tmpDir.fsName + "/iso_" + i + "_[####].png");
                rq.timeSpanStart = 0;
                rq.timeSpanDuration = 6 / 30;
                app.project.renderQueue.render();

                push("ITEM|" + matchName + "|OK|recipe=" + applied.mode + "/" + applied.writes);
                okCount++;
            } catch (e) {
                push("ITEM|" + matchName + "|FAIL|" + e.toString());
                failCount++;
            } finally {
                try { if (rq) rq.remove(); } catch (e1) {}
                try { if (comp) comp.remove(); } catch (e2) {}
            }
        }

        push("SUMMARY|ok=" + okCount + "|fail=" + failCount);
    } catch (e) {
        push("EXCEPTION=" + e.toString());
    }

    flush();
    alert("隔离探针完成：" + lines[lines.length - 1]);

    function buildScene(size) {
        var s = app.project.items.addComp("ISO_scene", size, size, 1, 6 / 30, 30);
        s.layers.addSolid([0.055, 0.065, 0.075], "bg", size, size, 1);
        var accent = s.layers.addSolid([0.18, 0.68, 0.76], "accent",
            Math.round(size * 0.59), Math.round(size * 0.35), 1);
        accent.property("ADBE Transform Group").property("ADBE Position")
            .setValue([Math.round(size * 0.5), Math.round(size * 0.52)]);
        var text = s.layers.addText("AE");
        var tp = text.property("ADBE Text Properties").property("ADBE Text Document");
        var doc = tp.value;
        doc.fontSize = Math.round(size * 0.25);
        doc.fillColor = [0.94, 0.94, 0.92];
        tp.setValue(doc);
        text.property("ADBE Transform Group").property("ADBE Position")
            .setValue([Math.round(size * 0.5), Math.round(size * 0.57)]);
        return s;
    }

    function pickPng(om) {
        var list = om.templates;
        for (var k = 0; k < list.length; k++) {
            if (String(list[k]).toLowerCase().indexOf("png") >= 0) return String(list[k]);
        }
        return null;
    }
})();
