// ============================================================
// names.jsx —— 名字解析（L-A / L-B / L-C 三层回退）
//
// 数据来源：data/names.tsv（由 names/tools/build_names_json.py 与 names.json 同源生成）
// 为什么用 TSV 而不是 JSON：ExtendScript 没有内置 JSON.parse，而名字解析必须在
// AE 侧可用（配方、日志、依赖检查都要按名字输出）。TSV 用 split 就能读。
//
// 三层语义（设计文档 §5.1）：
//   L-A  第一方效果官方双语名（helpx 级）
//   L-B  第三方插件英文名（中文名仅在汉化包真实提供时才启用）
//   L-C  表外效果 —— 用本机 displayName，中英同显，标 source=local
//
// 铁律：主键恒为 matchName，绝不用 displayName 做匹配。
//
// 语法：ES3 only。
// ============================================================

var AEV_Names = (function () {
    var COLUMNS = ["matchName", "nameEn", "nameZh", "categoryEn", "categoryZh", "pluginHint", "nameZhSource"];

    function splitLines(text) {
        return String(text || "").split(/\r?\n/);
    }

    /** 解析 TSV；首行若是表头则跳过 */
    function parseTsv(text) {
        var lines = splitLines(text);
        var rows = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!line || line.length === 0) continue;
            var cells = line.split("\t");
            if (cells.length < 2) continue;
            if (i === 0 && cells[0] === COLUMNS[0]) continue;   // 表头
            var row = { matchName: cells[0] };
            for (var c = 1; c < COLUMNS.length; c++) {
                row[COLUMNS[c]] = cells[c] === undefined ? "" : cells[c];
            }
            if (!row.matchName) continue;
            rows.push(row);
        }
        return rows;
    }

    function buildIndex(rows) {
        var byMatchName = {};
        for (var i = 0; i < rows.length; i++) {
            byMatchName[rows[i].matchName] = rows[i];
        }
        return byMatchName;
    }

    /** 从扩展目录读 names.tsv 并建索引；文件缺失时返回空索引（全部走 L-C） */
    function load(extensionPath) {
        var result = { byMatchName: {}, count: 0, ok: false };
        if (typeof AEV_Store === "undefined") return result;
        var text = AEV_Store.readText("names/names.tsv");
        if (!text) {
            // 扩展自带的 data/names.tsv 是打包路径，用户目录那份优先
            var file = new File(String(extensionPath) + "/data/names.tsv");
            if (!file.exists) return result;
            file.encoding = "UTF-8";
            file.open("r");
            text = file.read();
            file.close();
        }
        var rows = parseTsv(text);
        result.byMatchName = buildIndex(rows);
        result.count = rows.length;
        result.ok = rows.length > 0;
        return result;
    }

    function pick(row, lang, field) {
        if (!row) return "";
        var zhField = field + "Zh";
        var enField = field + "En";
        if (lang === "zh") {
            return row[zhField] || row[enField] || "";
        }
        return row[enField] || row[zhField] || "";
    }

    /**
     * 解析一个效果的名字与分类。
     * @param index        buildIndex/load 的产物
     * @param matchName    主键
     * @param displayName  本机显示名（L-C 兜底用）
     * @param lang         "zh" | "en"
     */
    function resolve(index, matchName, displayName, lang) {
        var byMatchName = (index && index.byMatchName) ? index.byMatchName : (index || {});
        var row = byMatchName[matchName];
        if (row) {
            return {
                name: pick(row, lang, "name"),
                category: pick(row, lang, "category"),
                plugin: row.pluginHint || "",
                source: row.nameZhSource || "table",
                level: "table"
            };
        }
        // L-C：表外效果，显示本机名字（中英同显），不机翻
        return {
            name: displayName || matchName,
            category: "",
            plugin: "",
            source: "local",
            level: "fallback"
        };
    }

    /**
     * 覆盖率：内置表对本机已安装效果的命中情况。
     * installedNames 是 matchName 数组。
     */
    function coverage(index, installedNames) {
        var byMatchName = (index && index.byMatchName) ? index.byMatchName : (index || {});
        var hit = 0;
        var miss = 0;
        var missSamples = [];
        for (var i = 0; i < installedNames.length; i++) {
            var name = installedNames[i];
            if (byMatchName[name]) {
                hit++;
            } else {
                miss++;
                if (missSamples.length < 10) missSamples.push(name);
            }
        }
        var total = hit + miss;
        return {
            total: total,
            hit: hit,
            miss: miss,
            ratio: total === 0 ? 0 : Math.round((hit / total) * 1000) / 10,
            missSamples: missSamples
        };
    }

    return {
        COLUMNS: COLUMNS,
        parseTsv: parseTsv,
        buildIndex: buildIndex,
        load: load,
        resolve: resolve,
        coverage: coverage
    };
})();
