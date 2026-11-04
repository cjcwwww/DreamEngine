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

  /** engine 目录下的模块，按依赖顺序加载。
   *  render_config 必须最先（previewgen 读它的定版参数），
   *  store 与 recipe 在 previewgen 之前（previewgen 依赖两者）。
   */
  var ENGINE_FILES = [
    "engine/render_config.jsx",
    "engine/store.jsx",
    "engine/names.jsx",
    "engine/assets.jsx",
    "engine/recipe.jsx",
    "engine/previewgen.jsx",
    "engine/queue.jsx",
    "engine/plugin_state.jsx",
    "engine/catalog.jsx"
  ];

  /** 加载 engine 全部模块并求值一个表达式。
   *  @param {string} extensionPath  扩展根目录（正斜杠）
   *  @param {string} expr   ES3 表达式，例如 AEV_Queue.stats()
   *  @param {function(string)} cb
   */
  function runEngine(extensionPath, expr, cb) {
    if (!isCEP()) {
      if (cb) cb("__NOT_CEP__");
      return;
    }
    if (!extensionPath) {
      if (cb) cb("ERR:no_extension_path");
      return;
    }

    var paths = [];
    for (var i = 0; i < ENGINE_FILES.length; i++) {
      paths.push(JSON.stringify(extensionPath + "/" + ENGINE_FILES[i]));
    }

    var jsx =
      "(function(){" +
      "  try{" +
      "    var files = [" + paths.join(",") + "];" +
      // 用文件修改时间做戳：戳没变就跳过 evalFile —— 每次调用都重载九个
      // 模块是面板刷新发顿的主因（一次刷新要调好几次 runEngine）。
      // 戳变了说明引擎代码改过，自动重载，开发期不用手动清缓存。
      "    var stamp = '';" +
      "    for(var i=0;i<files.length;i++){" +
      "      var f = new File(files[i]);" +
      "      if(!f.exists) return 'ERR:missing_engine:' + files[i];" +
      "      try { stamp += f.modified.getTime() + ':'; } catch(e1) { stamp += 'x:'; }" +
      "    }" +
      "    if (typeof AEV_EngineStamp === 'undefined') AEV_EngineStamp = '';" +
      "    if (stamp !== AEV_EngineStamp) {" +
      "      for(var j=0;j<files.length;j++){ $.evalFile(new File(files[j])); }" +
      "      AEV_EngineStamp = stamp;" +
      "    }" +
      "    return String(" + expr + ");" +
      "  }catch(e){return 'ERR:'+e.toString();}" +
      "})()";
    evalAE(jsx, cb);
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
      // AE 里没有 app.settings —— 旧代码那一行恒抛错、被 try/catch 吞掉，
      // 自检结果永远是 'no_api'，等于没检查。正确入口是 app.preferences。
      evalAERaw(
        'app.preferences && app.preferences.getPrefAsLong ? ' +
        'app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY", -1) ' +
        ': "no_api"',
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
    runEngine: runEngine,
    ENGINE_FILES: ENGINE_FILES,
    revealDir: revealDir,
    selfCheck: selfCheck
  };
})();
