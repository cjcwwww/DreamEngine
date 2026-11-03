/* ============================================================
 * bridge.js —— CEP ↔ AE(ExtendScript) 最小通道
 *
 * 分层约定（见设计文档 §2）：所有 AE 数据读写只走 evalAE 执行 .jsx 字符串，
 * 面板侧不出现任何 AE 对象引用。本文件是全项目唯一允许直接触碰
 * window.__adobe_cep__ 的地方。
 *
 * 语法：只用 ES5，避免依赖 CEF 的新特性。
 * ============================================================ */

var Bridge = (function () {

  function isCEP() {
    return !!(window.__adobe_cep__ && window.__adobe_cep__.evalScript);
  }

  /** 在 AE 的 ExtendScript 引擎里执行一段脚本字符串。
   *  @param {string} jsx  必须是自包含的 IIFE 或表达式，返回值会被转成字符串
   *  @param {function(string)} cb
   */
  function evalAE(jsx, cb) {
    if (!isCEP()) {
      if (cb) cb("__NOT_CEP__");
      return;
    }
    window.__adobe_cep__.evalScript(jsx, function (res) {
      if (cb) cb(res === undefined || res === null ? "" : String(res));
    });
  }

  /** 让 AE 侧把一个安全值取回来（自动包 IIFE + String()） */
  function evalAERaw(expr, cb) {
    evalAE("(function(){try{return String(" + expr + ")}catch(e){return 'ERR:'+e.toString()}})()", cb);
  }

  /** 通过 AE 写文本文件（复用探针的输出目录约定） */
  function writeFile(absPath, text, cb) {
    var jsx =
      "(function(){" +
      "  try{" +
      "    var f = new File(" + JSON.stringify(absPath) + ");" +
      "    if(!f.open('w')) return 'OPEN_FAIL:' + f.fsName;" +
      "    f.write(" + JSON.stringify(text) + ");" +
      "    f.close();" +
      "    return 'OK:' + f.fsName;" +
      "  }catch(e){return 'ERR:'+e.toString();}" +
      "})()";
    evalAE(jsx, cb);
  }

  /** 让 AE 列目录下的文件名（面板没有本地目录读取能力） */
  function listFiles(dirPath, pattern, cb) {
    var jsx =
      "(function(){" +
      "  try{" +
      "    var d = new Folder(" + JSON.stringify(dirPath) + ");" +
      "    if(!d.exists) return 'NO_DIR';" +
      "    var fs = d.getFiles(" + JSON.stringify(pattern) + ");" +
      "    var out = [];" +
      "    for(var i=0;i<fs.length;i++){" +
      "      if(fs[i] instanceof File) out.push(fs[i].name + '\\t' + fs[i].length);" +
      "    }" +
      "    return 'OK\\t' + out.join('\\n');" +
      "  }catch(e){return 'ERR:'+e.toString();}" +
      "})()";
    evalAE(jsx, cb);
  }

  /** 取「我的文档」绝对路径（交给 AE 判断，最可靠） */
  function getDocsPath(cb) {
    evalAE("(function(){try{return Folder.myDocuments.fsName}catch(e){return ''}})()", function (p) {
      if (!p || p.indexOf("ERR") === 0) { cb(""); return; }
      // 统一成正斜杠，便于拼 file:// URL
      cb(String(p).replace(/\\/g, "/"));
    });
  }

  /** 当前扩展根目录，用于让 AE 执行 engine/*.jsx。 */
  function getExtensionPath(cb) {
    try {
      var path = window.__adobe_cep__.getSystemPath("extension");
      cb(String(path).replace(/\\/g, "/"));
    } catch (e) {
      cb("");
    }
  }

  /** 打开目录（在资源管理器/Finder 里显示探针输出） */
  function revealDir(dirPath, cb) {
    var jsx = "(function(){try{return String(new Folder(" +
              JSON.stringify(dirPath) + ").execute())}catch(e){return 'ERR:'+e}})()";
    evalAE(jsx, cb);
  }

  /** 自检：AE 版本 + 写权限 */
  function selfCheck(cb) {
    var out = { cep: isCEP(), aeVersion: "", writePref: "unknown", docs: "" };
    if (!isCEP()) { cb(out); return; }
    evalAERaw("app.version", function (v) {
      out.aeVersion = v;
      evalAERaw(
        "(app.settings && app.settings.getBoolean) ? " +
        "app.settings.getBoolean('Allow Scripts to Write Files and Access Network') : 'no_api'",
        function (w) {
          out.writePref = w;
          getDocsPath(function (d) { out.docs = d; cb(out); });
        });
    });
  }

  return {
    isCEP: isCEP,
    evalAE: evalAE,
    evalAERaw: evalAERaw,
    writeFile: writeFile,
    listFiles: listFiles,
    getDocsPath: getDocsPath,
    getExtensionPath: getExtensionPath,
    revealDir: revealDir,
    selfCheck: selfCheck
  };
})();
