/* ============================================================
 * curve.js —— M4 曲线编辑视图（Flow 式两把手）
 *
 * 分层（设计文档 §2）：
 *   · 纯数学：engine/curve_math.js（与 AE 侧共用同一份，唯一实现）
 *   · AE 读写：engine/curvelib.jsx（快照 / 写回 / 并发指纹），本文件只发文本协议
 *   · 本文件：画布、命中测试、拖拽、预设、冲突处理
 *
 * 交互模型（参照 Flow）：
 *   **一段曲线由两端各一条把手线决定**——起点引出 P1，终点引出 P2，
 *   两个控制点之间就是这段的值曲线。拖 P1 / P2 改的是这段的
 *   cubic-bezier(x1, y1, x2, y2)；换算关系：
 *     x1 = infOut/100,  y1 = mOut · x1
 *     x2 = 1 - infIn/100, y2 = 1 - mIn · (1 - x2)
 *   只对「选中的关键帧」生效：选中 N 个键就把同一条缓动铺到它们各自的段上。
 *
 * 为什么面板要自己算曲线：拖拽要逐帧重绘，不可能每动一下鼠标就过一次
 * evalScript（一次往返 10~50ms，体验直接崩）。所以参数一落盘就本地重算，
 * 松手才写回 AE，写回后再读一次快照与 AE 对齐 —— 不假设 AE 接受了我们的值。
 *
 * 语法：ES5（跑在 CEF 里，不用 ES6 是沿用项目既有约定）。
 * ============================================================ */

