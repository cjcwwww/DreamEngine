// ============================================================
// run_static_vs_anim.jsx —— 决定性实验
//
// 问题：部分效果（投影/反相/运动模糊…）打了关键帧但 6 帧逐像素相同。
// 两种可能：
//   A. 关键帧没生效（AE 不认这个属性的动画）
//   B. 关键帧生效了，但改的那个参数在这套素材下看不出画面差别
//
// 做法：同一张网里放两个格子——一个用静态值 0，一个用静态值 40。
//   · 两格画面不同 → 参数是有用的，问题在关键帧（情况 A）
//   · 两格画面相同 → 参数在这个场景下本来就看不出差别（情况 B）
//
// 运行：AfterFX.exe -r tools/run_static_vs_anim.jsx
// 输出：<我的文档>/DreamEngineProbe/static_vs_anim.txt
// 语法：ES3 only。
// ============================================================

(function runStaticVsAnim() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();
    var log = new File(OUT.fsName + "/static_vs_anim.txt");
    log.encoding = "UTF-8";

    var lines = [];
    function push(t) { lines.push(t); }
    function flush() { if (log.open("w")) { log.write(lines.join("\r\n")); log.close(); } }

    var MODULES = [
        "engine/render_config.jsx", "engine/store.jsx", "engine/names.jsx",
        "engine/assets.jsx", "engine/recipe.jsx", "engine/previewgen.jsx",
        "engine/queue.jsx"
    ];
    for (var i = 0; i < MODULES.length; i++) {
        $.evalFile(new File(EXT + "/" + MODULES[i]));
    }

    // 每组：一个效果名 + 要改的属性名 + 两个取值
    var CASES = [
        { effect: "ADBE Drop Shadow", param: "距离", low: 0, high: 40 },
        { effect: "ADBE Invert", param: "通道", low: 1, high: 2 },
        { effect: "ADBE Motion Blur", param: "模糊长度", low: 0, high: 400 },
        { effect: "APC Colorama", param: "阴影", low: 0, high: 100 },
        { effect: "CC Toner", param: "Blend w. Original", low: 0, high: 1 }
    ];

    for (var c = 0; c < CASES.length; c++) {
        var item = CASES[c];
        var comp = null;
        try {
            comp = app.project.items.addComp("DE_cmp_" + c, 512, 256, 1, 0.2, 30);
            for (var half = 0; half < 2; half++) {
                var layer = comp.layers.add(AEV_Assets.get("photo", 256));
                layer.property("ADBE Transform Group").property("ADBE Position")
                    .setValue([half * 256, 128]);
                var group = layer.property("ADBE Effect Parade").addProperty(item.effect);
                var value = half === 0 ? item.low : item.high;
                var set = false;
                var count = group.numProperties;
                for (var p = 1; p <= count; p++) {
                    var prop = group.property(p);
                    if (prop.name === item.param) {
                        try { prop.setValue(value); set = true; } catch (eSet) {}
                    }
                }
                push("CASE|" + item.effect + "|" + item.param + "|" + value + "|set=" + set);
            }
            flush();

            var folder = AEV_Store.folderAt("cache/cmp");
            if (folder && !folder.exists) folder.create();
            var rq = app.project.renderQueue.items.add(comp);
            var om = rq.outputModule(1);
            om.applyTemplate(AEV_PreviewGen.pngTemplate(om));
            om.file = new File(folder.fsName + "/cmp_" + c + ".png");
            rq.timeSpanStart = 0;
            rq.timeSpanDuration = 0.2;
            app.project.renderQueue.render();
            push("RENDERED|" + item.effect);
        } catch (e) {
            push("CASE_FAIL|" + item.effect + "|" + e);
        } finally {
            try { if (comp) comp.remove(); } catch (eRm) {}
        }
        flush();
    }
    push("RESULT=OK");
    flush();
})();
