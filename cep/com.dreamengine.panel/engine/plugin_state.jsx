// ============================================================
// plugin_state.jsx —— 插件 L2 预览的纯状态逻辑（ES3，无 app 依赖）
//
// 为什么要单独一层：插件效果与内置效果混在同一张整网渲染会让 AE 进程
// 直接消失，脚本里 catch 不到。因此插件预览必须「逐条渲 + 渲前写心跳 +
// 崩溃后拉黑 + 每条成功立即落索引」。这些规则如果只写在离线脚本里就没法
// 自动测；抽成不碰 AE 对象的纯函数后，Node 侧可以用 vm 直接跑断言。
//
// 本文件只处理字符串与数组，不读写文件、不调用 app：
//   · 心跳日志的「BEGIN 未配对 = 崩溃」判定
//   · 崩溃黑名单（TSV 给 ExtendScript 读 / JSON 给面板读）
//   · 独立 L2 索引（plugin_previews.tsv / plugin_manifest.json）
//
// 语法：ES3 only（ExtendScript 没有 JSON.parse、let/const、箭头函数）。
// ============================================================

var AEV_PluginState = (function () {
    var VERSION = 1;
    var ENTRY_HEADER = "matchName\tsheet\tframes\tframeTemplate\tplugin";
    var BLACKLIST_HEADER = "matchName\treason";

    function jsonText(value) {
        var out = String(value === undefined || value === null ? "" : value);
        out = out.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        out = out.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
        return '"' + out + '"';
    }

    function splitLines(text) {
        var raw = String(text === undefined || text === null ? "" : text);
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.substring(1);
        var parts = raw.split(/\r?\n/);
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            if (parts[i]) out.push(parts[i]);
        }
        return out;
    }

    function cells(line) {
        return String(line).split("\t");
    }

    /* ---------- 心跳日志 ---------- */

    function logLine(kind, name, extra) {
        return kind + "|" + name + "|" + String(extra === undefined ? "" : extra);
    }

    /**
     * 扫一遍历史日志，找出「写了 BEGIN 却没有 OK / FAIL / SKIP」的效果。
     * AE 进程被插件杀掉时，日志正好停在最后一条 BEGIN 上——那些就是元凶。
     */
    function parseLog(text) {
        var lines = splitLines(text);
        var pending = {};
        var order = [];
        for (var i = 0; i < lines.length; i++) {
            var p = String(lines[i]).split("|");
            var kind = p[0];
            var name = p[1] || "";
            if (!name) continue;
            if (kind === "BEGIN") {
                if (!pending[name]) order.push(name);
                pending[name] = true;
            } else if (kind === "OK" || kind === "FAIL" || kind === "SKIP") {
                delete pending[name];
            }
        }
        var crashed = [];
        for (var k = 0; k < order.length; k++) {
            if (pending[order[k]]) crashed.push(order[k]);
        }
        return { lines: lines, crashed: crashed };
    }

    /* ---------- 崩溃黑名单 ---------- */

    function readBlacklist(tsvText) {
        var map = {};
        var lines = splitLines(tsvText);
        for (var i = 0; i < lines.length; i++) {
            if (lines[i] === BLACKLIST_HEADER) continue;
            var p = cells(lines[i]);
            if (p[0]) map[p[0]] = p[1] || "crash";
        }
        return map;
    }

    function mergeBlacklist(map, names, reason) {
        var out = {};
        for (var key in map) {
            if (map.hasOwnProperty(key)) out[key] = map[key];
        }
        for (var i = 0; i < names.length; i++) {
            if (names[i]) out[names[i]] = reason || "crash";
        }
        return out;
    }

    function blacklistTsv(map) {
        var lines = [BLACKLIST_HEADER];
        for (var key in map) {
            if (map.hasOwnProperty(key)) lines.push(key + "\t" + map[key]);
        }
        return lines.join("\r\n");
    }

    /** 面板读不了 TSV，另写一份 JSON；字段保持最小，方便 CEP 侧直接用 */
    function blacklistJson(map) {
        var items = [];
        for (var key in map) {
            if (map.hasOwnProperty(key)) {
                items.push('{"matchName":' + jsonText(key) +
                           ',"reason":' + jsonText(map[key]) + "}");
            }
        }
        return '{"version":' + VERSION + ',"items":[' + items.join(",") + "]}";
    }

    /* ---------- L2 独立索引 ---------- */

    function readEntries(tsvText) {
        var out = [];
        var lines = splitLines(tsvText);
        for (var i = 0; i < lines.length; i++) {
            if (lines[i] === ENTRY_HEADER) continue;
            var p = cells(lines[i]);
            if (p.length < 3 || !p[0]) continue;
            out.push({
                matchName: p[0],
                sheet: parseInt(p[1], 10) || 0,
                frames: parseInt(p[2], 10) || 1,
                frameTemplate: p[3] || "",
                plugin: p[4] || "其它插件"
            });
        }
        return out;
    }

    function entriesTsv(entries) {
        var lines = [ENTRY_HEADER];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            lines.push([
                String(e.matchName).replace(/\t/g, " "),
                String(e.sheet),
                String(e.frames),
                e.frameTemplate || "",
                e.plugin || "其它插件"
            ].join("\t"));
        }
        return lines.join("\r\n");
    }

    /** 同名条目只允许有一条；重渲时替换而不是追加 */
    function addEntry(entries, item) {
        var out = [];
        var replaced = false;
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].matchName === item.matchName) {
                out.push(item);
                replaced = true;
            } else {
                out.push(entries[i]);
            }
        }
        if (!replaced) out.push(item);
        out.sort(function (a, b) { return a.sheet - b.sheet; });
        return out;
    }

    /** 本次要渲的名单：跳过已有预览、黑名单，并限流 */
    function planRun(todo, entries, blacklist, limit) {
        var done = {};
        for (var i = 0; i < entries.length; i++) done[entries[i].matchName] = true;
        var out = [];
        var max = limit > 0 ? limit : todo.length;
        for (var t = 0; t < todo.length && out.length < max; t++) {
            var item = todo[t];
            if (!item || !item.matchName) continue;
            if (done[item.matchName]) continue;
            if (blacklist && blacklist[item.matchName]) continue;
            out.push({
                matchName: item.matchName,
                frames: item.frames || 6,
                plugin: item.plugin || "其它插件"
            });
        }
        return out;
    }

    /** 当前插件清单相对已有索引/黑名单的总体进度 */
    function planStats(todo, entries, blacklist) {
        var done = {};
        var blocked = blacklist || {};
        var total = 0;
        var finished = 0;
        var blacklisted = 0;
        for (var i = 0; i < entries.length; i++) done[entries[i].matchName] = true;
        for (var t = 0; t < todo.length; t++) {
            var item = todo[t];
            if (!item || !item.matchName) continue;
            total++;
            if (done[item.matchName]) finished++;
            else if (blocked[item.matchName]) blacklisted++;
        }
        return {
            total: total,
            done: finished,
            blacklisted: blacklisted,
            pending: Math.max(0, total - finished - blacklisted)
        };
    }

    /**
     * 拼面板用的独立索引。
     *
     * 插件图是 1×1 单格（128×128），不是 L1 的 8×8 整网；每个条目都带上
     * slice* 布局字段，spriteSlice 才不会按整网参数切片。
     * 不能复用 item 的 width/height：L1 里那是「格子尺寸」，不是整图尺寸，
     * 拿它当整图会让 rows 算成 1，所有格位都被压到 (0,0)。
     */
    function buildManifest(entries, size) {
        var conf = size || {};
        var cellSize = conf.cellSize || 128;
        var columns = conf.columns || 1;
        var width = conf.width || cellSize * columns;
        var height = conf.height || cellSize * columns;

        var items = [];
        var seenSheets = {};
        var sheets = [];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var tmpl = e.frameTemplate || "";
            var firstFrame = tmpl ? tmpl.replace("%04d", "0000") : "";
            var parts = ['"matchName":' + jsonText(e.matchName)];
            parts.push('"sheet":' + e.sheet);
            parts.push('"x":0,"y":0');
            parts.push('"width":' + cellSize + ',"height":' + cellSize);
            parts.push('"frames":' + e.frames);
            parts.push('"sliceColumns":' + columns + ',"sliceCellSize":' + cellSize);
            parts.push('"sliceWidth":' + width + ',"sliceHeight":' + height);
            parts.push('"plugin":' + jsonText(e.plugin || "其它插件"));
            if (tmpl) parts.push('"frameSrc":' + jsonText(tmpl));
            if (firstFrame) parts.push('"src":' + jsonText(firstFrame));
            items.push("{" + parts.join(",") + "}");

            if (!seenSheets[String(e.sheet)] && firstFrame) {
                seenSheets[String(e.sheet)] = true;
                sheets.push('{"index":' + e.sheet + ',"src":' +
                            jsonText(firstFrame) + ',"width":' + width +
                            ',"height":' + height + "}");
            }
        }
        // sheets 顺序无所谓：面板按 index 字段取，不按数组位置取
        return '{"version":' + VERSION + ',"cellSize":' + cellSize +
            ',"columns":' + columns + ',"width":' + width +
            ',"height":' + height + ',"sheets":[' + sheets.join(",") +
            '],"items":[' + items.join(",") + "]}";
    }

    return {
        VERSION: VERSION,
        jsonText: jsonText,
        logLine: logLine,
        parseLog: parseLog,
        readBlacklist: readBlacklist,
        mergeBlacklist: mergeBlacklist,
        blacklistTsv: blacklistTsv,
        blacklistJson: blacklistJson,
        readEntries: readEntries,
        entriesTsv: entriesTsv,
        addEntry: addEntry,
        planRun: planRun,
        planStats: planStats,
        buildManifest: buildManifest
    };
})();