var AEV_CurveUI = (function () {
  /**
   * 缓动库：全部用 cubic-bezier(x1,y1,x2,y2) 表达，与 Flow / CSS 同一套语义。
   * 应用时换算成 AE 的 (influence, speed)，走的是与拖拽完全相同的写回路径。
   */
  var PRESETS = [
    { id: "linear", zh: "线性", en: "Linear", b: [0, 0, 1, 1] },
    { id: "ease", zh: "缓动", en: "Ease", b: [0.25, 0.1, 0.25, 1] },
    { id: "ease-in", zh: "缓入", en: "Ease In", b: [0.42, 0, 1, 1] },
    { id: "ease-out", zh: "缓出", en: "Ease Out", b: [0, 0, 0.58, 1] },
    { id: "ease-in-out", zh: "缓入缓出", en: "Ease In Out", b: [0.42, 0, 0.58, 1] },
    { id: "quad-in", zh: "二次缓入", en: "Quad In", b: [0.11, 0, 0.5, 0] },
    { id: "quad-out", zh: "二次缓出", en: "Quad Out", b: [0.5, 1, 0.89, 1] },
    { id: "cubic-in", zh: "三次缓入", en: "Cubic In", b: [0.32, 0, 0.67, 0] },
    { id: "cubic-out", zh: "三次缓出", en: "Cubic Out", b: [0.33, 1, 0.68, 1] },
    { id: "cubic-in-out", zh: "三次进出", en: "Cubic In Out", b: [0.65, 0, 0.35, 1] },
    { id: "expo-in", zh: "指数缓入", en: "Expo In", b: [0.7, 0, 0.84, 0] },
    { id: "expo-out", zh: "指数缓出", en: "Expo Out", b: [0.16, 1, 0.3, 1] },
    { id: "back-in", zh: "回拉缓入", en: "Back In", b: [0.36, 0, 0.66, -0.56] },
    { id: "back-out", zh: "回弹缓出", en: "Back Out", b: [0.34, 1.56, 0.64, 1] },
    { id: "back-in-out", zh: "回弹进出", en: "Back In Out", b: [0.68, -0.6, 0.32, 1.6] }
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
    busy: false,
    modeMenuOpen: false
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

  /**
   * 值图是否走「单位方块」。
   *
   * 空间属性的值图不走：它的形状由空间切线决定，归一化成 0→1 之后
   * 方块里那条曲线跟时间没有对应关系，容易误导；那种情况仍按时间轴显示并只读。
   */
  function unitMode() {
    var p = active();
    return st.mode === "value" && !(p && p.spatial);
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

  function numText(value) {
    var n = Number(value);
    if (!isFinite(n)) n = 0;
    return String(Math.round(n * 10000) / 10000);
  }

  function indexOf(list, value) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] === value) return i;
    }
    return -1;
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
        var reason = (data && data.reason) || String(text).slice(0, 160);
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

      var nextIndex = -1;
      if (keepLoc) {
        for (var i = 0; i < st.props.length; i++) {
          if (st.props[i].loc === keepLoc) { nextIndex = i; break; }
        }
      }
      if (nextIndex < 0 && st.props.length) nextIndex = 0;

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
      var message = st.afterRead;
      st.afterRead = "";
      setMessage(message || t("已读取 " + st.props.length + " 个属性（合成 " + st.comp + "）",
        "Loaded " + st.props.length + " properties from " + st.comp), false);
    });
  }

  /* ============================================================
   * 二、选区与段：Flow 的编辑单位是「一段」
   * ============================================================ */

  function selectedIndexes() {
    var out = [];
    for (var k in st.selected) {
      if (st.selected.hasOwnProperty(k)) out.push(Number(k));
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  /** 当前会被写入的段（0 基，段 i = 关键帧 i → i+1） */
  function targetSegments() {
    var keys = activeKeys();
    var segs = [];
    if (keys.length < 2) return segs;
    var sel = selectedIndexes();
    if (sel.length) {
      for (var i = 0; i < sel.length; i++) {
        if (sel[i] + 1 < keys.length) segs.push(sel[i]);
      }
      // 只选了最后一个键：把前一段算进来，否则「选了却改不动」
      if (!segs.length) segs.push(Math.max(0, sel[0] - 1));
      return segs;
    }
    for (var j = 0; j + 1 < keys.length; j++) segs.push(j);
    return segs;
  }

  function activeSegmentIndex() {
    var segs = targetSegments();
    return segs.length ? segs[0] : -1;
  }

  /** 段在归一化空间里的 cubic-bezier(0..1) 参数 */
  function segmentBezier(segIndex) {
    var keys = activeKeys();
    var seg = M.segmentOf(keys, segIndex);
    if (!seg) return null;
    var x1 = M.clamp(seg.infOut / 100, 0, 1);
    var x2 = M.clamp(1 - seg.infIn / 100, 0, 1);
    var y1 = seg.mOut * x1;
    var y2 = 1 - seg.mIn * (1 - x2);
    return { x1: x1, y1: y1, x2: x2, y2: y2 };
  }

  /** bezier → AE 的 (influence, 斜率倍率) */
  function bezierToEase(b) {
    var x1 = M.clamp(b.x1, 0.001, 1);
    var x2 = M.clamp(b.x2, 0, 0.999);
    var infOut = x1 * 100;
    var infIn = (1 - x2) * 100;
    var mOut = x1 > 1e-4 ? M.clamp(b.y1 / x1, M.MIN_M, M.MAX_M) : 0;
    var mIn = (1 - x2) > 1e-4 ? M.clamp((1 - b.y2) / (1 - x2), M.MIN_M, M.MAX_M) : 0;
    return { infOut: infOut, infIn: infIn, mOut: mOut, mIn: mIn };
  }

  /* ============================================================
   * 三、视图映射
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

  /**
   * 单位方块：0→1 的正方形编辑区（Flow 的做法）。
   *
   * 归一化之后每条段的曲线都是 (0,0)→(1,1)，与属性的实际值域、时间段都无关，
   * 所以不同段可以**叠在同一块方格里对比**。方块缩到可用空间的 86%，
   * 四周留出的 7% 给回弹/过冲的把手 —— back 族会跑到 0..1 之外。
   */
  function unitSquare(w, h) {
    var padTop = 18;
    var padBottom = 22;
    var padSide = 18;
    var availW = Math.max(40, w - padSide * 2);
    var availH = Math.max(40, h - padTop - padBottom);
    var size = Math.min(availW, availH) * 0.86;
    var cx = padSide + availW / 2;
    var cy = padTop + availH / 2;
    return { x: cx - size / 2, y: cy - size / 2, w: size, h: size };
  }

  function computeRange() {
    var keys = activeKeys();
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
   * 四、绘制
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
      updateReadout();
      return;
    }

    var keys = p.keys;
    if (!keys || keys.length < 2) {
      drawEmpty(ctx, w, h, t("这个属性只有一个关键帧，没有可编辑的曲线",
        "Only one keyframe — no curve to edit"));
      updateReadout();
      return;
    }

    var rect = plotRect(w, h);
    var range;

    if (unitMode()) {
      // 单位方块：(0,0)→(1,1)，横轴是段内进度而不是时间
      rect = unitSquare(w, h);
      range = { t0: 0, t1: 1, lo: 0, hi: 1 };
      st.map = makeMap(rect, range);
      drawUnitView(ctx, keys, rect);
      updateReadout();
      return;
    }

    range = computeRange();
    if (st.mode === "path") range = equalizeAspect(rect, range);
    st.map = makeMap(rect, range);

    drawGrid(ctx, rect, range, p);
    if (st.mode === "path") drawPath(ctx, keys);
    else drawCurve(ctx, keys);
    drawKeys(ctx, keys);
    drawHandles(ctx, keys);
    drawPlayhead(ctx, rect, range);
    updateReadout();
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

  /* ---------- 单位方块视图（Flow 式） ---------- */

  /** 归一化贝塞尔上的点：p0=(0,0)、p1=(x1,y1)、p2=(x2,y2)、p3=(1,1) */
  function unitBezierPoint(b, u) {
    var mt = 1 - u;
    var w0 = mt * mt * mt;
    var w1 = 3 * mt * mt * u;
    var w2 = 3 * mt * u * u;
    var w3 = u * u * u;
    return {
      x: w1 * b.x1 + w2 * b.x2 + w3,
      y: w1 * b.y1 + w2 * b.y2 + w3
    };
  }

  function strokeUnitBezier(ctx, b, color, width) {
    var map = st.map;
    var steps = 56;
    ctx.beginPath();
    for (var i = 0; i <= steps; i++) {
      var pt = unitBezierPoint(b, i / steps);
      var px = map.X(pt.x);
      var py = map.Y(pt.y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  function drawUnitGrid(ctx, rect) {
    ctx.fillStyle = "rgba(255,255,255,0.018)";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    // 四等分细网格
    ctx.strokeStyle = "rgba(255,255,255,0.045)";
    ctx.lineWidth = 1;
    for (var i = 1; i < 4; i++) {
      var gx = Math.round(rect.x + (rect.w * i) / 4) + 0.5;
      var gy = Math.round(rect.y + (rect.h * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(gx, rect.y);
      ctx.lineTo(gx, rect.y + rect.h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(rect.x, gy);
      ctx.lineTo(rect.x + rect.w, gy);
      ctx.stroke();
    }

    // 线性参考（左下 → 右上）
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.beginPath();
    ctx.moveTo(rect.x, rect.y + rect.h);
    ctx.lineTo(rect.x + rect.w, rect.y);
    ctx.stroke();
    ctx.restore();

    // 0..1 的边界
    ctx.strokeStyle = "rgba(160,190,195,0.28)";
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, Math.max(1, rect.w - 1), Math.max(1, rect.h - 1));
  }

  /** 角点：单位方块的两个端点，画成方框（其余段的关键帧都缩在这两点上） */
  function drawCorner(ctx, x, y, selected) {
    ctx.beginPath();
    ctx.rect(x - 4.5, y - 4.5, 9, 9);
    ctx.fillStyle = selected ? "#cfe3e5" : "#16191c";
    ctx.fill();
    ctx.strokeStyle = selected ? "#cfe3e5" : "#7fa6aa";
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  /**
   * 单位方块主绘制。
   *
   * 图层顺序（从后往前）：网格 → 其余段（灰度）→ 目标段（亮）→ 两角 → 把手。
   * 灰度段既是「前后文」，也是**切换编辑对象**的点击目标 —— 点哪条就编哪一段。
   */
  function drawUnitView(ctx, keys, rect) {
    drawUnitGrid(ctx, rect);

    var targets = targetSegments();
    var i, b;

    for (i = 0; i + 1 < keys.length; i++) {
      if (indexOf(targets, i) >= 0) continue;
      b = segmentBezier(i);
      if (b) strokeUnitBezier(ctx, b, "rgba(127,166,170,0.22)", 1.2);
    }

    for (i = 0; i < targets.length; i++) {
      b = segmentBezier(targets[i]);
      if (b) strokeUnitBezier(ctx, b, "#cfe3e5", 2);
    }

    drawCorner(ctx, rect.x, rect.y + rect.h, true);
    drawCorner(ctx, rect.x + rect.w, rect.y, true);

    drawUnitHandles(ctx);

    // 右下角标出「第几段 / 共几段」，多段时用户才知道自己在改哪一段
    if (keys.length > 2) {
      ctx.font = "10px 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
      ctx.fillStyle = "#5d666c";
      ctx.textAlign = "right";
      var segIndex = activeSegmentIndex();
      ctx.fillText(t("段 " + (segIndex + 1) + " / " + (keys.length - 1),
        "seg " + (segIndex + 1) + " / " + (keys.length - 1)),
        rect.x + rect.w - 10, rect.y - 6);
      ctx.textAlign = "left";
    }
  }

  function drawUnitHandles(ctx) {
    var segIndex = activeSegmentIndex();
    var b = segmentBezier(segIndex);
    if (!b) return;
    var map = st.map;
    var origin = { x: map.X(0), y: map.Y(0) };
    var end = { x: map.X(1), y: map.Y(1) };
    var p1 = { x: map.X(b.x1), y: map.Y(b.y1) };
    var p2 = { x: map.X(b.x2), y: map.Y(b.y2) };
    drawHandlePair(ctx, origin, p1, "out");
    drawHandlePair(ctx, end, p2, "in");
  }

  /** 一条把手线 + 端点 + 控制点（值图与速度图共用） */
  function drawHandlePair(ctx, base, tip, side) {
    var hot = st.hoverHandle && st.hoverHandle.side === side;

    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.strokeStyle = hot ? "#f0c469" : "rgba(240,196,105,0.75)";
    ctx.lineWidth = hot ? 1.8 : 1.2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(base.x, base.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "#cfe3e5";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(tip.x, tip.y, hot ? 6 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = hot ? "#ffe1a3" : "#f0c469";
    ctx.fill();
    ctx.strokeStyle = "#0f1113";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawGrid(ctx, rect, range) {
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

    ctx.fillStyle = "#5d666c";
    var modeLabel = st.mode === "speed"
      ? t("速度（值/秒）", "Speed (units/s)")
      : (st.mode === "path" ? t("路径（顶视图 X/Y）", "Path (top view X/Y)") : t("值", "Value"));
    ctx.fillText(modeLabel + " · " + dimLabel(), rect.x + 2, rect.y - 4);
  }

  function dimLabel() {
    var p = active();
    if (!p || p.dims <= 1) return t("标量", "scalar");
    var names = ["X", "Y", "Z", "W"];
    return "dim " + (names[st.dim] || String(st.dim + 1));
  }

  function drawCurve(ctx, keys) {
    var map = st.map;
    var d = st.dim;
    var targets = targetSegments();

    for (var i = 0; i + 1 < keys.length; i++) {
      var seg = M.segmentOf(keys, i);
      if (!seg) continue;
      var isTarget = indexOf(targets, i) >= 0;
      ctx.strokeStyle = isTarget ? "#cfe3e5" : "rgba(127,166,170,0.55)";
      ctx.lineWidth = isTarget ? 2 : 1.2;
      ctx.beginPath();
      var steps = Math.max(8, Math.min(120, Math.round(map.rect.w / 3)));
      for (var s = 0; s <= steps; s++) {
        var time = seg.tA + (seg.dt * s) / steps;
        var value = M.sampleValue(seg, d, time);
        var px = map.X(time);
        var py = map.Y(value);
        if (s === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }

  function drawPath(ctx, keys) {
    var map = st.map;
    var targets = targetSegments();
    for (var i = 0; i + 1 < keys.length; i++) {
      var seg = M.segmentOf(keys, i);
      if (!seg) continue;
      ctx.strokeStyle = indexOf(targets, i) >= 0 ? "#cfe3e5" : "rgba(127,166,170,0.55)";
      ctx.lineWidth = indexOf(targets, i) >= 0 ? 2 : 1.2;
      ctx.beginPath();
      for (var s = 0; s <= 48; s++) {
        var pt = M.pathPoint(seg, s / 48);
        var px = map.X(pt[0]);
        var py = map.Y(pt[1]);
        if (s === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }

  function keyPixel(index) {
    var keys = activeKeys();
    var map = st.map;
    var k = keys[index];
    if (!k || !map) return null;
    if (unitMode()) {
      // 单位方块里所有关键帧都缩到两个角：只有首末两把有位置，
      // 中间的键此时没有独立坐标（选段靠点曲线，不靠点键）
      if (index === 0) return { x: map.X(0), y: map.Y(0) };
      if (index === keys.length - 1) return { x: map.X(1), y: map.Y(1) };
      return null;
    }
    if (st.mode === "path") {
      return { x: map.X(Number(k.v[0] || 0)), y: map.Y(Number(k.v[1] || 0)) };
    }
    if (st.mode === "speed") {
      return { x: map.X(k.t), y: map.Y(speedAtKey(index, st.dim)) };
    }
    return { x: map.X(k.t), y: map.Y(Number(k.v[st.dim] || 0)) };
  }

  function drawKeys(ctx, keys) {
    for (var i = 0; i < keys.length; i++) {
      var pt = keyPixel(i);
      if (!pt) continue;
      var selected = !!st.selected[i];
      ctx.beginPath();
      ctx.rect(pt.x - 4, pt.y - 4, 8, 8);
      ctx.fillStyle = selected ? "#cfe3e5" : "#16191c";
      ctx.fill();
      ctx.strokeStyle = selected ? "#cfe3e5" : "#7fa6aa";
      ctx.lineWidth = 1.4;
      ctx.stroke();

      if (keys[i].rv) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 7, 0, Math.PI * 2);
        ctx.strokeStyle = "#a36d65";
        ctx.stroke();
      }
    }
  }

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

  /**
   * 段的两条把手（像素坐标）。
   *
   * 值图里 P1 由**起点**引出、P2 由**终点**引出 —— 与 Flow 一致：
   * 两条线各自决定曲线离开起点、进入终点的走向。
   * 空间属性的值图不给把手（形状由空间切线决定），缓动去速度图或路径图改。
   */
  function segmentHandlePixels(segIndex, d) {
    var keys = activeKeys();
    var map = st.map;
    if (!map || segIndex < 0) return null;
    var seg = M.segmentOf(keys, segIndex);
    if (!seg) return null;

    if (st.mode === "speed") {
      var h = M.normalizedHandles(seg);
      var speedOut = Number((keys[segIndex].os || [])[0] || 0);
      var speedIn = Number((keys[segIndex + 1].is || [])[0] || 0);
      return {
        seg: seg,
        p0: { x: map.X(seg.tA), y: map.Y(speedOut) },
        p3: { x: map.X(seg.tB), y: map.Y(speedIn) },
        p1: { x: map.X(h.p1.x), y: map.Y(speedOut) },
        p2: { x: map.X(h.p2.x), y: map.Y(speedIn) }
      };
    }

    if (unitMode()) {
      var ub = segmentBezier(segIndex);
      if (!ub) return null;
      return {
        seg: seg,
        p0: { x: map.X(0), y: map.Y(0) },
        p1: { x: map.X(ub.x1), y: map.Y(ub.y1) },
        p2: { x: map.X(ub.x2), y: map.Y(ub.y2) },
        p3: { x: map.X(1), y: map.Y(1) }
      };
    }

    var hnd = M.handles(seg, d);
    return {
      seg: seg,
      p0: { x: map.X(hnd.p0.x), y: map.Y(hnd.p0.y) },
      p1: { x: map.X(hnd.p1.x), y: map.Y(hnd.p1.y) },
      p2: { x: map.X(hnd.p2.x), y: map.Y(hnd.p2.y) },
      p3: { x: map.X(hnd.p3.x), y: map.Y(hnd.p3.y) }
    };
  }

  function drawHandles(ctx, keys) {
    var p = active();
    if (!p) return;
    if (st.mode === "path") {
      drawPathHandles(ctx, keys);
      return;
    }
    if (st.mode === "value" && p.spatial) return;   // 空间属性的值图只读

    var segIndex = activeSegmentIndex();
    var px = segmentHandlePixels(segIndex, st.dim);
    if (!px) return;

    // 起点 → P1、终点 → P2：两条线，与 Flow 的呈现一致
    drawHandlePair(ctx, px.p0, px.p1, "out");
    drawHandlePair(ctx, px.p3, px.p2, "in");
  }

  function drawPathHandles(ctx, keys) {
    var segIndex = activeSegmentIndex();
    if (segIndex < 0) return;
    var map = st.map;
    var key = keys[segIndex];
    var next = keys[segIndex + 1];
    if (!key || !next) return;

    var points = [
      { k: key, side: "out", tan: key.ot },
      { k: next, side: "in", tan: next.it }
    ];
    for (var i = 0; i < points.length; i++) {
      var item = points[i];
      var bx = map.X(Number(item.k.v[0] || 0));
      var by = map.Y(Number(item.k.v[1] || 0));
      var tx = map.X(Number(item.k.v[0] || 0) + Number(item.tan[0] || 0));
      var ty = map.Y(Number(item.k.v[1] || 0) + Number(item.tan[1] || 0));
      var hot = st.hoverHandle && st.hoverHandle.side === item.side;

      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(tx, ty);
      ctx.strokeStyle = hot ? "#f0c469" : "rgba(240,196,105,0.75)";
      ctx.lineWidth = hot ? 1.8 : 1.2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(tx, ty, hot ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = hot ? "#ffe1a3" : "#f0c469";
      ctx.fill();
      ctx.strokeStyle = "#0f1113";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function drawPlayhead(ctx, rect, range) {
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

  /** 图下方的四个数：cubic-bezier(x1, y1, x2, y2)，与 Flow 的读数一致 */
  function updateReadout() {
    if (!el.readout) return;
    var p = active();
    if (!p || st.mode !== "value") {
      el.readout.textContent = st.mode === "value" ? "—" : (st.mode === "speed" ? t("速度图", "speed") : t("路径图", "path"));
      return;
    }
    var segIndex = activeSegmentIndex();
    var b = segmentBezier(segIndex);
    if (!b) {
      el.readout.textContent = "—";
      return;
    }
    el.readout.textContent =
      b.x1.toFixed(2) + ", " + b.y1.toFixed(2) + ", " +
      b.x2.toFixed(2) + ", " + b.y2.toFixed(2);
  }

  /* ============================================================
   * 五、命中测试与拖拽
   * ============================================================ */

  function localPoint(event) {
    var rect = el.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function keyAt(px, py) {
    var keys = activeKeys();
    for (var i = 0; i < keys.length; i++) {
      var pt = keyPixel(i);
      if (!pt) continue;
      if (Math.abs(px - pt.x) <= 7 && Math.abs(py - pt.y) <= 7) return i;
    }
    return -1;
  }

  function handleAt(px, py) {
    var p = active();
    if (!p) return null;
    if (st.mode === "value" && p.spatial) return null;
    var segIndex = activeSegmentIndex();
    var seg = M.segmentOf(activeKeys(), segIndex);
    if (!seg) return null;

    if (st.mode === "path") {
      var map = st.map;
      var key = activeKeys()[segIndex];
      var next = activeKeys()[segIndex + 1];
      var cands = [
        { side: "out", k: key, tan: key.ot },
        { side: "in", k: next, tan: next.it }
      ];
      for (var c = 0; c < cands.length; c++) {
        var tx = map.X(Number(cands[c].k.v[0] || 0) + Number(cands[c].tan[0] || 0));
        var ty = map.Y(Number(cands[c].k.v[1] || 0) + Number(cands[c].tan[1] || 0));
        var dx = px - tx;
        var dy = py - ty;
        if (dx * dx + dy * dy <= 64) return { key: segIndex, side: cands[c].side };
      }
      return null;
    }

    var px4 = segmentHandlePixels(segIndex, st.dim);
    if (!px4) return null;
    var options = [{ side: "out", p: px4.p1 }, { side: "in", p: px4.p2 }];
    for (var i = 0; i < options.length; i++) {
      var ddx = px - options[i].p.x;
      var ddy = py - options[i].p.y;
      if (ddx * ddx + ddy * ddy <= 64) return { key: segIndex, side: options[i].side };
    }
    return null;
  }

  /**
   * 点在哪一段的曲线上（只用于单位方块）。
   *
   * 单位空间里各段是同一条 0→1 的曲线，靠「离哪条采样线最近」判断，
   * 阈值 10px —— 比关键帧的 7px 稍松，因为细线不好点中。
   */
  function segmentAt(px, py) {
    var keys = activeKeys();
    var map = st.map;
    if (!map || keys.length < 2) return -1;
    var best = -1;
    var bestD = 100;   // 10px 平方
    for (var i = 0; i + 1 < keys.length; i++) {
      var b = segmentBezier(i);
      if (!b) continue;
      for (var s = 0; s <= 36; s++) {
        var pt = unitBezierPoint(b, s / 36);
        var dx = px - map.X(pt.x);
        var dy = py - map.Y(pt.y);
        var d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; best = i; }
      }
    }
    return best;
  }

  function onMouseDown(event) {
    if (event.button !== 0) return;
    var pt = localPoint(event);

    /* 把手优先：它的命中半径比关键帧小，放在后面判的话在角上永远点不到把手
       （单位方块里两个把手基点正好就是两个角）。 */
    var hitHandle = handleAt(pt.x, pt.y);
    if (hitHandle) {
      st.backup = JSON.stringify(activeKeys());
      var segIndex0 = st.mode === "path"
        ? Math.min(hitHandle.key, activeKeys().length - 2)
        : activeSegmentIndex();
      var seg0 = M.segmentOf(activeKeys(), segIndex0);
      st.drag = {
        segIndex: segIndex0,
        side: hitHandle.side,
        dim: st.dim,
        shift: event.shiftKey,
        m0: seg0 ? (hitHandle.side === "out" ? seg0.mOut : seg0.mIn) : 0
      };
      event.preventDefault();
      updateHint();
      return;
    }

    /* 单位方块：点曲线 = 把那段设为编辑对象 */
    if (unitMode()) {
      var hitKeys = activeKeys();
      var segHit = segmentAt(pt.x, pt.y);
      if (segHit >= 0) {
        /* 多段形状完全重合时（都套过同一条缓动），点哪儿都命中同一条。
           Shift + 点已选中的那条 → 轮到下一段，这样重合的段也能选到。 */
        if (event.shiftKey && st.selected[segHit] && hitKeys.length > 2) {
          segHit = (segHit + 1) % (hitKeys.length - 1);
        }
        st.selected = {};
        st.selected[segHit] = true;
        st.hoverHandle = null;
        draw();
        updateHint();
        return;
      }
      st.selected = {};
      st.hoverHandle = null;
      draw();
      updateHint();
      return;
    }

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

    st.selected = {};
    st.hoverHandle = null;
    draw();
    updateHint();
  }

  function onMouseMove(event) {
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

  function applyDrag(pt) {
    var keys = activeKeys();
    var map = st.map;
    var drag = st.drag;
    if (!map || !keys.length) return;

    var seg = M.segmentOf(keys, drag.segIndex);
    if (!seg) return;

    if (st.mode === "path") {
      dragPath(pt, drag, keys);
      return;
    }

    var time = map.T(pt.x);

    if (st.mode === "speed") {
      var value = map.V(pt.y);
      var inf = drag.side === "out"
        ? ((time - seg.tA) / seg.dt) * 100
        : ((seg.tB - time) / seg.dt) * 100;
      inf = M.clamp(inf, M.MIN_INFLUENCE, M.MAX_INFLUENCE);
      var chord = Number(seg.chord[drag.dim] || 0);
      var speed = value;
      var m = Math.abs(chord) < 1e-9 ? 0 : speed / chord;
      m = M.clamp(m, M.MIN_M, M.MAX_M);
      if (drag.shift) m = drag.m0;
      writeLocal(keys, drag.segIndex, drag.side, inf, m);
      draw();
      updateHint(t("influence " + inf.toFixed(1) + "% · 斜率 " + m.toFixed(2) + "×",
        "influence " + inf.toFixed(1) + "% · slope " + m.toFixed(2) + "×"));
      return;
    }

    // 单位方块：横轴已经是段内进度、纵轴已经是归一化值，直接落成 bezier 参数
    if (unitMode()) {
      var ub = segmentBezier(drag.segIndex);
      if (!ub) return;
      var unx = M.clamp(time, 0.001, 1);
      var uny = map.V(pt.y);
      if (drag.shift) uny = drag.side === "out" ? ub.y1 : ub.y2;
      if (drag.side === "out") { ub.x1 = unx; ub.y1 = uny; }
      else { ub.x2 = unx; ub.y2 = uny; }
      writeLocalSegment(keys, drag.segIndex, bezierToEase(ub));
      draw();
      updateHint(t(
        "cubic-bezier(" + ub.x1.toFixed(2) + ", " + ub.y1.toFixed(2) + ", " +
          ub.x2.toFixed(2) + ", " + ub.y2.toFixed(2) + ")",
        "cubic-bezier(" + ub.x1.toFixed(2) + ", " + ub.y1.toFixed(2) + ", " +
          ub.x2.toFixed(2) + ", " + ub.y2.toFixed(2) + ")"));
      return;
    }

    // 值图：把手位置直接换算成归一化 (x, y)
    var clampedTime = M.clamp(time, seg.tA + seg.dt * 0.001, seg.tB - seg.dt * 0.001);
    var b = segmentBezier(drag.segIndex);
    if (!b) return;

    var vA = Number(seg.vA[drag.dim] || 0);
    var vB = Number(seg.vB[drag.dim] || 0);
    var dv = vB - vA;

    var nx = M.clamp((clampedTime - seg.tA) / seg.dt, 0.001, 1);
    var ny;
    if (Math.abs(dv) > 1e-9) {
      ny = (map.V(pt.y) - vA) / dv;      // 允许超出 0..1（回弹/过冲）
    } else {
      ny = drag.side === "out" ? b.y1 : b.y2;
    }
    if (drag.shift) {
      // Shift：只改水平（时间），高度保持原样
      ny = drag.side === "out" ? b.y1 : b.y2;
    }

    if (drag.side === "out") {
      b.x1 = nx;
      b.y1 = ny;
    } else {
      b.x2 = nx;
      b.y2 = ny;
    }

    var e = bezierToEase(b);
    writeLocalSegment(keys, drag.segIndex, e);
    draw();
    updateHint(
      t("cubic-bezier(" + b.x1.toFixed(2) + ", " + b.y1.toFixed(2) + ", " +
        b.x2.toFixed(2) + ", " + b.y2.toFixed(2) + ")",
        "cubic-bezier(" + b.x1.toFixed(2) + ", " + b.y1.toFixed(2) + ", " +
        b.x2.toFixed(2) + ", " + b.y2.toFixed(2) + ")")
    );
  }

  /** 把一段的 (inf, m) 落到本地模型 */
  function writeLocalSegment(keys, segIndex, e) {
    var a = keys[segIndex];
    var b = keys[segIndex + 1];
    if (!a || !b) return;
    a.oi = [e.infOut];
    a.os = [e.mOut * (Number(b.v[0] || 0) - Number(a.v[0] || 0))];
    a.tout = M.TYPE_BEZIER;
    b.ii = [e.infIn];
    b.is = [e.mIn * (Number(b.v[0] || 0) - Number(a.v[0] || 0))];
    b.tin = M.TYPE_BEZIER;
    // 多维：模型只用单条 ease，speed 由模长还原，这里给各维同值即可
    var dimsN = Math.max(a.v.length, b.v.length);
    var chordMag = 0;
    for (var d = 0; d < dimsN; d++) {
      var dv = Number(b.v[d] || 0) - Number(a.v[d] || 0);
      chordMag += dv * dv;
    }
    chordMag = Math.sqrt(chordMag);
    for (var k = 0; k < dimsN; k++) {
      a.os[k] = e.mOut * chordMag;
      b.is[k] = e.mIn * chordMag;
    }
  }

  /** 兼容旧路径：按 key/side 写本地模型（速度图与路径图仍用） */
  function writeLocal(keys, keyIndex, side, inf, m) {
    var segIndex = side === "out" ? keyIndex : keyIndex - 1;
    var seg = M.segmentOf(keys, segIndex);
    if (!seg) return;
    for (var d = 0; d < seg.dims; d++) {
      var chord = Number(seg.chord[d] || 0);
      if (side === "out") {
        keys[keyIndex].os[d] = m * chord;
        keys[keyIndex].oi[d] = inf;
        keys[keyIndex].tout = M.TYPE_BEZIER;
      } else {
        keys[keyIndex].is[d] = m * chord;
        keys[keyIndex].ii[d] = inf;
        keys[keyIndex].tin = M.TYPE_BEZIER;
      }
    }
  }

  function dragPath(pt, drag, keys) {
    var map = st.map;
    var segIndex = drag.segIndex;
    var target = drag.side === "out" ? keys[segIndex] : keys[segIndex + 1];
    if (!target) return;
    var vx = map.T(pt.x);
    var vy = map.V(pt.y);
    var dx = vx - Number(target.v[0] || 0);
    var dy = vy - Number(target.v[1] || 0);
    if (drag.side === "out") {
      target.ot[0] = dx;
      target.ot[1] = dy;
    } else {
      target.it[0] = dx;
      target.it[1] = dy;
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

    var p = active();
    if (!p) return;
    var keys = activeKeys();
    st.backup = null;

    if (st.mode === "path") {
      var target = drag.side === "out" ? keys[drag.segIndex] : keys[drag.segIndex + 1];
      var lines = ["expect\t" + p.loc + "\t" + p.sig];
      lines.push(["tan", p.loc, String(drag.side === "out" ? drag.segIndex : drag.segIndex + 1),
        drag.side, numText(target.ot ? (drag.side === "out" ? target.ot[0] : target.it[0]) : 0),
        numText(drag.side === "out" ? target.ot[1] : target.it[1]),
        numText(0)].join("\t"));
      send(lines.join("\n"));
      return;
    }

    if (st.mode === "value") {
      var b = segmentBezier(drag.segIndex);
      if (!b) return;
      applyBezier(b, drag.segIndex);
      return;
    }

    // 速度图：只写拖动的那一侧
    var seg = M.segmentOf(keys, drag.segIndex);
    if (!seg) return;
    var speed = drag.side === "out"
      ? Number((keys[drag.segIndex].os || [])[0] || 0)
      : Number((keys[drag.segIndex + 1].is || [])[0] || 0);
    var chord = Number(seg.chord[drag.dim] || 0);
    var m = Math.abs(chord) < 1e-9 ? 0 : speed / chord;
    var inf = drag.side === "out"
      ? Number((keys[drag.segIndex].oi || [])[0] || 33.33)
      : Number((keys[drag.segIndex + 1].ii || [])[0] || 33.33);
    var keyIndex = drag.side === "out" ? drag.segIndex : drag.segIndex + 1;
    send([
      "expect\t" + p.loc + "\t" + p.sig,
      [drag.side, p.loc, String(keyIndex), numText(inf), numText(m)].join("\t")
    ].join("\n"));
  }

  /* ============================================================
   * 六、写回
   * ============================================================ */

  /**
   * 把一条归一化 bezier 应用到「选中的段」。
   *
   * 选中 N 个关键帧 → 它们各自的段都套同一条缓动（Flow 的行为）。
   * 没有选中 → 作用于整条属性。dragSeg 非空时，若它不在选中集合里就只改它自己，
   * 避免「随手拖一段却把整条属性都改了」。
   */
  function applyBezier(b, dragSeg) {
    var p = active();
    if (!p) return;
    var keys = p.keys;
    var segs = targetSegments();
    if (typeof dragSeg === "number" && indexOf(segs, dragSeg) < 0) segs = [dragSeg];
    if (!segs.length) return;

    var e = bezierToEase(b);
    var lines = ["expect\t" + p.loc + "\t" + p.sig];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s + 1 >= keys.length) continue;
      lines.push(["out", p.loc, String(s), numText(e.infOut), numText(e.mOut)].join("\t"));
      lines.push(["in", p.loc, String(s + 1), numText(e.infIn), numText(e.mIn)].join("\t"));
    }
    send(lines.join("\n"));
  }

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
        setMessage(t("写回失败：" + (data.reason || ""), "Write failed: " + (data.reason || "")), true);
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

      st.afterRead = message;
      read(true);
    });
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
   * 七、工具栏
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

  /** 三视图切换收进一个小方块：按钮显示当前模式，点开是三项 */
  function renderMode() {
    if (el.modeBtn) {
      el.modeBtn.textContent = st.mode === "value" ? "值" : (st.mode === "speed" ? "速" : "路");
      el.modeBtn.title = st.mode === "value" ? t("值曲线", "Value curve")
        : (st.mode === "speed" ? t("速度曲线", "Speed curve") : t("空间路径", "Spatial path"));
      el.modeBtn.setAttribute("aria-expanded", st.modeMenuOpen ? "true" : "false");
    }
    el.modeValue.className = "mode-item" + (st.mode === "value" ? " active" : "");
    el.modeSpeed.className = "mode-item" + (st.mode === "speed" ? " active" : "");
    el.modePath.className = "mode-item" + (st.mode === "path" ? " active" : "");
    el.modePath.disabled = !isPathCapable();
    el.modePath.title = isPathCapable()
      ? t("编辑空间路径切线", "Edit spatial path tangents")
      : t("只有空间属性（如位置）才有路径", "Only spatial properties have a path");
    if (el.modeMenu) el.modeMenu.hidden = !st.modeMenuOpen;
  }

  function renderPresets() {
    var select = el.preset;
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
    var segs = targetSegments();
    var selectedCount = selectedIndexes().length;
    var p2 = st.mode === "value" && p.spatial;

    var parts = [];
    parts.push(p.name + (p.n ? " · " + p.n + " 键" : ""));
    if (p2) {
      parts.push(t("空间属性：值图只读，缓动请在「速/路」里改",
        "Spatial: value view is read-only, edit in Speed/Path"));
    } else if (st.mode === "value") {
      parts.push(t("点曲线选段 · 拖两端把手改曲线", "Click a curve to pick a segment · drag a handle"));
      parts.push(selectedCount
        ? t("作用于 " + segs.length + " 段（已选 " + selectedCount + " 键）",
          "Applies to " + segs.length + " segment(s)")
        : t("未选：作用于全部 " + segs.length + " 段", "No selection: all segments"));
    } else if (st.mode === "speed") {
      parts.push(t("拖把手改速度", "Drag handle to change speed"));
      parts.push(t("Shift 只改缓动幅度", "Shift = influence only"));
    } else {
      parts.push(t("拖切线改路径", "Drag tangent to shape the path"));
    }
    setMessage(parts.join(" · "), false);
  }

  /* ============================================================
   * 八、装配
   * ============================================================ */

  function init(options) {
    M = window.AEV_CurveMath;
    if (!M) {
      var stage = byId("curveStage");
      if (stage) stage.textContent = "curve_math.js 未加载";
      return;
    }
    deps = options || deps;

    el.canvas = byId("curveCanvas");
    el.stage = byId("curveStage");
    el.hint = byId("curveHint");
    el.readout = byId("curveReadout");
    el.read = byId("btnCurveRead");
    el.prop = byId("curveProp");
    el.dim = byId("curveDim");
    el.preset = byId("curvePreset");
    el.modeBtn = byId("curveModeBtn");
    el.modeMenu = byId("curveModeMenu");
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
    el.preset.addEventListener("change", function () {
      var preset = null;
      for (var i = 0; i < PRESETS.length; i++) {
        if (PRESETS[i].id === this.value) { preset = PRESETS[i]; break; }
      }
      this.value = "";
      if (!preset) return;
      var b = { x1: preset.b[0], y1: preset.b[1], x2: preset.b[2], y2: preset.b[3] };
      // 本地先套一遍：写回后要重读快照，这一下能让画面立刻响应
      var segs = targetSegments();
      for (var s = 0; s < segs.length; s++) applyLocalBezier(segs[s], b);
      draw();
      applyBezier(b);
      setMessage(t("已套用「" + preset.zh + "」到 " + segs.length + " 段",
        "Applied “" + preset.en + "” to " + segs.length + " segment(s)"), false);
    });

    el.modeBtn.addEventListener("click", function (event) {
      event.stopPropagation();
      st.modeMenuOpen = !st.modeMenuOpen;
      renderMode();
    });
    el.modeValue.addEventListener("click", function () { setMode("value"); });
    el.modeSpeed.addEventListener("click", function () { setMode("speed"); });
    el.modePath.addEventListener("click", function () {
      if (isPathCapable()) setMode("path");
    });
    document.addEventListener("mousedown", function (event) {
      if (!st.modeMenuOpen) return;
      if (el.modeMenu && el.modeMenu.contains(event.target)) return;
      if (el.modeBtn && el.modeBtn.contains(event.target)) return;
      st.modeMenuOpen = false;
      renderMode();
    });

    el.canvas.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" && event.keyCode !== 27) return;
      if (st.drag) {
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
      if (st.modeMenuOpen) { st.modeMenuOpen = false; renderMode(); }
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

  /** 本地套一条 bezier（拖动与预设共用） */
  function applyLocalBezier(segIndex, b) {
    var keys = activeKeys();
    var e = bezierToEase(b);
    writeLocalSegment(keys, segIndex, e);
  }

  function setMode(mode) {
    st.mode = mode;
    st.modeMenuOpen = false;
    renderMode();
    draw();
    updateHint();
  }

  function enter() {
    renderPresets();
    if (!st.loaded) read(false);
    else read(true);
  }

  /**
   * 测试钩子（只读）。无头浏览器里没法「看着画布点」，先拿像素坐标再派发事件。
   */
  function debugSnapshot() {
    var p = active();
    if (!p) return { active: -1, props: st.props.length };
    var segIndex = activeSegmentIndex();
    var keyPoints = [];
    for (var i = 0; i < p.keys.length; i++) {
      var pt = st.map ? keyPixel(i) : null;
      if (pt) keyPoints.push({ i: i, x: pt.x, y: pt.y });
    }
    var hp = st.map ? segmentHandlePixels(segIndex, st.dim) : null;

    /* 单位方块里各段的代表点（曲线上 u=0.5 处）：无头浏览器靠它点选段 */
    var segPoints = [];
    if (st.map && unitMode()) {
      for (var s = 0; s + 1 < p.keys.length; s++) {
        var sb = segmentBezier(s);
        if (!sb) continue;
        var mid = unitBezierPoint(sb, 0.5);
        segPoints.push({ i: s, x: st.map.X(mid.x), y: st.map.Y(mid.y) });
      }
    }

    return {
      active: st.active,
      loc: p.loc,
      mode: st.mode,
      unit: unitMode(),
      dim: st.dim,
      keys: p.keys.length,
      selected: selectedIndexes(),
      targets: targetSegments(),
      keyPoints: keyPoints,
      segPoints: segPoints,
      handle: hp ? { x: hp.p1.x, y: hp.p1.y } : null,
      handleIn: hp ? { x: hp.p2.x, y: hp.p2.y } : null,
      bezier: segmentBezier(segIndex),
      readout: el.readout ? el.readout.textContent : "",
      pathCapable: isPathCapable(),
      message: st.message
    };
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
