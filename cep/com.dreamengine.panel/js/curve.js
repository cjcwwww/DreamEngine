/* ============================================================
 * curve.js —— M4 曲线编辑视图
 *
 * 分层（设计文档 §2）：
 *   · 纯数学：engine/curve_math.js（与 AE 侧共用同一份，唯一实现）
 *   · AE 读写：engine/curvelib.jsx（快照 / 写回 / 并发指纹），本文件只发文本协议
 *   · 本文件：画布、命中测试、拖拽、预设、冲突处理
 *
 * 为什么面板要自己算曲线：拖拽要逐帧重绘，不可能每动一下鼠标就过一次
 * evalScript（一次往返 10~50ms，体验直接崩）。所以参数一落盘就本地重算，
 * 松手才写回 AE，写回后再读一次快照与 AE 对齐 —— 不假设 AE 接受了我们的值。
 *
 * 语法：ES5（跑在 CEF 里，不用 ES6 是沿用项目既有约定）。
 * ============================================================ */

var AEV_CurveUI = (function () {
  /* 与 engine/curvelib.jsx 的 PRESETS 一一对应（tools/test-curve.mjs 会校验 id） */
  var PRESETS = [
    { id: "linear", zh: "线性", en: "Linear" },
    { id: "ease", zh: "缓动", en: "Easy Ease" },
    { id: "ease-in", zh: "缓入", en: "Ease In" },
    { id: "ease-out", zh: "缓出", en: "Ease Out" },
    { id: "strong", zh: "强缓动", en: "Strong Ease" },
    { id: "strong-in", zh: "强缓入", en: "Strong In" },
    { id: "strong-out", zh: "强缓出", en: "Strong Out" },
    { id: "hold", zh: "定格", en: "Hold" }
  ];

  var deps = { engine: null, parse: null, status: null, lang: null };
  var el = {};
  var M = null;

  var st = {
    props: [],
    active: -1,
    dim: 0,
    mode: "value",
    selected: {},
    drag: null,
    backup: null,
    pendingText: "",
    afterRead: "",
    comp: "",
    time: 0,
    hoverHandle: null,
    message: "",
    loaded: false,
    busy: false
  };

  function t(zh, en) {
    return deps.lang && deps.lang() === "en" ? en : zh;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function active() {
    return st.active >= 0 && st.active < st.props.length ? st.props[st.active] : null;
  }

  function activeKeys() {
    var p = active();
    return p ? p.keys : [];
  }

  function dims() {
    var p = active();
    return p ? Math.max(1, p.dims) : 1;
  }

  function isPathCapable() {
    var p = active();
    return !!(p && p.spatial && p.dims >= 2);
  }

  function fmt(value, span) {
    var n = Number(value);
    if (!isFinite(n)) return "0";
    var abs = Math.abs(n);
    if (span > 500) return n.toFixed(0);
    if (span > 50) return n.toFixed(1);
    if (span > 5) return n.toFixed(2);
    if (abs > 0 && abs < 0.01) return n.toExponential(1);
    return n.toFixed(3);
  }

  /* ============================================================
   * 一、载入：把 AE 侧的选中快照拉过来
   * ============================================================ */

  function engine(expr, cb) {
    if (!deps.engine) {
      setMessage(t("面板未就绪", "Panel not ready"), true);
      return;
    }
    deps.engine(expr, cb);
  }

  function setMessage(text, isError) {
    st.message = text;
    if (el.hint) {
      el.hint.textContent = text;
      el.hint.className = "curve-hint" + (isError ? " error" : "");
    }
    if (isError && deps.status) deps.status(text, true);
  }

  function read(preserve) {
    if (st.busy) return;
    st.busy = true;
    el.read.disabled = true;

    var keepLoc = preserve && active() ? active().loc : "";
    var prevLoc = active() ? active().loc : "";

    engine("AEV_Curve.snapshotJson()", function (text) {
      st.busy = false;
      el.read.disabled = false;

      var data = deps.parse ? deps.parse(text) : null;
      if (!data || data.status !== "ok") {
        var reason = (data && data.reason) || String(text).slice(0, 120);
        st.props = [];
        st.active = -1;
        st.selected = {};
        st.loaded = true;
        renderAll();
        setMessage(
          reason === "no_comp"
            ? t("AE 里没有打开的合成", "No composition open in AE")
            : t("读取失败：" + reason, "Read failed: " + reason),
          true
        );
        return;
      }

      st.comp = data.comp || "";
      st.time = Number(data.time) || 0;
      st.props = data.props || [];
      st.loaded = true;

      // 属性列表变了（换了选中对象）→ 重新定位当前属性
      var nextIndex = -1;
      if (keepLoc) {
        for (var i = 0; i < st.props.length; i++) {
          if (st.props[i].loc === keepLoc) { nextIndex = i; break; }
        }
      }
      if (nextIndex < 0 && st.props.length) nextIndex = 0;

      // 换了属性就清空关键帧选择：旧序号对新属性没有意义
      if (!st.props.length || st.props[nextIndex].loc !== prevLoc) st.selected = {};
      st.active = nextIndex;

      if (!st.props.length) {
        renderAll();
        setMessage(t(
          "AE 里没有可编辑的动画属性：先选中属性，或选中一个带关键帧的图层",
          "No animated property: select one, or select a layer with keyframes"
        ), false);
        return;
      }

      if (st.dim >= dims()) st.dim = 0;
      if (st.mode === "path" && !isPathCapable()) st.mode = "value";

      renderAll();
      // 写回后的提示优先：read 会把「已写入 N 处」覆盖成「已读取 N 个属性」
      var message = st.afterRead;
      st.afterRead = "";
      setMessage(message || t("已读取 " + st.props.length + " 个属性（合成 " + st.comp + "）",
        "Loaded " + st.props.length + " properties from " + st.comp), false);
    });
  }

  /* ============================================================
   * 二、视图映射
   * ============================================================ */

  function setupCanvas() {
    var canvas = el.canvas;
    if (!canvas) return null;
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    if (w < 20 || h < 20) return null;
    var dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function plotRect(w, h) {
    return { x: 46, y: 14, w: Math.max(20, w - 62), h: Math.max(20, h - 42) };
  }

  /** 值图 / 速度图的时间与纵轴范围 */
  function computeRange() {
    var keys = activeKeys();
    var p = active();
    var d = st.dim;
    var t0 = keys.length ? keys[0].t : 0;
    var t1 = keys.length ? keys[keys.length - 1].t : 1;
    if (t1 - t0 < 1e-6) { t0 -= 0.5; t1 += 0.5; }

    var lo = Infinity;
    var hi = -Infinity;
    var i, s, v, seg;

    if (st.mode === "path") {
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (i = 0; i + 1 < keys.length; i++) {
        seg = M.segmentOf(keys, i);
        if (!seg) continue;
        for (var u = 0; u <= 40; u++) {
          var pt = M.pathPoint(seg, u / 40);
          minX = Math.min(minX, pt[0]); maxX = Math.max(maxX, pt[0]);
          minY = Math.min(minY, pt[1]); maxY = Math.max(maxY, pt[1]);
        }
        // 切线把手也要能画出来
        var tOutX = Number(keys[i].v[0] || 0) + Number(keys[i].ot[0] || 0);
        var tOutY = Number(keys[i].v[1] || 0) + Number(keys[i].ot[1] || 0);
        minX = Math.min(minX, tOutX); maxX = Math.max(maxX, tOutX);
        minY = Math.min(minY, tOutY); maxY = Math.max(maxY, tOutY);
      }
      var kn = keys[keys.length - 1];
      if (kn) {
        var tInX = Number(kn.v[0] || 0) + Number(kn.it[0] || 0);
        var tInY = Number(kn.v[1] || 0) + Number(kn.it[1] || 0);
        minX = Math.min(minX, tInX); maxX = Math.max(maxX, tInX);
        minY = Math.min(minY, tInY); maxY = Math.max(maxY, tInY);
      }
      if (!isFinite(minX)) { minX = 0; maxX = 1; minY = 0; maxY = 1; }
      if (maxX - minX < 1e-6) { maxX = minX + 1; }
      if (maxY - minY < 1e-6) { maxY = minY + 1; }
      return {
        t0: minX - (maxX - minX) * 0.08,
        t1: maxX + (maxX - minX) * 0.08,
        lo: minY - (maxY - minY) * 0.08,
        hi: maxY + (maxY - minY) * 0.08
      };
    } else if (st.mode === "speed") {
      for (i = 0; i + 1 < keys.length; i++) {
        seg = M.segmentOf(keys, i);
        if (!seg) continue;
        for (var q = 0; q <= 40; q++) {
          v = M.speedAt(seg, d, seg.tA + (seg.dt * q) / 40);
          if (!isFinite(v)) continue;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    } else {
      for (i = 0; i < keys.length; i++) {
        v = Number(keys[i].v[d] || 0);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      for (i = 0; i + 1 < keys.length; i++) {
        seg = M.segmentOf(keys, i);
        if (!seg) continue;
        var hnd = M.handles(seg, d);
        lo = Math.min(lo, hnd.p1.y, hnd.p2.y);
        hi = Math.max(hi, hnd.p1.y, hnd.p2.y);
      }
    }

    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-6) { hi = lo + 1; }
    var pad = (hi - lo) * 0.12;
    return { t0: t0, t1: t1, lo: lo - pad, hi: hi + pad };
  }

  function makeMap(rect, range) {
    return {
      rect: rect,
      range: range,
      X: function (time) {
        return rect.x + ((time - range.t0) / (range.t1 - range.t0)) * rect.w;
      },
      T: function (px) {
        return range.t0 + ((px - rect.x) / rect.w) * (range.t1 - range.t0);
      },
      Y: function (value) {
        return rect.y + (1 - (value - range.lo) / (range.hi - range.lo)) * rect.h;
      },
      V: function (py) {
        return range.lo + (1 - (py - rect.y) / rect.h) * (range.hi - range.lo);
      }
    };
  }

  /** 让 X/Y 的「每像素单位数」一致，否则路径形状会被拉扁 */
  function equalizeAspect(rect, range) {
    var cx = (range.t0 + range.t1) / 2;
    var cy = (range.lo + range.hi) / 2;
    var spanX = Math.max(1e-6, range.t1 - range.t0);
    var spanY = Math.max(1e-6, range.hi - range.lo);
    var perPixel = Math.min(spanX / rect.w, spanY / rect.h);
    var halfX = (rect.w * perPixel) / 2;
    var halfY = (rect.h * perPixel) / 2;
    return { t0: cx - halfX, t1: cx + halfX, lo: cy - halfY, hi: cy + halfY };
  }

  /* ============================================================
   * 三、绘制
   * ============================================================ */

  function draw() {
    var setup = setupCanvas();
    if (!setup) return;
    var ctx = setup.ctx;
    var w = setup.w;
    var h = setup.h;

    ctx.clearRect(0, 0, w, h);

    var p = active();
    if (!p) {
      drawEmpty(ctx, w, h);
      return;
    }

    var keys = p.keys;
    if (!keys || keys.length < 2) {
      drawEmpty(ctx, w, h, t("这个属性只有一个关键帧，没有可编辑的曲线",
        "Only one keyframe — no curve to edit"));
      return;
    }

    var rect = plotRect(w, h);
    var range = computeRange();
    // 路径图必须等比：X/Y 用不同的「每像素代表多少单位」，画出来的
    // 弯曲方向就是假的（这一点在空间切线编辑里是硬伤）。
    if (st.mode === "path") range = equalizeAspect(rect, range);
    st.map = makeMap(rect, range);

    drawGrid(ctx, rect, range, p);
    if (st.mode === "path") drawPath(ctx, keys);
    else drawCurve(ctx, keys);
    drawKeys(ctx, keys);
    drawHandles(ctx, keys);
    drawPlayhead(ctx, rect, range);
  }

  function drawEmpty(ctx, w, h, text) {
    ctx.fillStyle = "rgba(255,255,255,0.02)";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#90989f";
    ctx.font = "12px 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      text || t("先在 AE 里选中属性或图层，再点「读取选中」",
        "Select a property or layer in AE, then click Read"),
      w / 2,
      h / 2
    );
    ctx.textAlign = "left";
  }

  function drawGrid(ctx, rect, range, p) {
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.font = "10px 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
    ctx.fillStyle = "#71797f";

    var i, x, y, value;
    for (i = 0; i <= 4; i++) {
      x = rect.x + (rect.w * i) / 4;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, rect.y);
      ctx.lineTo(Math.round(x) + 0.5, rect.y + rect.h);
      ctx.stroke();

      var time = range.t0 + ((range.t1 - range.t0) * i) / 4;
      ctx.textAlign = "center";
      ctx.fillText(st.mode === "path" ? fmt(time, range.t1 - range.t0) : time.toFixed(2) + "s",
        x, rect.y + rect.h + 14);
    }

    for (i = 0; i <= 4; i++) {
      y = rect.y + (rect.h * i) / 4;
      ctx.beginPath();
      ctx.moveTo(rect.x, Math.round(y) + 0.5);
      ctx.lineTo(rect.x + rect.w, Math.round(y) + 0.5);
      ctx.stroke();

      value = range.hi - ((range.hi - range.lo) * i) / 4;
      ctx.textAlign = "right";
      var label = st.mode === "speed"
        ? fmt(value, range.hi - range.lo) + "/s"
        : fmt(value, range.hi - range.lo);
      ctx.fillText(label, rect.x - 6, y + 3);
    }
    ctx.textAlign = "left";

    // 图表类型提示（面板很窄，靠左上角一行小字说明当前坐标含义）
    ctx.fillStyle = "#5d666c";
    var modeLabel = st.mode === "speed"
      ? t("速度（值/秒）", "Speed (units/s)")
      : (st.mode === "path" ? t("路径（顶视图 X/Y）", "Path (top view X/Y)") : t("值", "Value"));
    ctx.fillText(modeLabel + " · " + dimLabel(p, st.dim), rect.x + 2, rect.y - 4);
  }

  function dimLabel(p, d) {
    if (!p || p.dims <= 1) return t("标量", "scalar");
    var names = ["X", "Y", "Z", "W"];
    return "dim " + (names[d] || String(d + 1));
  }

  function drawCurve(ctx, keys) {
    var map = st.map;
    var d = st.dim;
    ctx.strokeStyle = "#7fa6aa";
    ctx.lineWidth = 1.6;
    ctx.beginPath();

    var started = false;
    for (var i = 0; i + 1 < keys.length; i++) {
      var seg = M.segmentOf(keys, i);
      if (!seg) continue;
      var steps = Math.max(8, Math.min(120, Math.round(map.rect.w / 3)));
      for (var s = 0; s <= steps; s++) {
        var time = seg.tA + (seg.dt * s) / steps;
        var value = M.sampleValue(seg, d, time);
        var px = map.X(time);
        var py = map.Y(value);
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }

  function drawPath(ctx, keys) {
    var map = st.map;
    ctx.strokeStyle = "#7fa6aa";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    var started = false;
    for (var i = 0; i + 1 < keys.length; i++) {
      var seg = M.segmentOf(keys, i);
      if (!seg) continue;
      for (var s = 0; s <= 48; s++) {
        var pt = M.pathPoint(seg, s / 48);
        var px = map.X(pt[0]);
        var py = map.Y(pt[1]);
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }

  function drawKeys(ctx, keys) {
    var map = st.map;
    var d = st.dim;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var px, py;
      if (st.mode === "path") {
        px = map.X(Number(key.v[0] || 0));
        py = map.Y(Number(key.v[1] || 0));
      } else if (st.mode === "speed") {
        px = map.X(key.t);
        py = map.Y(speedAtKey(i, d));
      } else {
        px = map.X(key.t);
        py = map.Y(Number(key.v[d] || 0));
      }

      var selected = !!st.selected[i];
      ctx.beginPath();
      ctx.rect(px - 4, py - 4, 8, 8);
      if (selected) {
        ctx.fillStyle = "#cfe3e5";
        ctx.fill();
      } else {
        ctx.fillStyle = "#16191c";
        ctx.fill();
      }
      ctx.strokeStyle = selected ? "#cfe3e5" : "#7fa6aa";
      ctx.lineWidth = 1.4;
      ctx.stroke();

      // roving 键：时间由 AE 排布，画成空心菱形提醒不可拖时间
      if (key.rv) {
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.strokeStyle = "#a36d65";
        ctx.stroke();
      }
    }
  }

  /** 关键帧处的速度（速度图上用来摆关键帧标记） */
  function speedAtKey(index, d) {
    var keys = activeKeys();
    var seg;
    if (index + 1 < keys.length) {
      seg = M.segmentOf(keys, index);
      if (seg) return M.speedAt(seg, d, seg.tA + 1e-6);
    }
    if (index > 0) {
      seg = M.segmentOf(keys, index - 1);
      if (seg) return M.speedAt(seg, d, seg.tB - 1e-6);
    }
    return 0;
  }

  /** 当前关键帧的把手位置（值图 / 速度图 / 路径图各不相同） */
  function handlePoints(keyIndex, side, d) {
    var keys = activeKeys();
    var map = st.map;
    if (!map) return null;
    var prop = active();
    /* 空间属性在「值」图里不给把手：曲线形状由空间切线决定，值图上的
       把手画不进那条弯线里，拖了也对不上。缓动请到速度图或路径图改。 */
    if (prop && prop.spatial && st.mode === "value") return null;
    var segIndex = side === "out" ? keyIndex : keyIndex - 1;
    var seg = segIndex >= 0 ? M.segmentOf(keys, segIndex) : null;
    if (!seg) return null;

    if (st.mode === "path") {
      if (side === "out") {
        return {
          x: map.X(Number(keys[keyIndex].v[0] || 0) + Number(keys[keyIndex].ot[0] || 0)),
          y: map.Y(Number(keys[keyIndex].v[1] || 0) + Number(keys[keyIndex].ot[1] || 0)),
          base: { x: map.X(keys[keyIndex].v[0]), y: map.Y(keys[keyIndex].v[1]) }
        };
      }
      return {
        x: map.X(Number(keys[keyIndex].v[0] || 0) + Number(keys[keyIndex].it[0] || 0)),
        y: map.Y(Number(keys[keyIndex].v[1] || 0) + Number(keys[keyIndex].it[1] || 0)),
        base: { x: map.X(keys[keyIndex].v[0]), y: map.Y(keys[keyIndex].v[1]) }
      };
    }

    if (st.mode === "speed") {
      // 速度图：横轴仍是时间，纵轴是该侧的速度
      var speed = side === "out"
        ? Number(M.at(keys[keyIndex].os, d, 0))
        : Number(M.at(keys[keyIndex].is, d, 0));
      var inf = side === "out"
        ? Number(M.at(keys[keyIndex].oi, d, 33.33))
        : Number(M.at(keys[keyIndex].ii, d, 33.33));
      var t = side === "out"
        ? seg.tA + (seg.dt * inf) / 100
        : seg.tB - (seg.dt * inf) / 100;
      return {
        x: map.X(t),
        y: map.Y(speed),
        base: { x: map.X(side === "out" ? seg.tA : seg.tB), y: map.Y(speed) }
      };
    }

    var hnd = M.handles(seg, d);
    if (side === "out") {
      return { x: map.X(hnd.p1.x), y: map.Y(hnd.p1.y), base: { x: map.X(hnd.p0.x), y: map.Y(hnd.p0.y) } };
    }
    return { x: map.X(hnd.p2.x), y: map.Y(hnd.p2.y), base: { x: map.X(hnd.p3.x), y: map.Y(hnd.p3.y) } };
  }

  function drawHandles(ctx, keys) {
    var activeKey = firstSelected();
    if (activeKey < 0) return;
    var d = st.dim;

    var sides = ["in", "out"];
    for (var s = 0; s < sides.length; s++) {
      var side = sides[s];
      var hp = handlePoints(activeKey, side, d);
      if (!hp) continue;
      var hot = st.hoverHandle && st.hoverHandle.key === activeKey && st.hoverHandle.side === side;

      ctx.beginPath();
      ctx.moveTo(hp.base.x, hp.base.y);
      ctx.lineTo(hp.x, hp.y);
      ctx.strokeStyle = "rgba(127,166,170,0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(hp.x, hp.y, hot ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = hot ? "#dff0f2" : "#7fa6aa";
      ctx.fill();
      ctx.strokeStyle = "#0f1113";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function drawPlayhead(ctx, rect, range) {
    // 路径图的横轴是空间 X，不是时间，画时间游标没有意义
    if (st.mode === "path") return;
    if (!st.time) return;
    if (st.time < range.t0 || st.time > range.t1) return;
    var x = rect.x + ((st.time - range.t0) / (range.t1 - range.t0)) * rect.w;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "rgba(163,109,101,0.8)";
    ctx.beginPath();
    ctx.moveTo(x, rect.y);
    ctx.lineTo(x, rect.y + rect.h);
    ctx.stroke();
    ctx.restore();
  }

  function firstSelected() {
    for (var k in st.selected) {
      if (st.selected.hasOwnProperty(k)) return Number(k);
    }
    return -1;
  }

  /* ============================================================
   * 四、命中测试与拖拽
   * ============================================================ */

  function localPoint(event) {
    var rect = el.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function keyAt(px, py) {
    var keys = activeKeys();
    var map = st.map;
    if (!map) return -1;
    var d = st.dim;
    for (var i = 0; i < keys.length; i++) {
      var kx, ky;
      if (st.mode === "path") {
        kx = map.X(Number(keys[i].v[0] || 0));
        ky = map.Y(Number(keys[i].v[1] || 0));
      } else if (st.mode === "speed") {
        kx = map.X(keys[i].t);
        ky = map.Y(speedAtKey(i, d));
      } else {
        kx = map.X(keys[i].t);
        ky = map.Y(Number(keys[i].v[d] || 0));
      }
      if (Math.abs(px - kx) <= 7 && Math.abs(py - ky) <= 7) return i;
    }
    return -1;
  }

  function handleAt(px, py) {
    var activeKey = firstSelected();
    if (activeKey < 0) return null;
    var sides = ["out", "in"];
    for (var i = 0; i < sides.length; i++) {
      var hp = handlePoints(activeKey, sides[i], st.dim);
      if (!hp) continue;
      var dx = px - hp.x;
      var dy = py - hp.y;
      if (dx * dx + dy * dy <= 64) {
        return { key: activeKey, side: sides[i] };
      }
    }
    return null;
  }

  function onMouseDown(event) {
    if (event.button !== 0) return;
    var pt = localPoint(event);
    var hitKey = keyAt(pt.x, pt.y);

    if (hitKey >= 0) {
      var additive = event.shiftKey;
      if (!additive) st.selected = {};
      st.selected[hitKey] = additive ? !st.selected[hitKey] : true;
      if (!st.selected[hitKey]) delete st.selected[hitKey];
      st.hoverHandle = null;
      draw();
      updateHint();
      return;
    }

    var hitHandle = handleAt(pt.x, pt.y);
    if (hitHandle) {
      st.backup = JSON.stringify(activeKeys());
      var segIndex0 = hitHandle.side === "out" ? hitHandle.key : hitHandle.key - 1;
      var seg0 = segIndex0 >= 0 ? M.segmentOf(activeKeys(), segIndex0) : null;
      st.drag = {
        key: hitHandle.key,
        side: hitHandle.side,
        dim: st.dim,
        shift: event.shiftKey,
        // 拖拽前的斜率：Shift 拖动时保持它不变（只改缓动幅度）
        m0: seg0 ? (hitHandle.side === "out" ? seg0.mOut : seg0.mIn) : 0
      };
      event.preventDefault();
      updateHint();
      return;
    }

    // 空白处：只清选择，不动曲线
    st.selected = {};
    st.hoverHandle = null;
    draw();
    updateHint();
  }

  function onMouseMove(event) {
    // 视图不可见时不处理：canvas 尺寸为 0，坐标换算全是垃圾值
    var view = byId("viewCurve");
    if (view && view.hidden) return;

    var pt = localPoint(event);

    if (st.drag) {
      applyDrag(pt);
      return;
    }

    var hit = handleAt(pt.x, pt.y);
    var changed = false;
    if (hit && (!st.hoverHandle || st.hoverHandle.side !== hit.side || st.hoverHandle.key !== hit.key)) {
      st.hoverHandle = hit;
      changed = true;
    } else if (!hit && st.hoverHandle) {
      st.hoverHandle = null;
      changed = true;
    }
    if (changed) draw();
    el.canvas.style.cursor = hit ? "grab" : (keyAt(pt.x, pt.y) >= 0 ? "pointer" : "default");
  }

  /**
   * 拖拽中：把像素坐标换成 (influence, m)，只更新本地模型并重绘。
   *
   * Shift = 只改水平（influence），不动速度 —— AE 里的常用手法。
   * 时间轴方向钳在区间内：把手超出区间会让 x(u) 不单调，曲线会回折。
   */
  function applyDrag(pt) {
    var keys = activeKeys();
    var map = st.map;
    var drag = st.drag;
    if (!map || !keys.length) return;

    var segIndex = drag.side === "out" ? drag.key : drag.key - 1;
    var seg = segIndex >= 0 ? M.segmentOf(keys, segIndex) : null;
    if (!seg) return;

    if (st.mode === "path") {
      dragPath(pt, drag, keys);
      return;
    }

    var time = map.T(pt.x);
    var value = map.V(pt.y);
    var inf, m;

    if (st.mode === "speed") {
      inf = drag.side === "out"
        ? ((time - seg.tA) / seg.dt) * 100
        : ((seg.tB - time) / seg.dt) * 100;
      inf = M.clamp(inf, M.MIN_INFLUENCE, M.MAX_INFLUENCE);
      var chord = Number(seg.chord[drag.dim] || 0);
      m = Math.abs(chord) < 1e-9 ? 0 : value / chord;
      m = M.clamp(m, M.MIN_M, M.MAX_M);
    } else {
      // 值图：水平 → influence，垂直 → 斜率
      var clampedTime = M.clamp(time, seg.tA + seg.dt * 0.001, seg.tB - seg.dt * 0.001);
      var res = M.easeFromHandle(seg, drag.side, drag.dim, clampedTime, value);
      inf = res.inf;
      m = res.m;
    }

    // Shift = 只改缓动幅度（水平拖动），斜率保持拖拽前的值
    if (drag.shift) m = drag.m0;

    writeLocal(keys, drag.key, drag.side, segIndex, inf, m);
    draw();
    updateHint(
      t("influence " + inf.toFixed(1) + "% · 斜率 " + m.toFixed(2) + "×",
        "influence " + inf.toFixed(1) + "% · slope " + m.toFixed(2) + "×")
    );
  }

  /** 把 (inf, m) 落到本地关键帧模型：m 按各维弦斜率展开成 speed */
  function writeLocal(keys, keyIndex, side, segIndex, inf, m) {
    var seg = M.segmentOf(keys, segIndex);
    if (!seg) return;
    var d;
    for (d = 0; d < seg.dims; d++) {
      var chord = Number(seg.chord[d] || 0);
      var speed = m * chord;
      if (side === "out") {
        keys[keyIndex].os[d] = speed;
        keys[keyIndex].oi[d] = inf;
        keys[keyIndex].tout = M.TYPE_BEZIER;
      } else {
        keys[keyIndex].is[d] = speed;
        keys[keyIndex].ii[d] = inf;
        keys[keyIndex].tin = M.TYPE_BEZIER;
      }
    }
  }

  function dragPath(pt, drag, keys) {
    var map = st.map;
    var key = keys[drag.key];
    if (!key) return;
    var vx = map.T(pt.x);
    var vy = map.V(pt.y);
    var dx = vx - Number(key.v[0] || 0);
    var dy = vy - Number(key.v[1] || 0);
    if (drag.side === "out") {
      key.ot[0] = dx;
      key.ot[1] = dy;
    } else {
      key.it[0] = dx;
      key.it[1] = dy;
    }
    draw();
    updateHint(t("空间切线 " + dx.toFixed(1) + ", " + dy.toFixed(1),
      "spatial tangent " + dx.toFixed(1) + ", " + dy.toFixed(1)));
  }

  function onMouseUp() {
    if (!st.drag) return;
    var drag = st.drag;
    st.drag = null;
    el.canvas.style.cursor = "default";

    var keys = activeKeys();
    var p = active();
    if (!p) return;
    var key = keys[drag.key];
    if (!key) return;

    var segIndex = drag.side === "out" ? drag.key : drag.key - 1;
    // 用当前关键帧算弦斜率：拖拽只改 ease，不改时间与值，所以弦不变
    var seg = segIndex >= 0 ? M.segmentOf(keys, segIndex) : null;

    var lines = ["expect\t" + p.loc + "\t" + p.sig];

    if (st.mode === "path") {
      if (drag.side === "out") {
        lines.push(["tan", p.loc, String(drag.key), "out",
          numText(key.ot[0]), numText(key.ot[1]), numText(key.ot[2] || 0)].join("\t"));
      } else {
        lines.push(["tan", p.loc, String(drag.key), "in",
          numText(key.it[0]), numText(key.it[1]), numText(key.it[2] || 0)].join("\t"));
      }
    } else {
      // m 用拖拽后的实际 speed 反推（writeLocal 已把 m 展开到各维）
      var speed = drag.side === "out" ? Number(key.os[drag.dim] || 0) : Number(key.is[drag.dim] || 0);
      var chord = seg ? Number(seg.chord[drag.dim] || 0) : 0;
      var m = Math.abs(chord) < 1e-9 ? 0 : speed / chord;
      var inf = drag.side === "out" ? Number(key.oi[drag.dim] || 33.33) : Number(key.ii[drag.dim] || 33.33);
      lines.push([drag.side, p.loc, String(drag.key), numText(inf), numText(m)].join("\t"));
    }

    st.backup = null;
    send(lines.join("\n"));
  }

  function numText(value) {
    var n = Number(value);
    if (!isFinite(n)) n = 0;
    return String(Math.round(n * 10000) / 10000);
  }

  /* ============================================================
   * 五、写回与并发冲突
   * ============================================================ */

  function send(text) {
    if (!deps.engine) return;
    el.canvas.style.opacity = "0.65";
    deps.engine("AEV_Curve.applyText(" + JSON.stringify(text) + ")", function (res) {
      el.canvas.style.opacity = "1";
      var data = deps.parse ? deps.parse(res) : null;

      if (!data) {
        setMessage(t("写回失败：无法解析 AE 返回值", "Write failed: bad AE response"), true);
        return;
      }

      if (data.status === "conflict") {
        st.pendingText = text;
        showConflict(data);
        return;
      }

      if (data.status !== "ok") {
        setMessage(t("写回失败：" + (data.reason || "") , "Write failed: " + (data.reason || "")), true);
        return;
      }

      var skipped = data.skipped || [];
      var note = "";
      if (skipped.length) {
        if (indexOf(skipped, "roving") >= 0) note = t("（roving 关键帧的时间由 AE 排布，已跳过）",
          " (roving keyframes are timed by AE, skipped)");
        else if (indexOf(skipped, "edge") >= 0) note = t("（端点没有对应区间，已跳过）",
          " (no adjacent segment at this key)");
      }
      var message = t("已写入 " + data.applied + " 处" + note,
        "Applied " + data.applied + note);
      setMessage(message, false);

      // 写完重新读一次：AE 可能钳位/规范化，显示值必须以 AE 为准
      st.afterRead = message;
      read(true);
    });
  }

  function indexOf(list, value) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] === value) return i;
    }
    return -1;
  }

  function showConflict(data) {
    el.conflict.hidden = false;
    el.conflictText.textContent = data.reason === "loc_missing"
      ? t("AE 里已经找不到这个属性了（选中对象被改了）。", "The property is gone — selection changed in AE.")
      : t("AE 里的这段曲线在你读取之后被修改过。", "This curve changed in AE since you read it.");
    draw();
  }

  function hideConflict() {
    el.conflict.hidden = true;
    st.pendingText = "";
  }

  /* ============================================================
   * 六、工具栏
   * ============================================================ */

  function renderPropSelect() {
    var select = el.prop;
    select.textContent = "";
    for (var i = 0; i < st.props.length; i++) {
      var option = document.createElement("option");
      option.value = String(i);
      var name = st.props[i].name;
      var group = st.props[i].group;
      option.textContent = group ? group + " · " + name : name;
      select.appendChild(option);
    }
    select.value = String(Math.max(0, st.active));
    select.disabled = st.props.length === 0;
  }

  function renderDimSelect() {
    var select = el.dim;
    var n = dims();
    select.textContent = "";
    if (n <= 1) {
      select.hidden = true;
      st.dim = 0;
      return;
    }
    select.hidden = false;
    var names = ["X", "Y", "Z", "W"];
    for (var i = 0; i < n; i++) {
      var option = document.createElement("option");
      option.value = String(i);
      option.textContent = names[i] || String(i + 1);
      select.appendChild(option);
    }
    if (st.dim >= n) st.dim = 0;
    select.value = String(st.dim);
  }

  function renderMode() {
    el.modeValue.className = "segment" + (st.mode === "value" ? " active" : "");
    el.modeSpeed.className = "segment" + (st.mode === "speed" ? " active" : "");
    el.modePath.className = "segment" + (st.mode === "path" ? " active" : "");
    el.modePath.disabled = !isPathCapable();
    el.modePath.title = isPathCapable()
      ? t("编辑空间路径切线", "Edit spatial path tangents")
      : t("只有空间属性（如位置）才有路径", "Only spatial properties have a path");
  }

  function renderPresets() {
    var select = el.preset;
    // 每次都重建：语言切换后标签要跟着变，重建比逐项改文本省事
    select.textContent = "";
    var first = document.createElement("option");
    first.value = "";
    first.textContent = t("缓动预设…", "Easing preset…");
    select.appendChild(first);
    for (var i = 0; i < PRESETS.length; i++) {
      var option = document.createElement("option");
      option.value = PRESETS[i].id;
      option.textContent = deps.lang && deps.lang() === "en" ? PRESETS[i].en : PRESETS[i].zh;
      select.appendChild(option);
    }
  }

  function renderAll() {
    renderPropSelect();
    renderDimSelect();
    renderMode();
    renderPresets();
    draw();
    updateHint();
  }

  function updateHint(override) {
    if (override) {
      setMessage(override, false);
      return;
    }
    var p = active();
    if (!p) {
      setMessage(t("先在 AE 里选中属性或图层，再点「读取选中」",
        "Select a property or layer in AE, then click Read"), false);
      return;
    }
    var selectedCount = 0;
    for (var k in st.selected) {
      if (st.selected.hasOwnProperty(k)) selectedCount++;
    }
    var parts = [
      p.name + (p.n ? " · " + p.n + " 键" : ""),
      (p.spatial && st.mode === "value")
        ? t("空间属性：值图只读，缓动请在「速度」或「路径」里改",
            "Spatial: value view is read-only, edit easing in Speed/Path")
        : "",
      selectedCount
        ? t("已选 " + selectedCount + " 个关键帧", selectedCount + " key(s) selected")
        : t("点关键帧后可拖它的把手", "Click a keyframe to drag its handles"),
      t("Shift 只改缓动幅度", "Shift = influence only")
    ];
    var clean = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) clean.push(parts[i]);
    }
    setMessage(clean.join(" · "), false);
  }

  /* ============================================================
   * 七、预设应用
   * ============================================================ */

  function applyPreset(presetId) {
    var p = active();
    if (!p || !presetId) return;
    var keys = p.keys;
    var targets = [];
    var k;
    for (k in st.selected) {
      if (st.selected.hasOwnProperty(k)) targets.push(Number(k));
    }
    if (!targets.length) {
      // 没选关键帧时作用于全部：这是最常用的一次性“整段套缓动”，
      // 但必须有明确反馈（状态栏会报数量），否则用户不知道改了哪些。
      for (var i = 0; i < keys.length; i++) targets.push(i);
    }

    var lines = ["expect\t" + p.loc + "\t" + p.sig];
    for (var j = 0; j < targets.length; j++) {
      lines.push(["preset", p.loc, String(targets[j]), presetId].join("\t"));
    }
    send(lines.join("\n"));
    el.preset.value = "";
  }

  /* ============================================================
   * 八、装配
   * ============================================================ */

  function init(options) {
    M = window.AEV_CurveMath;
    if (!M) {
      // 数学没加载就没法画图，直接把原因摆到界面上，比静默空白好
      var stage = document.getElementById("curveStage");
      if (stage) stage.textContent = "curve_math.js 未加载";
      return;
    }
    deps = options || deps;

    el.canvas = byId("curveCanvas");
    el.stage = byId("curveStage");
    el.empty = byId("curveEmpty");
    el.hint = byId("curveHint");
    el.read = byId("btnCurveRead");
    el.prop = byId("curveProp");
    el.dim = byId("curveDim");
    el.preset = byId("curvePreset");
    el.modeValue = byId("curveModeValue");
    el.modeSpeed = byId("curveModeSpeed");
    el.modePath = byId("curveModePath");
    el.conflict = byId("curveConflict");
    el.conflictText = byId("curveConflictText");

    el.read.addEventListener("click", function () { read(false); });
    el.prop.addEventListener("change", function () {
      st.active = Number(this.value);
      st.selected = {};
      st.dim = 0;
      if (!isPathCapable() && st.mode === "path") st.mode = "value";
      renderAll();
    });
    el.dim.addEventListener("change", function () {
      st.dim = Number(this.value);
      draw();
      updateHint();
    });
    el.preset.addEventListener("change", function () { applyPreset(this.value); });
    el.modeValue.addEventListener("click", function () { setMode("value"); });
    el.modeSpeed.addEventListener("click", function () { setMode("speed"); });
    el.modePath.addEventListener("click", function () { if (isPathCapable()) setMode("path"); });

    el.canvas.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" && event.keyCode !== 27) return;
      if (st.drag) {
        // 拖拽中按 Esc：回滚到拖拽前的本地模型，不写 AE
        try {
          var p = active();
          if (p && st.backup) p.keys = JSON.parse(st.backup);
        } catch (e) {}
        st.drag = null;
        st.backup = null;
        draw();
        setMessage(t("已取消这次拖拽", "Drag cancelled"), false);
        return;
      }
      if (!el.conflict.hidden) hideConflict();
    });

    byId("curveConflictOverwrite").addEventListener("click", function () {
      var text = "force\n" + st.pendingText.split("\n").filter(function (line) {
        return line.indexOf("expect\t") !== 0;
      }).join("\n");
      hideConflict();
      send(text);
    });
    byId("curveConflictReload").addEventListener("click", function () {
      hideConflict();
      read(false);
    });
    byId("curveConflictDrop").addEventListener("click", function () {
      hideConflict();
      read(true);
      setMessage(t("已放弃这次修改，显示的是 AE 当前值", "Discarded — showing current AE values"), false);
    });

    if (window.ResizeObserver && el.stage) {
      try {
        new ResizeObserver(function () { draw(); }).observe(el.stage);
      } catch (e) {}
    } else {
      window.addEventListener("resize", function () { draw(); });
    }
  }

  function setMode(mode) {
    st.mode = mode;
    renderMode();
    draw();
    updateHint();
  }

  /** 视图被切进来时调用：每次都重读，用户在 AE 里换了选中对象能立刻反映 */
  function enter() {
    renderPresets();
    if (!st.loaded) read(false);
    else read(true);
  }

  /**
   * 测试钩子（只读）。
   *
   * 无头浏览器里没法「看着画布点」，只能先拿到把手/关键帧的像素坐标，
   * 再派发真实的 mousedown/mousemove/mouseup —— 这样测的是真拖拽路径，
   * 而不是绕开命中测试直接调内部函数（后者测不出坐标算错这类问题）。
   */
  function debugSnapshot() {
    var p = active();
    if (!p) return { active: -1, props: st.props.length };
    var keyIndex = firstSelected();
    var keyPoints = [];
    for (var i = 0; i < p.keys.length; i++) {
      var pt = st.map ? keyPixel(i) : null;
      if (pt) keyPoints.push({ i: i, x: pt.x, y: pt.y });
    }
    var hp = (keyIndex >= 0 && st.map) ? handlePoints(keyIndex, "out", st.dim) : null;
    return {
      active: st.active,
      loc: p.loc,
      mode: st.mode,
      dim: st.dim,
      keys: p.keys.length,
      selected: (function () {
        var out = [];
        for (var k in st.selected) if (st.selected.hasOwnProperty(k)) out.push(Number(k));
        return out;
      })(),
      keyPoints: keyPoints,
      handle: hp ? { x: hp.x, y: hp.y } : null,
      pathCapable: isPathCapable(),
      message: st.message
    };
  }

  function keyPixel(index) {
    var keys = activeKeys();
    var map = st.map;
    var k = keys[index];
    if (!k || !map) return null;
    if (st.mode === "path") {
      return { x: map.X(Number(k.v[0] || 0)), y: map.Y(Number(k.v[1] || 0)) };
    }
    if (st.mode === "speed") {
      return { x: map.X(k.t), y: map.Y(speedAtKey(index, st.dim)) };
    }
    return { x: map.X(k.t), y: map.Y(Number(k.v[st.dim] || 0)) };
  }

  return {
    init: init,
    enter: enter,
    read: read,
    draw: draw,
    // 仅测试使用
    snapshot: debugSnapshot
  };
})();

if (typeof window !== "undefined") {
  window.AEV_CurveUI = AEV_CurveUI;
}
