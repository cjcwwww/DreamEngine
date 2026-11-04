// ============================================================
// probe_plugin_effect.jsx —— 诊断：插件效果到底有没有真的改变画面
//
// 背景：首轮插件预览跑通后，插件图的像素签名与「素材原样」完全一致，
// 说明效果虽然 addProperty 成功，画面却没变。这个探针把问题拆成两问：
//   1. 同一素材，加效果前后像素是否不同？（用 renderBatch 的 noEffect 模式取对照图）
//   2. 效果加上去之后，它的参数被写成了什么？（属性清单 + 配方写入次数）
//
// 渲染全部走 AEV_PreviewGen.renderBatch（已验证稳定的链路），
// 只在「读属性」这一步自己搭合成，且不渲染 —— 避免手写渲染把 AE 搞崩。
//
// 运行：AfterFX.exe -r tools/probe_plugin_effect.jsx
// 输出：<我的文档>/DreamEngineProbe/plugin_probe.txt
//       <我的文档>/DreamEngine/cache/thumbs/probe_*_bare_*.png / probe_*_real_*.png
// 语法：ES3 only。
// ============================================================

(function probePluginEffect() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();

    var TARGETS = ["S_ChannelSwitcher", "BCC_AMBIENTLIGHT", "ADBE Glo2"];

    var lines = [];
    function flush() {
        var f = new File(OUT.fsName + "/plugin_probe.txt");
        f.encoding = "UTF-8";
        if (f.open("w")) { f.write(lines.join("\r\n")); f.close(); }
    }
    /* 每条都落盘：AE 被插件杀掉时，缓冲区里的内容会一起丢 */
    function log(text) { lines.push(text); flush(); }

    var MODULES = [
        "engine/render_config.jsx",
        "engine/store.jsx",
        "engine/assets.jsx",
        "engine/recipe.jsx",
        "engine/previewgen.jsx"
    ];
    for (var m = 0; m < MODULES.length; m++) {
        try {
            $.evalFile(new File(EXT + "/" + MODULES[m]));
        } catch (eMod) {
            log("MODULE_FAIL|" + MODULES[m] + "|" + eMod);
            return;
        }
    }

    var conf = AEV_PreviewGen.config();
    var cellSize = conf.contactSheet.cellSize;

    function valueText(prop) {
        try {
            var v = prop.value;
            if (v && v.length !== undefined) {
                var parts = [];
                for (var i = 0; i < v.length; i++) parts.push(String(v[i]));
                return "[" + parts.join(",") + "]";
            }
            return String(v);
        } catch (e) {
            return "?";
        }
    }

    for (var i = 0; i < TARGETS.length; i++) {
        var target = TARGETS[i];
        log("---- " + target + " ----");

        var scene = "photo";
        var kind = "photo";
        try {
            scene = AEV_Recipe.sceneFor(target);
            kind = AEV_Recipe.assetKindFor(scene);
        } catch (eScene) {
            log("SCENE_FAIL|" + eScene);
        }
        var effectName = target;
        try { effectName = AEV_Recipe.effectNameFor(target); } catch (eName) {}
        log("SCENE|" + scene + "|ASSET|" + kind + "|EFFECT_NAME|" + effectName);

        /* 1) 对照图：同一素材，只渲染不加效果 */
        var bare = AEV_PreviewGen.renderBatch([target], 2000 + i * 2, {
            outputRoot: "user",
            extensionPath: EXT,
            singleCell: true,
            noEffect: true
        });
        log("BARE|" + bare.substring(0, 220));

        /* 2) 效果图：正常渲染 */
        var real = AEV_PreviewGen.renderBatch([target], 2001 + i * 2, {
            outputRoot: "user",
            extensionPath: EXT,
            singleCell: true
        });
        log("REAL|" + real.substring(0, 220));

        /* 3) 属性清单与配方写入（不渲染，只读值） */
        var comp = app.project.items.addComp("probe_" + i, cellSize, cellSize, 1, 1 / 30, 30);
        try {
            var layer = comp.layers.add(AEV_Assets.get(kind, cellSize));
            var group = null;
            try {
                group = layer.property("ADBE Effect Parade").addProperty(effectName);
                log("ADD_OK|" + effectName);
            } catch (eAdd) {
                log("ADD_FAIL|" + eAdd);
            }
            if (group) {
                for (var p = 1; p <= group.numProperties; p++) {
                    try {
                        var prop = group.property(p);
                        log("PROP|" + p + "|" + prop.name + "|" +
                            prop.propertyValueType + "|" + prop.matchName +
                            "|value=" + valueText(prop));
                    } catch (eProp) {
                        log("PROP_FAIL|" + p + "|" + eProp);
                    }
                }
                try {
                    var applied = AEV_Recipe.apply(group, target, cellSize);
                    log("APPLY|" + applied.mode + "|writes=" + applied.writes);
                    for (var q = 1; q <= group.numProperties; q++) {
                        try {
                            var prop2 = group.property(q);
                            log("AFTER|" + q + "|" + prop2.name + "|" + valueText(prop2));
                        } catch (eAfter) {}
                    }
                } catch (eApply) {
                    log("APPLY_FAIL|" + eApply);
                }
            }
        } catch (eComp) {
            log("COMP_FAIL|" + eComp);
        }
        try { comp.remove(); } catch (eRemove) {}
    }

    log("DONE");
    try {
        app.quit(SaveOptions.DO_NOT_SAVE_CHANGES);
    } catch (eQuit) {}
})();
