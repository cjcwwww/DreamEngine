/* ============================================================
 * main.js —— 壳的装配层：页签、自检、按钮、输出落盘
 * ============================================================ */

var App = (function () {

  var pendingWrites = {};      // 文件名 -> 内容
  var docsPath = "";           // 「我的文档」绝对路径（由 AE 侧给出）
  var probeDirName = "DreamEngineProbe";

  /* ---------- 输出通道 ---------- */
  function emit(section, text) {
    var el = document.getElementById(section === "t06" ? "t06Log" : "t03Log");
    if (el) {
      el.textContent += (el.textContent ? "\n" : "") + text;
      el.scrollTop = el.scrollHeight;
    }
    var out = document.getElementById("outBox");
    if (out) {
      if (out.textContent === "（空）") out.textContent = "";
      out.textContent += "[" + section + "] " + text + "\n";
      out.scrollTop = out.scrollHeight;
    }
  }

  function registerText(fileName, text) {
    pendingWrites[fileName] = text;
  }

  /* ---------- 页签 ---------- */
  function initTabs() {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        var name = this.getAttribute("data-tab");
        var all = document.querySelectorAll(".tab");
        for (var k = 0; k < all.length; k++) all[k].className = "tab";
        this.className = "tab active";
        var panes = document.querySelectorAll(".pane");
        for (var j = 0; j < panes.length; j++) panes[j].className = "pane";
        var target = document.getElementById("pane-" + name);
        if (target) target.className = "pane active";
      });
    }
  }

  /* ---------- 环境自检 ---------- */
  function setDot(id, cls, extra) {
    var li = document.getElementById(id);
    if (!li) return;
    var dot = li.querySelector(".dot");
    if (dot) dot.className = "dot " + cls;
    if (extra) {
      var span = li.querySelector("em");
      if (!span) { span = document.createElement("em"); span.style.cssText = "color:#9aa;font-style:normal;margin-left:8px"; li.appendChild(span); }
      span.textContent = extra;
    }
  }

  function runSelfCheck() {
    var conn = document.getElementById("connState");
    var logEl = document.getElementById("envLog");
    logEl.textContent = "";
    ["envCep", "envAe", "envWrite"].forEach(function (id) { setDot(id, ""); });

    Bridge.selfCheck(function (info) {
      if (!info.cep) {
        setDot("envCep", "bad", "不在 CEP 内（可用浏览器打开只能测前两项，结论不算数）");
        conn.textContent = "非 CEP 环境";
        conn.className = "conn bad";
        logEl.textContent = "当前 window.__adobe_cep__ 不存在，无法调用 AE。";
        return;
      }
      setDot("envCep", "ok", "CEP 通道正常");

      if (info.aeVersion && info.aeVersion.indexOf("ERR") !== 0) {
        setDot("envAe", "ok", "AE " + info.aeVersion);
        conn.textContent = "已连接 AE " + info.aeVersion;
        conn.className = "conn ok";
      } else {
        setDot("envAe", "bad", "jsx 执行失败：" + info.aeVersion);
        conn.textContent = "AE 连接失败";
        conn.className = "conn bad";
      }

      if (String(info.writePref) === "true") setDot("envWrite", "ok", "已勾选");
      else if (String(info.writePref) === "false")
        setDot("envWrite", "bad", "未勾选！首选项 > 脚本和表达式 > 允许脚本写入文件和访问网络");
      else setDot("envWrite", "warn", "无法确认（" + info.writePref + "），写盘前先试");

      docsPath = info.docs || "";
      logEl.textContent =
        "AE 版本：" + info.aeVersion + "\n" +
        "写文件权限：" + info.writePref + "\n" +
        "文档目录：" + docsPath + "\n" +
        "探针输出目录：" + (docsPath ? docsPath + "/" + probeDirName : "未知");

      registerText("T0_3_env.txt", "AE_VERSION=" + info.aeVersion +
                   "\r\nWRITE_PREF=" + info.writePref + "\r\nDOCS=" + docsPath);
    });
  }

  /* ---------- 写盘 ---------- */
  function saveAll() {
    var out = document.getElementById("outBox");
    if (!docsPath) {
      alert("还没拿到文档目录，先在「环境自检」页签跑一次自检。");
      return;
    }
    var names = Object.keys(pendingWrites);
    if (names.length === 0) {
      alert("没有待写内容。先跑探针。");
      return;
    }
    var i = 0, ok = 0, bad = 0;
    (function next() {
      if (i >= names.length) {
        // 追加一行到汇总日志，保持与 AE 侧探针相同的约定
        var summary = names.map(function (n) { return n; }).join(", ");
        Bridge.writeFile(docsPath + "/" + probeDirName + "/探针日志.txt",
          "CEP壳探针输出：" + summary, function () {
            out.textContent += "\n[write] 完成：成功 " + ok + " 个，失败 " + bad + " 个\n";
            alert("已写入 DreamEngineProbe 目录：\n" + names.join("\n") +
                  "\n\n请把整个 DreamEngineProbe 文件夹打包回传。");
          });
        return;
      }
      var n = names[i];
      var path = docsPath + "/" + probeDirName + "/" + n;
      Bridge.writeFile(path, pendingWrites[n], function (res) {
        out.textContent += "[write] " + n + " → " + res + "\n";
        if (String(res).indexOf("OK") === 0) ok++; else bad++;
        i++; next();
      });
    })();
  }

  /* ---------- 运行 AE 侧探针 ----------
   * 路径为配置常量：面板经目录联接部署，无法从面板自身位置推导仓库路径。
   * 换机器或换仓库位置时只改这一处。正斜杠，ExtendScript 可直接识别。 */
  var REPO_PROBES = "D:/workqwen/DreamEngine-1/probes/";

  function runLog(text) {
    var el = document.getElementById("runLog");
    if (!el) return;
    el.textContent += (el.textContent ? "\n" : "") + text;
    el.scrollTop = el.scrollHeight;
    var out = document.getElementById("outBox");
    if (out) {
      if (out.textContent === "（空）") out.textContent = "";
      out.textContent += "[run] " + text + "\n";
    }
  }

  function runProbe(fileName, btnId) {
    var btn = document.getElementById(btnId);
    if (btn) btn.disabled = true;
    runLog("▶ 开始执行 " + fileName + "（AE 主线程会阻塞，结束会弹提示框）");
    // 用 $.evalFile 执行仓库里的探针，等价于「文件>脚本>运行脚本文件」
    var jsx = "(function(){try{var f=new File(" +
      JSON.stringify(REPO_PROBES + fileName) +
      ");if(!f.exists)return 'NO_FILE:'+f.fsName;" +
      "$.evalFile(f);return 'DONE:'+f.fsName;}" +
      "catch(e){return 'ERR:'+e.toString();}})()";
    Bridge.evalAE(jsx, function (res) {
      runLog("◀ " + fileName + " → " + res);
      if (btn) btn.disabled = false;
    });
  }

  /* ---------- 装配 ---------- */
  function boot() {
    initTabs();
    T06.init(document.getElementById("dropzone"));

    on("btnEnv", "click", runSelfCheck);
    on("btnDocs", "click", function () {
      if (!docsPath) { alert("先跑自检"); return; }
      Bridge.revealDir(docsPath + "/" + probeDirName, function (r) {
        emit("env", "打开目录：" + r);
      });
    });
    on("btnT03", "click", function () {
      var btn = document.getElementById("btnT03");
      var st = document.getElementById("t03Status");
      btn.disabled = true; st.textContent = "运行中…（轮播项约 3 秒）";
      var dir = document.getElementById("imgDir").value.trim().replace(/\\/g, "/");
      var wantCar = document.getElementById("optCarousel").checked;
      T03.run(dir, wantCar, function () {
        btn.disabled = false;
        st.textContent = "完成，结果已缓存到「输出」页签";
      });
    });
    on("btnT06Write", "click", function () {
      registerText("T0_6b_拖拽.txt", T06.flushText());
      emit("t06", "已缓存拖拽记录，点「输出」页签的「全部写入文件」落盘。");
    });
    on("btnRunT01", "click", function () { runProbe("T0_1_效果枚举探针.jsx", "btnRunT01"); });
    on("btnRunT05", "click", function () { runProbe("T0_5_参数读取探针.jsx", "btnRunT05"); });
    on("btnRunT02", "click", function () { runProbe("T0_2_渲染耗时探针.jsx", "btnRunT02"); });
    on("btnRunT02Prep", "click", function () { runProbe("T0_2_prepare_aerender.jsx", "btnRunT02Prep"); });
    on("btnRunT04", "click", function () { runProbe("T0_4_预设应用探针.jsx", "btnRunT04"); });
    on("btnRunT06", "click", function () { runProbe("T0_6_导入入口探针.jsx", "btnRunT06"); });
    on("btnRunT08", "click", function () { runProbe("T0_8_全量dump探针.jsx", "btnRunT08"); });
    on("btnSaveAll", "click", saveAll);
    on("btnClear", "click", function () {
      document.getElementById("outBox").textContent = "（空）";
      pendingWrites = {};
    });

    runSelfCheck();
  }

  function on(id, evt, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
