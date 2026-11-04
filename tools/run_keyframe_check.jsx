// ============================================================
// run_keyframe_check.jsx —— 验证关键帧是否真的生效
//
// 现象：部分效果 animate() 返回 true（setValueAtTime 没抛错），
// 但渲染出来的 6 帧逐像素相同。这里在设完关键帧后把值读回来，
// 区分两种情况：
//   · 值没变 → 关键帧对该属性无效（属性不可动画化，或被别的值覆盖）
//   · 值变了但画面不变 → 改的这个参数不影响最终画面
//
// 运行：AfterFX.exe -r tools/run_keyframe_check.jsx
// 输出：<我的文档>/DreamEngineProbe/keyframe_check.txt
// 语法：ES3 only。
// ============================================================

(function runKeyframeCheck() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();
    var log = new File(OUT.fsName + "/keyframe_check.txt");
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

    var TARGETS = [
        "ADBE Gaussian Blur 2",
        "ADBE Drop Shadow",
        "CC Toner",
        "ADBE Invert",
        "ADBE AutoColor",
        "ADBE Motion Blur",
        "CC Glue Gun",
        "ADBE Fractal Noise",
        "ADBE Arithmetic"
    ];

    for (var t = 0; t < TARGETS.length; t++) {
        var name = TARGETS[t];
        var comp = null;
        try {
            comp = app.project.items.addComp("DE_kf_" + t, 256, 256, 1, 0.2, 30);
            var layer = comp.layers.addSolid([0.4, 0.5, 0.6], "s", 256, 256, 1);
            var group = layer.property("ADBE Effect Parade").addProperty(name);
            var applied = AEV_Recipe.apply(group, name, 256);
            var animated = AEV_Recipe.animate(group, name, 0.2);
            if (!animated) animated = AEV_Recipe.animateAny(group, 0.2);

            // 找出效果里所有一维数值属性，读回它在 0 与 0.2 时刻的值
            var report = [];
            function walk(g, depth) {
                if (depth > 3) return;
                var count = 0;
                try { count = g.numProperties; } catch (e) { return; }
                for (var i = 1; i <= count; i++) {
                    var p = null;
                    try { p = g.property(i); } catch (e2) { continue; }
                    if (!p) continue;
                    var kids = 0;
                    try { kids = p.numProperties; } catch (e3) { kids = 0; }
                    if (kids > 0) { walk(p, depth + 1); continue; }
                    var type = "";
                    try { type = String(p.propertyValueType); } catch (e4) {}
                    if (type !== String(PropertyValueType.OneD)) continue;
                    var v0 = "?", v1 = "?";
                    try { v0 = String(p.valueAtTime(0)); } catch (e5) {}
                    try { v1 = String(p.valueAtTime(0.2)); } catch (e6) {}
                    var cur = "?";
                    try { cur = String(p.value); } catch (e7) {}
                    report.push(p.name + ":" + cur + "|" + v0 + "->" + v1);
                }
            }
            walk(group, 0);
            push("KF|" + name + "|mode=" + applied.mode + "|animated=" + animated +
                 "|" + report.join(" ; "));
        } catch (e) {
            push("KF_FAIL|" + name + "|" + e);
        } finally {
            try { if (comp) comp.remove(); } catch (eRm) {}
        }
        flush();
    }
    push("RESULT=OK");
    flush();
})();
