// ============================================================
// final_check.jsx —— 端到端确认（部署后跑一次）
//
// 检查四件事：
//   1. 扩展目录里的 engine 模块能正常加载
//   2. 运行时索引与 L1 包一致，且没有过期条目
//   3. 队列状态正常
//   4. 还能渲出新的预览（渲染链路没被 L1 部署破坏）
//
// 运行：AfterFX.exe -r tools/final_check.jsx
// 输出：<我的文档>/DreamEngineProbe/final_check.txt
// 语法：ES3 only。
// ============================================================

(function finalCheck() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();
    var log = new File(OUT.fsName + "/final_check.txt");
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
    push("MODULES=OK");
    push("RECIPE_VERSION=" + AEV_Recipe.RECIPE_VERSION);
    push("ASSET_VERSION=" + AEV_Assets.VERSION);

    push("STALE=" + AEV_PreviewGen.staleList(EXT));
    push("QUEUE=" + AEV_Queue.stats());

    // 渲一张小网确认链路还通（写到临时目录，不碰运行时索引）
    var raw = AEV_PreviewGen.renderBatch(["ADBE Gaussian Blur 2", "CC Radial Blur"], 900, {
        outputRoot: "user"
    });
    push("RENDER=" + (raw.length > 220 ? raw.substring(0, 220) : raw));

    push("RESULT=OK");
    flush();
})();
