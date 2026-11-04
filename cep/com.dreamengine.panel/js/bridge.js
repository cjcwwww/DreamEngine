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

  /** 外部变更指纹：预设目录 / 背景目录 / 缩略图目录 / 四份索引的修改时间。
   *
   *  为什么需要：面板之外还有三条路径会改数据 ——
   *    · DreamEngine Hub（独立程序）导入预设
   *    · 一键 bat 渲染完写回索引与图片
   *    · 用户在资源管理器里直接往预设库丢 .ffx
   *  以前这些改完只能「关掉面板再重开」。这里只取 mtime 拼一个字符串，
   *  前端比对即可，不读文件内容，2~3 秒一次的开销可以忽略。
   *
   *  @param {string} extensionPath  扩展根目录（正斜杠）
   *  @param {function(string)} cb    形如 "1699...|1699...|x|..."，失败返回 ERR:xxx
   */
  function watchStamp(extensionPath, cb) {
    var base = extensionPath ? String(extensionPath).replace(/\\/g, "/") : "";
    var jsx =
      "(function(){" +
      "  try{" +
      "    var B = " + JSON.stringify(base) + ";" +
      "    if (!B) return 'ERR:no_base';" +
      "    var docs = Folder.myDocuments.fsName;" +
      "    var out = [];" +
      "    var dirs = [" +
      "      docs + '/DreamEngine/presets'," +
      "      docs + '/DreamEngine/backgrounds'," +
      "      B + '/data/thumbs'" +
      "    ];" +
      "    for (var i = 0; i < dirs.length; i++) {" +
      "      var t = 'x';" +
      "      try {" +
      "        var d = new Folder(dirs[i]);" +
      "        if (d.exists) t = String(d.modified.getTime());" +
      "      } catch (e1) {}" +
      "      out.push(t);" +
      "    }" +
      // 目录 mtime 只在「增删子项」时变，同名文件被覆盖不会变 ——
      // 所以索引文件本身的时间戳必须单独看，两者互补。
      "    var files = [" +
      "      B + '/data/manifest.json'," +
      "      B + '/data/plugin_manifest.json'," +
      "      B + '/data/preset_manifest.json'," +
      "      B + '/data/preset_plugin_manifest.json'," +
      "      B + '/data/animated.json'" +
      "    ];" +
      "    for (var j = 0; j < files.length; j++) {" +
      "      var t2 = 'x';" +
      "      try {" +
      "        var f = new File(files[j]);" +
      "        if (f.exists) t2 = String(f.modified.getTime());" +
      "      } catch (e2) {}" +
      "      out.push(t2);" +
      "    }" +
      "    return out.join('|');" +
      "  } catch (e) { return 'ERR:' + e.toString(); }" +
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
   *  curve_math 必须最先（纯数学，浏览器也加载同一个文件）；
   *  render_config 次之（previewgen 读它的定版参数）；
   *  store 与 recipe 在 previewgen 之前（previewgen 依赖两者）。
   */
  var ENGINE_FILES = [
    "engine/curve_math.js",
    "engine/render_config.jsx",
    "engine/store.jsx",
    "engine/names.jsx",
    "engine/curvelib.jsx",
    "engine/assets.jsx",
    "engine/recipe.jsx",
    "engine/apply.jsx",
    "engine/previewgen.jsx",
    "engine/queue.jsx",
    "engine/plugin_state.jsx",
    "engine/catalog.jsx",
    "engine/presets.jsx",
    "engine/preset_preview.jsx"
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
      // 戳之外还要校验「模块真的在」。原因：AE 会话里 AEV_EngineStamp 是全局的，
      // 一旦某次 evalFile 中途失败（比如某个模块语法错），戳已经被写进去，
      // 之后无论文件怎么改都会跳过加载 —— 表现就是
      // 「ERR:ReferenceError: AEV_Catalog 未定义」，整个效果库空白。
      // 所以这里额外检查几个关键模块是否存在，缺了就强制重载。
      "    var missing = '';" +
      "    if (typeof AEV_Catalog === 'undefined') missing = 'AEV_Catalog';" +
      "    else if (typeof AEV_Recipe === 'undefined') missing = 'AEV_Recipe';" +
      "    else if (typeof AEV_Apply === 'undefined') missing = 'AEV_Apply';" +
      "    else if (typeof AEV_Presets === 'undefined') missing = 'AEV_Presets';" +
      "    else if (typeof AEV_Curve === 'undefined') missing = 'AEV_Curve';" +
      "    if (typeof AEV_EngineStamp === 'undefined') AEV_EngineStamp = '';" +
      "    if (stamp !== AEV_EngineStamp || missing !== '') {" +
      // 逐个 evalFile 并各自捕获：某一个模块加载失败时，
      // 其余模块仍能加载（catalog 挂了不影响 recipe），
      // 而且失败原因会明确报出来，而不是被后面的模块覆盖成
      // 「AEV_Catalog 未定义」这种误导性的报错。
      "      var loadErr = '';" +
      "      for(var j=0;j<files.length;j++){" +
      "        try { $.evalFile(new File(files[j])); }" +
      "        catch(ej) { loadErr = files[j] + ':' + ej.toString();" +
      "          if (loadErr.indexOf('catalog') < 0) loadErr = ''; }" +
      "      }" +
      "      AEV_EngineStamp = stamp;" +
      "      if (loadErr !== '') return 'ERR:engine_load:' + loadErr;" +
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
    watchStamp: watchStamp,
    getDocsPath: getDocsPath,
    getExtensionPath: getExtensionPath,
    runEngine: runEngine,
    ENGINE_FILES: ENGINE_FILES,
    revealDir: revealDir,
    selfCheck: selfCheck
  };
})();
