// ============================================================
// queue.jsx —— 生成队列
//
// 状态机：pending → rendering → cached
//                     └→ failed（超过 MAX_ATTEMPTS 次仍失败）
//
// 持久化格式：TSV（不是 JSON）。原因很实际——ExtendScript 没有内置 JSON.parse，
// 而队列必须在 AE 侧独立读写（面板关闭后仍要能续做）。TSV 用 readln + split
// 就够了，不引入 json2.js 这类体积大、易踩坑的依赖。
//
// 一次 drain 默认只渲一张 contact sheet，把 AE 的阻塞时间控制在一到两秒量级；
// 面板循环调用 drain 推进，这样用户随时能中断。
//
// 依赖：store.jsx、previewgen.jsx、render_config.jsx
// 语法：ES3 only。
// ============================================================

var AEV_Queue = (function () {
    var QUEUE_FILE = "cache/queue.tsv";
    var MAX_ATTEMPTS = 2;
    var COLUMNS = 5;
    var SEP = "\t";

    function nowText() {
        var d = new Date();
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
               " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    }

    function pad(value) {
        var text = String(value);
        return text.length < 2 ? "0" + text : text;
    }

    function cleanField(value) {
        var text = String(value === undefined || value === null ? "" : value);
        return text.replace(/\t/g, " ").replace(/[\r\n]+/g, " ");
    }

    function emptyRow(matchName) {
        return { matchName: matchName, status: "pending", reason: "", attempts: 0, updatedAt: "" };
    }

    /** 读队列；文件不存在或损坏时返回空表 */
    function load() {
        var rows = [];
        var byName = {};
        if (typeof AEV_Store === "undefined") return { rows: rows, byName: byName };

        var text = AEV_Store.readText(QUEUE_FILE);
        if (!text) return { rows: rows, byName: byName };

        var lines = text.split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!line || line.length === 0) continue;
            var parts = line.split(SEP);
            if (parts.length < COLUMNS) continue;
            var row = {
                matchName: parts[0],
                status: parts[1],
                reason: parts[2],
                attempts: parseInt(parts[3], 10) || 0,
                updatedAt: parts[4]
            };
            if (!row.matchName) continue;
            rows.push(row);
            byName[row.matchName] = row;
        }
        return { rows: rows, byName: byName };
    }

    function save(queue) {
        var lines = [];
        for (var i = 0; i < queue.rows.length; i++) {
            var row = queue.rows[i];
            lines.push([
                cleanField(row.matchName),
                cleanField(row.status),
                cleanField(row.reason),
                String(row.attempts),
                cleanField(row.updatedAt)
            ].join(SEP));
        }
        return AEV_Store.writeText(QUEUE_FILE, lines.join("\r\n"));
    }

    function setStatus(queue, matchName, status, reason) {
        var row = queue.byName[matchName];
        if (!row) {
            row = emptyRow(matchName);
            queue.rows.push(row);
            queue.byName[matchName] = row;
        }
        row.status = status;
        row.reason = reason || "";
        row.updatedAt = nowText();
        return row;
    }

    /** 把效果清单合并进队列；已存在的条目不重置状态 */
    function ensure(matchNames) {
        if (!matchNames) return "{}";
        var queue = load();
        var added = 0;
        for (var i = 0; i < matchNames.length; i++) {
            var name = matchNames[i];
            if (!name) continue;
            if (!queue.byName[name]) {
                queue.rows.push(emptyRow(name));
                queue.byName[name] = queue.rows[queue.rows.length - 1];
                added++;
            }
        }
        if (added > 0) save(queue);
        return "{\"added\":" + added + ",\"total\":" + queue.rows.length + "}";
    }

    /** CEP 侧已存在的预览（manifest 里的）标记为 cached */
    function markCached(matchNames) {
        if (!matchNames) return "{}";
        var queue = load();
        var marked = 0;
        for (var i = 0; i < matchNames.length; i++) {
            var name = matchNames[i];
            if (!name) continue;
            var row = queue.byName[name];
            if (!row) {
                row = emptyRow(name);
                queue.rows.push(row);
                queue.byName[name] = row;
            }
            if (row.status !== "cached") {
                setStatus(queue, name, "cached", "existing");
                marked++;
            }
        }
        if (marked > 0) save(queue);
        return "{\"marked\":" + marked + "}";
    }

    function countBy(status) {
        var queue = load();
        var count = 0;
        for (var i = 0; i < queue.rows.length; i++) {
            if (queue.rows[i].status === status) count++;
        }
        return count;
    }

    function stats() {
        var queue = load();
        var pending = 0, rendering = 0, cached = 0, failed = 0;
        for (var i = 0; i < queue.rows.length; i++) {
            var s = queue.rows[i].status;
            if (s === "pending") pending++;
            else if (s === "rendering") rendering++;
            else if (s === "cached") cached++;
            else if (s === "failed") failed++;
        }
        return "{\"total\":" + queue.rows.length + ",\"pending\":" + pending +
               ",\"rendering\":" + rendering + ",\"cached\":" + cached +
               ",\"failed\":" + failed + "}";
    }

    /** 取前 limit 个 pending */
    function nextPending(queue, limit) {
        var out = [];
        for (var i = 0; i < queue.rows.length && out.length < limit; i++) {
            if (queue.rows[i].status === "pending") out.push(queue.rows[i].matchName);
        }
        return out;
    }

    /** 失败条目重新排队 */
    function retryFailed() {
        var queue = load();
        var reset = 0;
        for (var i = 0; i < queue.rows.length; i++) {
            if (queue.rows[i].status === "failed") {
                queue.rows[i].status = "pending";
                queue.rows[i].attempts = 0;
                queue.rows[i].reason = "";
                queue.rows[i].updatedAt = nowText();
                reset++;
            }
        }
        if (reset > 0) save(queue);
        return "{\"reset\":" + reset + "}";
    }

    /** 取队首 limit 个 pending。
     *  注意：这里按"还剩多少空格"取，而不是按 sheetIndex 跳段——因为一张网
     *  未必总是填满（L1 已有 20 张图时，第一张网只剩 44 个空位）。
     *  sheetIndex 只决定输出文件名，不参与挑选。
     */
    function batchOf(queue, limit) {
        var out = [];
        for (var i = 0; i < queue.rows.length && out.length < limit; i++) {
            if (queue.rows[i].status === "pending") out.push(queue.rows[i].matchName);
        }
        return out;
    }

    /**
     * 推进一批：取最多 perSheet 个 pending，渲一张网。
     * options: { extensionPath, outputRoot, startTime, perSheet }
     * 返回汇总 JSON（供面板显示进度）
     */
    function drain(sheetIndex, options) {
        if (typeof AEV_PreviewGen === "undefined" || typeof AEV_Store === "undefined") {
            return "{\"status\":\"error\",\"reason\":\"engine_not_loaded\"}";
        }
        var conf = AEV_PreviewGen.config();
        var perSheet = (options && options.perSheet) || conf.contactSheet.effectsPerSheet;
        var limit = (options && options.limit) || perSheet;

        var queue = load();
        var batch = batchOf(queue, limit);
        if (batch.length === 0) {
            return "{\"status\":\"idle\",\"remaining\":0}";
        }

        for (var i = 0; i < batch.length; i++) setStatus(queue, batch[i], "rendering", "");
        save(queue);

        var started = new Date().getTime();
        var raw = AEV_PreviewGen.renderBatch(batch, sheetIndex, options);
        var elapsed = (new Date().getTime() - started) / 1000;
        var ok = raw.indexOf("\"status\":\"ok\"") >= 0;

        // 重新读一次，避免渲染期间队列被外部改动
        var after = load();
        for (var j = 0; j < batch.length; j++) {
            var row = after.byName[batch[j]];
            if (row && row.status === "rendering") {
                if (ok) {
                    setStatus(after, batch[j], "cached", "");
                } else {
                    row.attempts = (row.attempts || 0) + 1;
                    if (row.attempts >= MAX_ATTEMPTS) {
                        setStatus(after, batch[j], "failed", shortReason(raw));
                    } else {
                        setStatus(after, batch[j], "pending", shortReason(raw));
                    }
                }
            }
        }
        save(after);

        var summary = stats();
        var namesJson = [];
        for (var k = 0; k < batch.length; k++) namesJson.push(jsonQuote(batch[k]));
        return "{\"status\":\"" + (ok ? "ok" : "error") +
               "\",\"cells\":" + batch.length +
               ",\"seconds\":" + (Math.round(elapsed * 100) / 100) +
               ",\"names\":[" + namesJson.join(",") + "]" +
               ",\"batch\":" + jsonQuote(raw) +
               ",\"queue\":" + summary + "}";
    }

    function shortReason(raw) {
        var text = String(raw || "");
        var at = text.indexOf("\"reason\"");
        if (at < 0) return "unknown";
        var rest = text.substring(at + 9);
        var start = rest.indexOf("\"") + 1;
        var end = rest.indexOf("\"", start);
        if (start <= 0 || end < 0) return "unknown";
        var reason = rest.substring(start, end);
        return reason.length > 80 ? reason.substring(0, 80) : reason;
    }

    function jsonQuote(value) {
        var out = String(value === undefined || value === null ? "" : value);
        out = out.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return '"' + out + '"';
    }

    /** 清空队列（不动已生成的图片） */
    function reset() {
        var queue = { rows: [], byName: {} };
        save(queue);
        return "{\"status\":\"reset\"}";
    }

    return {
        QUEUE_FILE: QUEUE_FILE,
        load: load,
        save: save,
        ensure: ensure,
        markCached: markCached,
        countBy: countBy,
        stats: stats,
        nextPending: nextPending,
        retryFailed: retryFailed,
        drain: drain,
        reset: reset
    };
})();
