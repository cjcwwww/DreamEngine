// ============================================================
// run_m3_probe.jsx —— M2 场景分派 + 缓存指纹实机验证
//
// 验证三件事：
//   1. 两层输入类（置换图/复合模糊/设置遮罩）搭出双图层后是否真的"有变化"
//   2. 调整层类（填充/渐变）垫背景后是否正常
//   3. staleList 能否用指纹判出"配方变了、旧图过期"
//
// 运行：AfterFX.exe -r tools/run_m3_probe.jsx
// 输出：<我的文档>/DreamEngineProbe/m3_probe.txt
// 语法：ES3 only。
// ============================================================

(function runM3Probe() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();
    var log = new File(OUT.fsName + "/m3_probe.txt");
    log.encoding = "UTF-8";

    var lines = [];
    function push(text) { lines.push(text); }
    function flush() {
        if (log.open("w")) {
            log.write(lines.join("\r\n"));
            log.close();
        }
    }

    var MODULES = [
        "engine/render_config.jsx",
        "engine/store.jsx",
        "engine/names.jsx",
        "engine/assets.jsx",
        "engine/recipe.jsx",
        "engine/previewgen.jsx",
        "engine/queue.jsx"
    ];

    var TARGETS = [
        "ADBE Displacement Map",
        "ADBE Compound Blur",
        "ADBE Set Matte3",
        "ADBE Fill",
        "ADBE Ramp",
        "CC Radial Blur",
        "CC Kaleida",
        "CC Threshold"
    ];

    function clip(text, max) {
        var s = String(text);
        return s.length > max ? s.substring(0, max) : s;
    }

    push("PROBE=M3");
    push("AE=" + app.version);

    for (var i = 0; i < MODULES.length; i++) {
        try {
            $.evalFile(new File(EXT + "/" + MODULES[i]));
        } catch (e) {
            push("MODULE_FAIL|" + MODULES[i] + "|" + e);
            flush();
            return;
        }
    }
    push("MODULES=OK");
    push("RECIPE_VERSION=" + AEV_Recipe.RECIPE_VERSION);
    push("ASSET_VERSION=" + AEV_Assets.VERSION);
    flush();

    // ---- 场景分派 ----
    for (var t = 0; t < TARGETS.length; t++) {
        var name = TARGETS[t];
        var scene = AEV_Recipe.sceneFor(name);
        var layout = AEV_Recipe.layoutFor(scene);
        push("SCENE|" + name + "|" + scene + "|bg=" + layout.needBg +
             "|src=" + layout.needSource + "|base=" + layout.base);
    }
    flush();

    // ---- 一起渲一张网，逐格检查 ----
    var started = new Date().getTime();
    var raw = AEV_PreviewGen.renderBatch(TARGETS, 40, {
        outputRoot: "extension",
        extensionPath: EXT,
        cellOffset: 0
    });
    var elapsed = (new Date().getTime() - started) / 1000;
    push("RENDER_SECONDS=" + (Math.round(elapsed * 100) / 100));
    push("RENDER=" + clip(raw, 600));
    flush();

    // ---- 指纹与过期判定 ----
    var key = AEV_PreviewGen.itemKey("CC Lens", 256, 6);
    push("KEY_CC_LENS=" + key);

    var tmpRoot = OUT.fsName + "/staletest";
    var tmpData = new Folder(tmpRoot + "/data");
    if (!tmpData.exists) tmpData.create();
    var tsv = new File(tmpRoot + "/data/previews.tsv");
    tsv.encoding = "UTF-8";
    var rows = [
        "matchName\tsheet\tcell\tframes\tframeTemplate\tkey",
        "CC Lens\t1\t0\t6\tthumbs/batch_001_%04d.png\t" + key,
        "ADBE Glo2\t1\t1\t6\tthumbs/batch_001_%04d.png\tboguskey",
        "ADBE Twirl\t1\t2\t6\tthumbs/batch_001_%04d.png\t"
    ];
    if (tsv.open("w")) {
        tsv.write(rows.join("\r\n"));
        tsv.close();
        push("STALE_TEST_FILE=OK");
    } else {
        push("STALE_TEST_FILE=FAIL");
    }
    push("STALE=" + AEV_PreviewGen.staleList(tmpRoot));

    push("RESULT=OK");
    flush();
})();
