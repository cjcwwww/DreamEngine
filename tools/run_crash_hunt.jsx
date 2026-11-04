// ============================================================
// run_crash_hunt.jsx —— 逐条渲染，定位让 AE 崩溃的效果
//
// 用途：整批渲染时 AE 进程直接消失，只能靠「一次只渲一个」定位。
// 渲染前先落名字，崩溃后日志最后一行就是元凶。
//
// 运行：AfterFX.exe -r tools/run_crash_hunt.jsx
// 输出：<我的文档>/DreamEngineProbe/crash_hunt.txt
// 语法：ES3 only。
// ============================================================

(function runCrashHunt() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();
    var log = new File(OUT.fsName + "/crash_hunt.txt");
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
        try {
            $.evalFile(new File(EXT + "/" + MODULES[i]));
        } catch (e) {
            push("MODULE_FAIL|" + MODULES[i] + "|" + e);
            flush();
            return;
        }
    }

    var TARGETS = [
        "ADBE Dust & Scratches",
        "CC Environment",
        "ADBE Color Difference Key",
        "CC Hair",
        "CC Force Motion Blur",
        "CC Glass",
        "CC Light Burst 2.5",
        "CC Grid Wipe"
    ];

    for (var t = 0; t < TARGETS.length; t++) {
        var name = TARGETS[t];
        push("BEGIN|" + name);
        flush();
        var started = new Date().getTime();
        var raw = AEV_PreviewGen.renderBatch([name], 910 + t, { outputRoot: "user" });
        var seconds = Math.round((new Date().getTime() - started) / 100) / 10;
        push("END|" + name + "|" + seconds + "s|" +
             (raw.indexOf("\"status\":\"ok\"") >= 0 ? "OK" : "FAIL"));
        flush();
    }
    push("RESULT=OK");
    flush();
})();
