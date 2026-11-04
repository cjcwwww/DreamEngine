/* ============================================================
 * t03_cef_probe.js —— M0 任务 T0.3
 * 回答：整网 sprite 的安全尺寸上限、大图 PNG 解码耗时、
 *       多帧轮播是否掉帧、GIF/WebP/视频编码在当前 CEF 里能不能用
 * ============================================================ */

var T03 = (function () {

  var lines = [];
  function log(s) { lines.push(s); App.emit("t03", s); }

  function stamp() { return Date.now(); }

  /* ---------- 1. WebGL 纹理上限 ---------- */
  function testWebGL() {
    log("== 1. WebGL 纹理/画布上限 ==");
    try {
      var c = document.createElement("canvas");
      var gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (!gl) { log("WEBGL|不可用（说明当前 CEF 未开硬件加速，轮播更可能掉帧）"); return; }
      log("WEBGL|maxTextureSize=" + gl.getParameter(gl.MAX_TEXTURE_SIZE) +
          "|maxCubeMap=" + gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE) +
          "|maxViewport=" + (function () {
            var v = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
            return v ? v[0] + "x" + v[1] : "?";
          })());
      var dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) log("WEBGL|renderer=" + gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
    } catch (e) {
      log("WEBGL|ERR " + e);
    }
  }

  /* ---------- 2. 2D canvas 实际可用尺寸 ---------- */
  function testCanvasSizes() {
    log("== 2. 2D Canvas 实际尺寸可用性（真正决定 sprite 能不能画出来） ==");
    var sizes = [1024, 2048, 3072, 4096, 6144, 8192];
    for (var i = 0; i < sizes.length; i++) {
      var s = sizes[i];
      var t0 = stamp();
      try {
        var c = document.createElement("canvas");
        c.width = s; c.height = s;
        var ctx = c.getContext("2d");
        if (!ctx || !c.width) { log("CANVAS|" + s + "x" + s + "|拿不到上下文"); continue; }
        ctx.fillStyle = "rgba(255,0,0,1)";
        ctx.fillRect(0, 0, s, s);
        ctx.fillRect(s - 4, s - 4, 4, 4);           // 触一下右下角，逼它真分配显存
        var px = ctx.getImageData(s - 2, s - 2, 1, 1).data;
        var ok = (px[0] === 255 && px[3] === 255);
        log("CANVAS|" + s + "x" + s + "|角点回读=" + (ok ? "正常" : "异常(0/0)") +
            "|ms=" + (stamp() - t0));
        c.width = 0; c.height = 0;
      } catch (e) {
        log("CANVAS|" + s + "x" + s + "|抛错 " + e);
      }
    }
  }

  /* ---------- 3. 图片/视频格式支持 ---------- */
  function testFormats(cb) {
    log("== 3. 动图与视频编码可用性（决定预览动画走哪条路） ==");
    var tests = [
      ["webp", "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA="],
      ["gif", "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"],
      ["png", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="],
      ["bmp", "data:image/bmp;base64,Qk02AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAABAAAAAAAAAAABAAAA"]
    ];
    var pending = tests.length;
    if (pending === 0) { cb && cb(); return; }
    tests.forEach(function (t) {
      var img = new Image();
      img.onload = function () { log("IMGDECODE|" + t[0] + "|支持(解码成功 " + img.naturalWidth + "x" + img.naturalHeight + ")"); done(); };
      img.onerror = function () { log("IMGDECODE|" + t[0] + "|不支持"); done(); };
      img.src = t[1];
      function done() { if (--pending === 0) { codecCheck(cb); } }
    });

    function codecCheck(next) {
      try {
        var v = document.createElement("video");
        ["video/ogg;codecs='theora'", 'video/mp4;codecs="avc1.42E01E"',
         'video/webm;codecs="vp8"', 'video/webm;codecs="vp9"'].forEach(function (m) {
          var r = v.canPlayType(m);
          log("VIDEOCODEC|" + m + "|" + (r === "probably" ? "很可能可用" : r === "maybe" ? "可能可用" : "不可用"));
        });
      } catch (e) { log("VIDEOCODEC|ERR " + e); }
      log("说明：APNG 是否支持无法用单帧 data URI 判定；若上面 gif/webp 都不理想，轮播帧序列是唯一稳妥路径。");
      next && next();
    }
  }

  /* ---------- 4. 真实整网图：解码耗时 + 尺寸 ---------- */
  function testBigImages(dir, cb) {
    log("== 4. 真实 sprite 大图加载（需要 T0_2 先产出 PNG） ==");
    if (!dir) { log("跳过了：未填写目录"); cb && cb([]); return; }

    Bridge.listFiles(dir, "*.png", function (res) {
      if (!res || res.indexOf("OK") !== 0) {
        log("列目录失败：" + res + "（检查路径分隔符，建议用 / ）");
        cb && cb([]); return;
      }
      var rows = res.substring(3).trim().split("\n");
      log("目录内 PNG 数量=" + rows.length);

      var loaded = [];
      var i = 0, total = Math.min(rows.length, 12);
      if (total === 0) { cb && cb([]); return; }

      (function next() {
        if (i >= total) { cb && cb(loaded); return; }
        var parts = rows[i].split("\t");
        var name = parts[0], bytes = parseInt(parts[1] || "0", 10);
        var url = "file:///" + dir.replace(/^\/+/, "") + "/" + encodeURI(name);
        var img = new Image();
        var t0 = stamp();
        img.onload = function () {
          var ms = stamp() - t0;
          var line = "BIGIMG|" + name + "|尺寸=" + img.naturalWidth + "x" + img.naturalHeight +
                     "|KB=" + Math.round(bytes / 1024) + "|解码ms=" + ms +
                     "|每MP解码ms=" + (img.naturalWidth * img.naturalHeight > 0
                        ? Math.round(ms / (img.naturalWidth * img.naturalHeight / 1e6)) : "?");
          // 像素回读在 file:// 下可能被安全策略拒绝，单独记录，不影响计时结论
          try {
            var c2 = document.createElement("canvas");
            c2.width = 64; c2.height = 64;
            var x = c2.getContext("2d");
            x.drawImage(img, 0, 0, 64, 64);
            x.getImageData(0, 0, 1, 1);
            line += "|跨源回读=允许";
          } catch (e) {
            line += "|跨源回读=拒绝(正常,不影响显示)";
          }
          log(line);
          loaded.push({ url: url, name: name, img: img });
          i++; next();
        };
        img.onerror = function () { log("BIGIMG|" + name + "|加载失败 url=" + url); i++; next(); };
        img.src = url;
      })();
    });
  }

  /* ---------- 5. 轮播掉帧实测 ---------- */
  function testCarousel(frames, cb) {
    log("== 5. 帧序列轮播（sprite 动画的真实手感） ==");
    if (!frames || frames.length < 2) { log("跳过：可用帧不足 2 张"); cb && cb(); return; }

    var host = document.createElement("img");
    host.style.cssText = "width:256px;height:256px;position:fixed;left:-9999px;top:0;";
    document.body.appendChild(host);

    var idx = 0, deltas = [], last = null, t0 = stamp();
    (function loop() {
      host.src = frames[idx % frames.length].url;
      idx++;
      var now = stamp();
      if (last !== null) deltas.push(now - last);
      last = now;
      if (now - t0 < 2500) requestAnimationFrame(loop);
      else {
        document.body.removeChild(host);
        deltas.sort(function (a, b) { return a - b; });
        var sum = 0; for (var i = 0; i < deltas.length; i++) sum += deltas[i];
        var avg = deltas.length ? sum / deltas.length : 0;
        var dropped = 0;
        for (var j = 0; j < deltas.length; j++) if (deltas[j] > 25) dropped++;
        log("CAROUSEL|帧数=" + deltas.length +
            "|平均间隔ms=" + Math.round(avg * 10) / 10 +
            "|估算fps=" + (avg > 0 ? Math.round(1000 / avg * 10) / 10 : "?") +
            "|最差间隔ms=" + (deltas.length ? deltas[deltas.length - 1] : "?") +
            "|超过25ms的次数=" + dropped +
            "|样本张数=" + frames.length);
        log("CAROUSEL|口径说明：本项为 rAF 间隔统计，非 AE 渲染性能；结论只用于定「一屏同时轮播几格」。");
        cb && cb();
      }
    })();
  }

  /* ---------- 入口 ---------- */
  function run(dir, wantCarousel, done) {
    lines = [];
    App.emit("t03", "T0.3 开始 · " + new Date().toString());
    Bridge.selfCheck(function (info) {
      log("ENV|CEP=" + info.cep + "|AE=" + info.aeVersion +
          "|写权限=" + info.writePref + "|文档目录=" + info.docs);
      testWebGL();
      testCanvasSizes();
      testFormats(function () {
        testBigImages(dir, function (frames) {
          if (wantCarousel) testCarousel(frames, finish);
          else finish();

          function finish() {
            var text = "PROBE=T0_3_CEF\nAE_VERSION=" + info.aeVersion + "\n" + lines.join("\r\n");
            App.registerText("T0_3_CEF探针.txt", text);
            log("—— 已缓存，点「输出」页签可写盘 ——");
            done && done();
          }
        });
      });
    });
  }

  return { run: run };
})();
