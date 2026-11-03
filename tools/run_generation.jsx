// ============================================================
// run_generation.jsx —— 引擎层冒烟脚本（在 AE 里手动运行）
//
// 用途：不经过 CEP 面板，直接验证 engine/*.jsx 能否在真实 AE 里跑通
//   · 模块能否按顺序加载
//   · 写权限自检返回什么
//   · renderBatch 能否建网、套效果、渲出 PNG
//   · 队列文档能否读写
//
// 运行方式：AE 菜单 文件 > 脚本 > 运行脚本文件 → 选本文件
// 输出：<我的文档>/DreamEngineProbe/engine_smoke.txt
//
// 注意：本脚本只渲 renderBatch，不写 manifest.json，不会动已有预览索引。
// 语法：ES3 only。
// ============================================================

(function runEngineSmoke() {
    var SMOKE_SHEET = 90;   // 用一个远高于正常值的 sheet 号，避免覆盖 batch_000
    var SMOKE_EFFECTS = [
        "ADBE Gaussian Blur 2",
        "APC Colorama",
        "CC Lens",
        "ADBE Turbulent Displace"
    ];

    var ext = new Folder(Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel");
    var logDir = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!logDir.exists) logDir.create();
    var logFile = new File(logDir.fsName + "/engine_smoke.txt");
    logFile.encoding = "UTF-8";

    var lines = [];
    function push(text) { lines.push(text); }
    function flush() {
        if (!logFile.open("w")) return false;
        logFile.write(lines.join("\r\n"));
        logFile.close();
        return true;
    }

    var modules = [
        "engine/render_config.jsx",
        "engine/store.jsx",
        "engine/recipe.jsx",
        "engine/previewgen.jsx",
        "engine/queue.jsx"
    ];

    try {
        push("PROBE=ENGINE_SMOKE");
        push("AE_VERSION=" + app.version);
        push("EXT=" + ext.fsName);
        if (!ext.exists) {
            push("RESULT=EXT_MISSING");
            flush();
            alert("扩展目录不存在：\n" + ext.fsName);
            return;
        }

        for (var i = 0; i < modules.length; i++) {
            var file = new File(ext.fsName + "/" + modules[i]);
            push("MODULE|" + modules[i] + "|exists=" + file.exists);
            if (!file.exists) {
                push("RESULT=MODULE_MISSING");
                flush();
                alert("缺少模块：" + modules[i]);
                return;
            }
            $.evalFile(file);
        }
        push("LOAD=OK");

        push("PERMISSION=" + AEV_Store.writePermission());
        push("STORE=" + AEV_Store.statusText());
        push("QUEUE_BEFORE=" + AEV_Queue.stats());

        var conf = AEV_PreviewGen.config();
        push("CONFIG|columns=" + conf.contactSheet.columns +
             "|cell=" + conf.contactSheet.cellSize +
             "|frames=" + conf.animatedPreview.frameCount);
        push("PLAN4=" + jsonOf(AEV_PreviewGen.plan(SMOKE_EFFECTS.length)));

        var started = new Date().getTime();
        var raw = AEV_PreviewGen.renderBatch(SMOKE_EFFECTS, SMOKE_SHEET, {
            outputRoot: "extension",
            extensionPath: ext.fsName
        });
        var elapsed = (new Date().getTime() - started) / 1000;
        push("RENDER_SECONDS=" + (Math.round(elapsed * 100) / 100));
        push("RENDER=" + raw);

        push("QUEUE_AFTER=" + AEV_Queue.stats());
        push("RESULT=" + (raw.indexOf("\"status\":\"ok\"") >= 0 ? "OK" : "RENDER_ERROR"));
    } catch (e) {
        push("EXCEPTION=" + e.toString());
        push("RESULT=EXCEPTION");
    }

    flush();
    alert("engine 冒烟完成：\n" + (lines[lines.length - 1] || "") + "\n\n日志：\n" + logFile.fsName);

    function jsonOf(value) {
        if (!value) return "{}";
        var parts = [];
        for (var k in value) {
            if (value.hasOwnProperty(k)) parts.push(k + ":" + value[k]);
        }
        return "{" + parts.join(",") + "}";
    }
})();
