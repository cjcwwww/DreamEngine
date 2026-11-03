// ============================================================
// T0_1 效果枚举探针
// 回答 M0 未知数 #1：app.effects 实际条数、第三方插件是否全含、category 真实形态
// 运行方式：AE 菜单 文件 > 脚本 > 运行脚本文件
// 输出：~/Documents/DreamEngineProbe/T0_1_效果枚举.txt（同时追加到 探针日志.txt）
// 注意：需先在 首选项 > 脚本和表达式 勾选「允许脚本写入文件和访问网络」
// ============================================================

(function probeEffectCatalog() {
    var OUT_DIR_NAME = "DreamEngineProbe";
    var outDir = new Folder(Folder.myDocuments.fsName + "/" + OUT_DIR_NAME);
    if (!outDir.exists) outDir.create();

    var outFile = new File(outDir.fsName + "/T0_1_效果枚举.txt");
    var logFile = new File(outDir.fsName + "/探针日志.txt");

    var lines = [];
    function push(s) { lines.push(s); }

    // --- 写权限自检（键名不存在时不中断探针） ---
    var canWrite = true;
    try {
        if (app.settings && app.settings.getBoolean) {
            canWrite = app.settings.getBoolean("Allow Scripts to Write Files and Access Network");
        }
    } catch (ePref) { canWrite = true; }
    if (canWrite === false) {
        alert("写入权限未开启：\n请打开 首选项 > 脚本和表达式 > 允许脚本写入文件和访问网络，然后重跑本探针。");
        return;
    }

    // --- 基础信息 ---
    push("PROBE=T0_1");
    push("AE_VERSION=" + app.version);
    push("APP_NAME=" + app.name);
    push("OS=" + $.os);
    push("LOCALEGuess=见 displayName 是否为中文，本探针不判断语言");

    // --- 枚举 ---
    var list = app.effects;
    var total = 0;
    var catHist = {};
    var noCategory = 0;
    var samples = [];
    var prefixHist = {};

    for (var i = 0; i < list.length; i++) {
        var fx = list[i];
        if (!fx || !fx.matchName) continue;
        total++;

        var cat = fx.category;
        if (cat === undefined || cat === null || cat === "") {
            cat = "(空)";
            noCategory++;
        }
        if (!catHist[cat]) catHist[cat] = 0;
        catHist[cat]++;

        // matchName 前缀分布（第三方常带厂商缩写前缀，验证 T1.4 推断规则可行性）
        var mn = String(fx.matchName);
        var pfx = "(无分隔)";
        var us = mn.indexOf("_");
        var sp = mn.indexOf(" ");
        if (us > 0 && us <= 6) pfx = mn.substring(0, us) + "_";
        else if (mn.indexOf("ADBE") === 0) pfx = "ADBE";
        else if (mn.indexOf("Pseudo/") === 0) pfx = "Pseudo/";
        else if (sp > 0 && sp <= 12) pfx = mn.substring(0, sp);
        if (!prefixHist[pfx]) prefixHist[pfx] = 0;
        prefixHist[pfx]++;

        // 前 60 条留样本，供人工核对 category 是否等于插件名
        if (samples.length < 60) {
            samples.push("SAMPLE|" + mn + "|" + fx.displayName + "|" + cat + "|" + fx.version);
        }
    }

    push("TOTAL_EFFECTS=" + total);
    push("EMPTY_CATEGORY_COUNT=" + noCategory);
    push("--- CATEGORY 分布 ---");
    for (var c in catHist) {
        if (catHist.hasOwnProperty(c)) push("CAT|" + c + "|" + catHist[c]);
    }
    push("--- MATCHNAME 前缀分布 ---");
    for (var p in prefixHist) {
        if (prefixHist.hasOwnProperty(p)) push("PFX|" + p + "|" + prefixHist[p]);
    }
    push("--- 样本(前60条) ---");
    for (var s = 0; s < samples.length; s++) push(samples[s]);

    // --- 落盘 ---
    outFile.open("w");
    outFile.write(lines.join("\r\n"));
    outFile.close();

    var txt = "T0_1 效果枚举 | AE " + app.version + " | 效果总数=" + total +
              " | 分类数=" + countKeys(catHist) + " | 空分类=" + noCategory +
              " | 输出=T0_1_效果枚举.txt";
    logFile.open("a");
    logFile.write(txt + "\r\n");
    logFile.close();

    alert(txt + "\n\n完整结果已写入：\n" + outFile.fsName + "\n\n请把这两个文件回传。");

    function countKeys(o) {
        var n = 0;
        for (var k in o) { if (o.hasOwnProperty(k)) n++; }
        return n;
    }
})();
