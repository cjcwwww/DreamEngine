// ============================================================
// run_numkeys.jsx —— 查关键帧到底留下了几个
//
// 事实：投影效果「距离 0 vs 40」画面不同（参数有效），
// 但打了关键帧之后 6 帧逐像素相同。
// 怀疑：第二个关键帧落在合成时长边界上被 AE 丢掉，
// 于是属性只剩一个关键帧 → 值恒定 → 每帧一样。
//
// 这里读回 numKeys / keyTime / keyValue，
// 并对比两种打点方式：结束于 duration 与结束于最后一帧时刻。
//
// 运行：AfterFX.exe -r tools/run_numkeys.jsx
// 输出：<我的文档>/DreamEngineProbe/numkeys.txt
// 语法：ES3 only。
// ============================================================

(function runNumKeys() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();
    var log = new File(OUT.fsName + "/numkeys.txt");
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

    var FRAMES = 6;
    var CELL_FPS = 30;
    var duration = FRAMES / CELL_FPS;          // 0.2
    var lastFrameTime = (FRAMES - 1) / CELL_FPS; // 0.1667

    var TARGETS = ["ADBE Drop Shadow", "ADBE Gaussian Blur 2", "ADBE Invert"];

    for (var t = 0; t < TARGETS.length; t++) {
        var name = TARGETS[t];
        var comp = null;
        try {
            comp = app.project.items.addComp("DE_nk_" + t, 256, 256, 1, duration, CELL_FPS);
            var layer = comp.layers.addSolid([0.4, 0.5, 0.6], "s", 256, 256, 1);
            var group = layer.property("ADBE Effect Parade").addProperty(name);
            AEV_Recipe.apply(group, name, 256);

            // 找配方里的主参数
            var steps = AEV_Recipe.recipes[name];
            var prop = null;
            if (steps) {
                var count = group.numProperties;
                for (var p = 1; p <= count && !prop; p++) {
                    var candidate = group.property(p);
                    for (var s = 0; s < steps.length && !prop; s++) {
                        for (var n = 0; n < steps[s].names.length; n++) {
                            if (candidate.name === steps[s].names[n]) {
                                prop = candidate;
                                break;
                            }
                        }
                    }
                }
            }
            if (!prop) {
                // 没有配方就退回启发式找第一个一维数值属性
                var c2 = group.numProperties;
                for (var q = 1; q <= c2 && !prop; q++) {
                    var pr = group.property(q);
                    try {
                        if (String(pr.propertyValueType) === String(PropertyValueType.OneD) &&
                            pr.numProperties === 0) prop = pr;
                    } catch (e) {}
                }
            }
            if (!prop) {
                push("NK|" + name + "|找不到可动画属性");
                continue;
            }

            // 方式一：结束于 duration
            prop.setValueAtTime(0, 0);
            prop.setValueAtTime(duration, 10);
            var keysA = prop.numKeys;
            var detailA = "";
            for (var k = 1; k <= keysA; k++) {
                detailA += " [" + prop.keyTime(k) + "=" + prop.keyValue(k) + "]";
            }

            // 方式二：结束于最后一帧时刻
            prop.setValueAtTime(lastFrameTime, 10);
            var keysB = prop.numKeys;
            var detailB = "";
            for (var j = 1; j <= keysB; j++) {
                detailB += " [" + prop.keyTime(j) + "=" + prop.keyValue(j) + "]";
            }

            push("NK|" + name + "|prop=" + prop.name +
                 "|duration=" + duration + "|lastFrame=" + lastFrameTime +
                 "|方式A(末=duration) keys=" + keysA + detailA +
                 "|方式B(末=末帧) keys=" + keysB + detailB);
        } catch (e) {
            push("NK_FAIL|" + name + "|" + e);
        } finally {
            try { if (comp) comp.remove(); } catch (eRm) {}
        }
        flush();
    }
    push("RESULT=OK");
    flush();
})();
