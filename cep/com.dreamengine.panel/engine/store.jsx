// ============================================================
// store.jsx —— 用户数据层
//
// 职责边界：
//   · 只管"文件在哪、能不能写、读回来是什么文本"
//   · 不解析 JSON（ExtendScript 无内置 JSON），结构化数据由调用方约定
//   · 不碰任何 AE 合成 / 渲染对象
//
// 目录约定（设计文档 §3）：
//   <我的文档>/DreamEngine/
//     cache/thumbs/    L2 现场生成结果
//     library/         用户导入的预设
//     logs/            日志
//
// 语法：ES3 only，不依赖 JSON、Array.prototype 扩展。
// ============================================================

var AEV_Store = (function () {
    var ROOT_NAME = "DreamEngine";
    var PREF_SECTIONS = ["Main Pref Section", "Main Pref Section v2", "Scripting"];
    var PREF_SCRIPTING = "Pref_SCRIPTING_FILE_NETWORK_SECURITY";

    function userRootFolder() {
        return new Folder(Folder.myDocuments.fsName + "/" + ROOT_NAME);
    }

    function ensureFolder(folder) {
        if (!folder) return null;
        if (folder.exists) return folder;
        // create() 在有嵌套层级时会一次性创建完整路径
        return folder.create() ? folder : null;
    }

    function ensureUserRoot() {
        return ensureFolder(userRootFolder());
    }

    /** 用户目录下的绝对路径；根目录创建失败时返回 null */
    function resolve(relative) {
        var root = ensureUserRoot();
        if (!root) return null;
        var rel = String(relative === undefined || relative === null ? "" : relative);
        if (rel.length === 0) return root.fsName;
        return root.fsName + "/" + rel;
    }

    function fileAt(relative) {
        var abs = resolve(relative);
        return abs ? new File(abs) : null;
    }

    function folderAt(relative) {
        var abs = resolve(relative);
        return abs ? new Folder(abs) : null;
    }

    /** 确保某文件所在目录存在（写文件前调用） */
    function ensureParentOf(file) {
        if (!file) return false;
        var parent = file.parent;
        return parent ? !!ensureFolder(parent) : false;
    }

    function writeText(relative, text) {
        var file = fileAt(relative);
        if (!file) return "ERR:用户目录不可创建";
        if (!ensureParentOf(file)) return "ERR:父目录不可创建 " + file.parent.fsName;

        file.encoding = "UTF-8";
        if (!file.open("w")) return "ERR:打开失败 " + file.fsName;
        file.write(String(text === undefined || text === null ? "" : text));
        file.close();
        return "OK:" + file.fsName;
    }

    function readText(relative) {
        var file = fileAt(relative);
        if (!file || !file.exists) return "";
        file.encoding = "UTF-8";
        if (!file.open("r")) return "";
        var text = file.read();
        file.close();
        return text;
    }

    function appendLine(relative, line) {
        var file = fileAt(relative);
        if (!file) return "ERR:用户目录不可创建";
        if (!ensureParentOf(file)) return "ERR:父目录不可创建";
        file.encoding = "UTF-8";
        if (!file.open("a")) return "ERR:打开失败 " + file.fsName;
        file.write(String(line) + "\r\n");
        file.close();
        return "OK:" + file.fsName;
    }

    function exists(relative) {
        var file = fileAt(relative);
        return !!(file && file.exists);
    }

    function removeFile(relative) {
        var file = fileAt(relative);
        if (!file || !file.exists) return "OK:不存在";
        return file.remove() ? "OK:已删除" : "ERR:删除失败 " + file.fsName;
    }

    /** 列目录下的文件名（不含子目录），失败返回空数组 */
    function listNames(relative, pattern) {
        var folder = folderAt(relative);
        var out = [];
        if (!folder || !folder.exists) return out;
        var entries = folder.getFiles(pattern || "*");
        for (var i = 0; i < entries.length; i++) {
            if (entries[i] instanceof File) out.push(entries[i].name);
        }
        return out;
    }

    /** 删除目录下的文件（不递归删子目录），用于清理临时渲染产物 */
    function clearFiles(relative, pattern) {
        var folder = folderAt(relative);
        if (!folder || !folder.exists) return 0;
        var entries = folder.getFiles(pattern || "*");
        var removed = 0;
        for (var i = 0; i < entries.length; i++) {
            if (entries[i] instanceof File) {
                try {
                    if (entries[i].remove()) removed++;
                } catch (e) {}
            }
        }
        return removed;
    }

    /** 写权限自检。
     *  app.settings 在 AE 中并不存在（旧代码的误用），正确入口是 app.preferences。
     *  但首选项键名在不同版本之间会漂移（Main Pref Section / ... v2），
     *  所以这里做两层判定：
     *    1) 读首选项，明确读到 0 就直接判关闭
     *    2) 实际写一个探测文件——这才是"能不能写"的唯一可靠证据
     *  返回 1 = 可写，0 = 不可写，null = 两层都无法判定。
     */
    function prefValue() {
        try {
            if (!(app && app.preferences && app.preferences.getPrefAsLong)) return null;
            for (var i = 0; i < PREF_SECTIONS.length; i++) {
                var value = app.preferences.getPrefAsLong(PREF_SECTIONS[i], PREF_SCRIPTING, -1);
                if (value === 1 || value === 0) return value;
            }
        } catch (e) {}
        return null;
    }

    /** 写一个探测文件再删掉；比读首选项更接近真相 */
    function writeProbe() {
        var root = ensureUserRoot();
        if (!root) return 0;
        var logs = new Folder(root.fsName + "/logs");
        if (!logs.exists && !logs.create()) return 0;
        var probe = new File(logs.fsName + "/.write_probe");
        var ok = false;
        try {
            if (probe.open("w")) {
                probe.write("1");
                probe.close();
                ok = true;
            }
        } catch (e) {
            ok = false;
        }
        try {
            if (probe.exists) probe.remove();
        } catch (e2) {}
        return ok ? 1 : 0;
    }

    function writePermission() {
        var pref = prefValue();
        if (pref === 0) return 0;
        var probe = writeProbe();
        if (probe === 1) return 1;
        // 写不进去：首选项说开着或读不到，都按不可写处理
        return pref === null ? null : 0;
    }

    /** 给面板自检用的可读状态字符串 */
    function statusText() {
        var perm = writePermission();
        var permText = perm === 1 ? "on" : (perm === 0 ? "off" : "unknown");
        var root = userRootFolder();
        return "permission=" + permText + "|root=" + (root.exists ? root.fsName : "absent");
    }

    return {
        ROOT_NAME: ROOT_NAME,
        userRootFolder: userRootFolder,
        ensureUserRoot: ensureUserRoot,
        resolve: resolve,
        fileAt: fileAt,
        folderAt: folderAt,
        writeText: writeText,
        readText: readText,
        appendLine: appendLine,
        exists: exists,
        removeFile: removeFile,
        listNames: listNames,
        clearFiles: clearFiles,
        writePermission: writePermission,
        statusText: statusText
    };
})();
