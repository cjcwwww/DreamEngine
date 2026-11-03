// ============================================================
// run_m2_probe.jsx —— M2 地基验证（场景 / 素材 / 参数树 / 名字表）
//
// 一次运行回答四件事：
//   1. names.tsv 能不能被 engine 读到（L-A/L-B/L-C 三层的前提）
//   2. sceneFor 的推断在真实效果上是否合理
//   3. 参数树抽取能否拿到参数名与取值范围（写配方的依据）
//   4. 新标准素材（带高频细线的 photo / 文本层 / 形状层）能否渲出图
//
// 运行方式：AE 菜单 文件 > 脚本 > 运行脚本文件
// 输出：<我的文档>/DreamEngineProbe/m2_probe.txt
// 语法：ES3 only。
// ============================================================

(function runM2Probe() {
    // 不测 ADBE Numbers2 / Timecode：这类文本生成器在 addProperty 时会弹模态对话框，
    // 脚本会一直等输入，AE 看起来像死机（2026-11-03 实测）。文本场景的映射已验证，
    // 这里只验证 texture 层面的三种素材。
    var RENDER_CASES = [
        { matchName: "ADBE Stroke", sheet: 20, note: "shape 场景" },
        { matchName: "CC Radial Blur", sheet: 21, note: "photo 场景（带高频细线）" },
        { matchName: "ADBE Ramp", sheet: 22, note: "solid 场景" }
    ];

    var ext = new Folder(Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel");
    var logDir = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!logDir.exists) logDir.create();
    var logFile = new File(logDir.fsName + "/m2_probe.txt");
    logFile.encoding = "UTF-8";

    var lines = [];
    function push(t) { lines.push(t); }
    function flush() {
        logFile.open("w");
        logFile.write(lines.join("\r\n"));
        logFile.close();
    }

    var modules = [
        "engine/render_config.jsx",
        "engine/store.jsx",
        "engine/names.jsx",
        "engine/assets.jsx",
        "engine/recipe.jsx",
        "engine/previewgen.jsx",
        "engine/queue.jsx",
        "engine/catalog.jsx"
    ];

    try {
        push("PROBE=M2");
        push("AE_VERSION=" + app.version);
        for (var i = 0; i < modules.length; i++) {
            var file = new File(ext.fsName + "/" + modules[i]);
            if (!file.exists) {
                push("MISSING_MODULE=" + modules[i]);
                flush();
                return;
            }
            $.evalFile(file);
        }
        push("LOAD=OK");

        // ---------- 1. 名字表 ----------
        var index = AEV_Names.load(ext.fsName);
        push("NAMES|ok=" + index.ok + "|count=" + index.count);
        var sample = AEV_Names.resolve(index, "ADBE Gaussian Blur 2", "x", "zh");
        push("NAMES_SAMPLE|" + sample.name + "|" + sample.category + "|" + sample.level);

        // ---------- 2. 场景推断 ----------
        var scenes = ["CC Bender", "ADBE Numbers2", "ADBE Stroke", "ADBE Gaussian Blur 2", "ADBE 3D Tracker"];
        for (var s = 0; s < scenes.length; s++) {
            var scene = AEV_Recipe.sceneFor(scenes[s]);
            push("SCENE|" + scenes[s] + "|" + scene + "|asset=" + AEV_Recipe.assetKindFor(scene));
        }

        // ---------- 3. 参数树 ----------
        var tree = AEV_Catalog.getParamTreeJson("ADBE Gaussian Blur 2");
        push("TREE_LEN=" + tree.length);
        push("TREE_HEAD=" + (tree.length > 400 ? tree.substring(0, 400) : tree));
        // 渲染前的结论先落盘：万一下面的渲染卡住，这部分也能拿到
        flush();

        // ---------- 4. 渲染三种素材 ----------
        var okCount = 0;
        for (var r = 0; r < RENDER_CASES.length; r++) {
            var item = RENDER_CASES[r];
            var started = new Date().getTime();
            var raw;
            try {
                raw = AEV_PreviewGen.renderBatch([item.matchName], item.sheet, {
                    cellOffset: 0,
                    outputRoot: "extension",
                    extensionPath: ext.fsName
                });
            } catch (e) {
                raw = '{"status":"error","reason":"exception:' + String(e) + '"}';
            }
            var elapsed = Math.round(((new Date().getTime() - started) / 1000) * 100) / 100;
            var ok = raw.indexOf('"status":"ok"') >= 0;
            if (ok) okCount++;
            push("RENDER|" + item.matchName + "|" + item.note + "|" +
                 (ok ? "OK" : "FAIL") + "|" + elapsed + "s|" +
                 (ok ? "" : String(raw).substring(0, 200)));
            flush();
        }

        push("RENDER_SUMMARY|ok=" + okCount + "/" + RENDER_CASES.length);
        push("ASSET_FP=" + AEV_Assets.fingerprint());
        push("CACHE_KEY=" + AEV_Recipe.cacheKey("CC Bender", AEV_Assets.fingerprint(), 256, 6));
        push("RESULT=DONE");
    } catch (e2) {
        push("EXCEPTION=" + e2.toString());
        push("RESULT=EXCEPTION");
    }

    flush();
})();
