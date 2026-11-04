// ============================================================
// run_anim_probe2.jsx —— 按 animate() 的真实选法取属性，读回插值结果
//
// 已排除的假设：
//   · 关键帧被丢弃 —— 否，numKeys=2，[0=0] [0.2=10] 都在
//   · 参数不可见 —— 否，投影「距离 0 vs 40」画面确实不同
// 剩下的可能：属性上只有起始关键帧时，值恒定；或 AE 对某些属性的
// 动画求值路径不同。这里读回 valueAtTime 在首/末帧时刻的值。
//
// 运行：AfterFX.exe -r tools/run_anim_probe2.jsx
// 输出：<我的文档>/DreamEngineProbe/anim_probe2.txt
// 语法：ES3 only。
// ============================================================

(function runAnimProbe2() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();
    var log = new File(OUT.fsName + "/anim_probe2.txt");
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
    var duration = FRAMES / CELL_FPS;
    var lastFrame = (FRAMES - 1) / CELL_FPS;

    var TARGETS = [
        "ADBE Drop Shadow", "ADBE Gaussian Blur 2", "ADBE Turbulent Displace",
        "ADBE Invert", "APC Colorama", "CC Toner"
    ];

    for (var t = 0; t < TARGETS.length; t++) {
        var name = TARGETS[t];
        var comp = null;
        try {
            comp = app.project.items.addComp("DE_p2_" + t, 256, 256, 1, duration, CELL_FPS);
            var layer = comp.layers.addSolid([0.4, 0.5, 0.6], "s", 256, 256, 1);
            var group = layer.property("ADBE Effect Parade").addProperty(name);
            var applied = AEV_Recipe.apply(group, name, 256);
            var animated = AEV_Recipe.animate(group, name, duration);

            // 按 animate() 的逻辑复现它选中的属性：配方第一个一维数值参数
            var steps = AEV_Recipe.recipes[name];
            var chosen = "?";
            var count = group.numProperties;
            if (steps) {
                for (var s = 0; s < steps.length; s++) {
                    for (var p = 1; p <= count; p++) {
                        var prop = group.property(p);
                        var matched = false;
                        for (var n = 0; n < steps[s].names.length; n++) {
                            if (prop.name === steps[s].names[n]) { matched = true; break; }
                        }
                        if (!matched) continue;
                        var isOneD = false;
                        try {
                            isOneD = (String(prop.propertyValueType) === String(PropertyValueType.OneD));
                        } catch (e) {}
                        if (!isOneD) continue;
                        chosen = prop.name;
                        var keys = prop.numKeys;
                        var kd = "";
                        for (var k = 1; k <= keys; k++) {
                            kd += " [" + prop.keyTime(k) + "=" + prop.keyValue(k) + "]";
                        }
                        var vStart = "?";
                        var vEnd = "?";
                        try { vStart = String(prop.valueAtTime(0)); } catch (e2) { vStart = "ERR"; }
                        try { vEnd = String(prop.valueAtTime(lastFrame)); } catch (e3) { vEnd = "ERR"; }
                        push("P2|" + name + "|prop=" + chosen + "|keys=" + keys + kd +
                             "|t0=" + vStart + "|tLast=" + vEnd +
                             "|anim=" + animated + "|mode=" + applied.mode);
                        s = steps.length;
                        break;
                    }
                }
            }
            if (chosen === "?") {
                push("P2|" + name + "|无可动画参数|anim=" + animated + "|mode=" + applied.mode);
            }
        } catch (e) {
            push("P2_FAIL|" + name + "|" + e);
        } finally {
            try { if (comp) comp.remove(); } catch (eRm) {}
        }
        flush();
    }
    push("RESULT=OK");
    flush();
})();
