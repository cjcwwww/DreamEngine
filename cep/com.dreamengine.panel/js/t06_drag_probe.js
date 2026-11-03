/* ============================================================
 * t06_drag_probe.js —— M0 任务 T0.6 的拖拽半项
 * 唯一目的：验证 CEP 里 dataTransfer.files[i].path 能不能拿到真实绝对路径。
 * 结论直接决定 M3 预设库要不要做拖拽入口（拿不到就只留两个文件对话框入口）。
 * ============================================================ */

var T06 = (function () {

  var records = [];
  var zone = null;

  function log(s) { records.push(s); App.emit("t06", s); }

  function init(zoneEl) {
    zone = zoneEl;
    if (!zone) return;

    ["dragenter", "dragover"].forEach(function (ev) {
      zone.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        zone.className = "dropzone over";
      });
    });
    ["dragleave", "dragend"].forEach(function (ev) {
      zone.addEventListener(ev, function (e) {
        e.preventDefault(); zone.className = "dropzone";
      });
    });

    zone.addEventListener("drop", function (e) {
      e.preventDefault(); e.stopPropagation();
      zone.className = "dropzone";
      handleDrop(e);
    });
  }

  function handleDrop(e) {
    log("== 拖入事件 · " + new Date().toLocaleTimeString() + " ==");
    var dt = e.dataTransfer;
    if (!dt) { log("没有 dataTransfer"); return; }

    var files = dt.files;
    log("files.length=" + (files ? files.length : "无"));
    if (!files || files.length === 0) {
      log("结果为空：可能拖入的是桌面项/压缩包，CEF 未给出 files");
      return;
    }

    var pathOK = 0, pathBad = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var p = f.path;                 // ← CEF 扩展属性，标准 Web 没有
      var hasPath = !!(p && p.length > 1);
      if (hasPath) pathOK++; else pathBad++;

      log("ITEM_" + i +
          "|name=" + f.name +
          "|size=" + f.size +
          "|type=" + (f.type || "(空)") +
          "|path=" + (hasPath ? p : "【拿不到】") +
          "|lastModified=" + (f.lastModifiedDate ? f.lastModifiedDate.toString() : "?"));

      // size 为 0 且 type 为空，通常是文件夹
      if (f.size === 0 && !f.type) log("  ↳ 疑似文件夹条目，需确认 CEF 是否真的给了目录条目");
    }

    log("VERDICT|可取路径=" + pathOK + "|不可取=" + pathBad +
        " → " + (pathBad === 0 && pathOK > 0
          ? "拖拽入口可用，M3 保留拖拽"
          : (pathOK === 0 ? "拖拽拿不到真实路径，M3 降级为「选文件/选文件夹」两入口"
                          : "部分可取，需按 AE 版本区分处理")));

    log("提示：若拖的是单个 .ffx 且 size>0 但 path 拿不到，就是 CEF 屏蔽了该属性，" +
        "这条结论对 M3 影响最大，务必记下来。");
  }

  function flushText() {
    return "PROBE=T0_6b_拖拽\r\n" + records.join("\r\n");
  }

  return { init: init, flushText: flushText, log: log };
})();
