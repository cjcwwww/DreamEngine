/* ============================================================
 * curve.js —— 曲线编辑器（Flow 式：曲线模板 + 应用 + 预设）
 *
 * 工作流（与旧版的关键差别）
 *   旧版：读取选中 → 在面板里选关键帧 → 拖把手即写回 AE。
 *   现在：面板**常驻一条可编辑曲线**（模板），调好后点「应用」，
 *         才去读 AE 的选中态并把这条曲线铺到选中属性的各段上。
 *
 *   为什么这么改：AE 没有「选中关键帧」的 API，旧版的选区只能靠面板自己
 *   维护，一旦不读快照就没有选区来源。改成模板式之后，界面永远是稳定的，
 *   读 AE 只发生在按「应用」的那一下 —— 少一次往返，也少一类状态错位。
 *
 * 分层（设计文档 §2）
 *   · 纯数学：engine/curve_math.js（与 AE 侧共用同一份，唯一实现）
 *   · AE 读写：engine/curvelib.jsx（快照 / 写回 / 并发指纹），本文件只发文本协议
 *   · 本文件：画布、拖拽、预设网格、应用与冲突处理
 *
 * 换算（面板的归一化贝塞尔 ↔ AE 的 influence/speed）
 *   x1 = infOut/100,  y1 = mOut · x1
 *   x2 = 1 - infIn/100, y2 = 1 - mIn · (1 - x2)
 *   m 是「相对弦斜率的倍率」，所以同一条曲线对各段通用 —— 这正是模板
 *   能一次铺到多条属性的原因。
 *
 * 语法：ES5（跑在 CEF 里，沿用项目既有约定）。
 * ============================================================ */

var AEV_CurveUI = (function () {
  /**
   * 缓动库：全部用 cubic-bezier(x1,y1,x2,y2) 表达，与 Flow / CSS 同一套语义。
   * 面板里以**小曲线缩略图**呈现，点一下即换掉模板曲线。
   */
  var PRESETS = [
    { id: "linear", zh: "线性", en: "Linear", b: [0, 0, 1, 1] },
    { id: "ease", zh: "缓动", en: "Ease", b: [0.25, 0.1, 0.25, 1] },
    { id: "ease-in", zh: "缓入", en: "Ease In", b: [0.42, 0, 1, 1] },
    { id: "ease-out", zh: "缓出", en: "Ease Out", b: [0, 0, 0.58, 1] },
    { id: "ease-in-out", zh: "缓入缓出", en: "Ease In Out", b: [0.42, 0, 0.58, 1] },
    { id: "quad-in", zh: "二次入", en: "Quad In", b: [0.55, 0.085, 0.68, 0.53] },
    { id: "quad-out", zh: "二次出", en: "Quad Out", b: [0.25, 0.46, 0.45, 0.94] },
    { id: "cubic-in", zh: "三次入", en: "Cubic In", b: [0.55, 0.055, 0.675, 0.19] },
    { id: "cubic-out", zh: "三次出", en: "Cubic Out", b: [0.215, 0.61, 0.355, 1] },
    { id: "expo-in", zh: "指数入", en: "Expo In", b: [0.95, 0.05, 0.795, 0.035] },
    { id: "expo-out", zh: "指数出", en: "Expo Out", b: [0.19, 1, 0.22, 1] },
    { id: "back-in", zh: "回弹入", en: "Back In", b: [0.6, -0.28, 0.735, 0.045] },
    { id: "back-out", zh: "回弹出", en: "Back Out", b: [0.175, 0.885, 0.32, 1.275] },
    { id: "back-in-out", zh: "回弹双", en: "Back In Out", b: [0.68, -0.55, 0.265, 1.55] },
    { id: "smooth", zh: "平滑", en: "Smooth", b: [0.4, 0, 0.2, 1] }
  ];

  var DEFAULT_CURVE = { x1: 0.33, y1: 0, x2: 0.67, y2: 1 };
  var CUSTOM_PRESET_KEY = "dreamengine.curve.customPresets.v1";
  var DELETED_PRESET_KEY = "dreamengine.curve.deletedPresets.v1";
  var memoryStorage = {};

  var deps = { engine: null, parse: null, status: null, lang: null };
  var el = {};
  var M = null;

  var st = {
    /* 当前视图：value = 单位方块（可编辑）；speed / path = 上次应用的只读检查 */
    mode: "value",
    /* 正在编辑的模板曲线 */
    curve: { x1: DEFAULT_CURVE.x1, y1: DEFAULT_CURVE.y1, x2: DEFAULT_CURVE.x2, y2: DEFAULT_CURVE.y2 },
    preset: "ease",
    drag: null,
    hoverHandle: null,
    map: null,
    /* 上次「应用」读到的快照：速/路图与灰色参考都用它 */
    snap: null,
    snapIndex: 0,
    busy: false,
    modeMenuOpen: false,
    pendingText: "",
    pendingSegs: 0,
    msg: "",
    msgError: false,
    customPresets: [],
    deletedPresets: [],
    deletePresetId: "",
    holdTimer: null,
    holdTriggeredId: ""
  };

  /* ============================================================
   * 一、小工具
   * ============================================================ */

  function t(zh, en) {
    var lang = "zh";
    try {
      if (deps && typeof deps.lang === "function") lang = deps.lang() || "zh";
    } catch (e) {}
    return lang === "en" ? en : zh;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  /** 数值文本：去掉多余小数，AE 侧 parseFloat 能直接吃 */
  function numText(value) {
    var n = Number(value);
    if (!isFinite(n)) n = 0;
    var s = n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    return s === "-0" ? "0" : s;
  }

  function fmt(value, span) {
    var n = Number(value) || 0;
    if (Math.abs(span) >= 100) return n.toFixed(0);
    if (Math.abs(span) >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }

  function curveCopy(b) {
    return { x1: Number(b.x1), y1: Number(b.y1), x2: Number(b.x2), y2: Number(b.y2) };
  }

  /** 曲线参数落到合法范围：x 必须在 [0,1]（否则不是函数），y 允许过冲 */
  function clampCurve(b) {
    b.x1 = M.clamp(b.x1, 0, 1);
    b.x2 = M.clamp(b.x2, 0, 1);
    b.y1 = M.clamp(b.y1, -3, 3);
    b.y2 = M.clamp(b.y2, -3, 3);
    return b;
  }

  function storageGet(key) {
    try {
      if (window.localStorage) return window.localStorage.getItem(key) || "";
    } catch (e) {}
    return memoryStorage[key] || "";
  }

  function storageSet(key, value) {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(key, value);
        return;
      }
    } catch (e) {}
    memoryStorage[key] = value;
  }

  function loadCustomPresets() {
    var raw = storageGet(CUSTOM_PRESET_KEY);
    if (!raw) return [];
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return [];
    }
    if (!data || Object.prototype.toString.call(data) !== "[object Array]") return [];
    var out = [];
    for (var i = 0; i < data.length; i++) {
      var item = data[i];
      if (!item || !/^custom-/.test(String(item.id || "")) || !item.b || item.b.length < 4) continue;
      var name = String(item.name || "").replace(/^\s+|\s+$/g, "").substring(0, 24);
      if (!name) continue;
      var curve = clampCurve({
        x1: Number(item.b[0]) || 0,
        y1: Number(item.b[1]) || 0,
        x2: Number(item.b[2]) || 0,
        y2: Number(item.b[3]) || 0
      });
      out.push({
        id: String(item.id),
        name: name,
        builtin: false,
        b: [curve.x1, curve.y1, curve.x2, curve.y2]
      });
    }
    return out;
  }

  function saveCustomPresets() {
    storageSet(CUSTOM_PRESET_KEY, JSON.stringify(st.customPresets));
  }

  function loadDeletedPresetIds() {
    var raw = storageGet(DELETED_PRESET_KEY);
    if (!raw) return [];
    try {
      var data = JSON.parse(raw);
      if (!data || Object.prototype.toString.call(data) !== "[object Array]") return [];
      var out = [];
      for (var i = 0; i < data.length; i++) {
        var id = String(data[i] || "");
        if (!isBuiltinPreset(id) || isDeletedPreset(id)) continue;
        out.push(id);
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  function saveDeletedPresetIds() {
    storageSet(DELETED_PRESET_KEY, JSON.stringify(st.deletedPresets));
  }

  function isBuiltinPreset(id) {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === id) return true;
    }
    return false;
  }

  function isDeletedPreset(id) {
    for (var i = 0; i < st.deletedPresets.length; i++) {
      if (st.deletedPresets[i] === id) return true;
    }
    return false;
  }

  function allPresets() {
    var out = [];
    for (var i = 0; i < PRESETS.length; i++) {
      if (!isDeletedPreset(PRESETS[i].id)) out.push(PRESETS[i]);
    }
    for (var j = 0; j < st.customPresets.length; j++) out.push(st.customPresets[j]);
    return out;
  }

  function findPreset(id) {
    var items = allPresets();
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return items[i];
    }
    return null;
  }

  /* ============================================================
   * 二、通道
   * ============================================================ */

  function engine(expr, cb) {
    if (deps && typeof deps.engine === "function") deps.engine(expr, cb);
    else if (cb) cb("__NO_ENGINE__");
  }

  function setMessage(text, isError) {
    st.msg = text || "";
    st.msgError = !!isError;
    if (!el.hint) return;
    el.hint.textContent = st.msg;
    el.hint.className = "curve-hint" + (isError ? " error" : "");
  }

  function setBusy(flag) {
    st.busy = !!flag;
    if (el.apply) {
      el.apply.disabled = st.busy;
      el.apply.textContent = st.busy
        ? t("应用中…", "Applying…")
        : t("应用", "Apply");
    }
  }

  /* ============================================================
   * 三、换算
   * ============================================================ */

  /** 归一化贝塞尔 → AE 的 (influence, m)。m 是相对弦斜率的倍率。 */
  function bezierToEase(b) {
    var x1 = M.clamp(b.x1, 0.001, 0.999);
    var x2 = M.clamp(b.x2, 0.001, 0.999);
    return {
      infOut: x1 * 100,
      infIn: (1 - x2) * 100,
      mOut: M.clamp(b.y1 / x1, M.MIN_M, M.MAX_M),
      mIn: M.clamp((1 - b.y2) / (1 - x2), M.MIN_M, M.MAX_M)
    };
  }

  /** 快照里某一段的归一化贝塞尔（用于灰色参考） */
  function keysBezier(keys, segIndex) {
    var seg = M.segmentOf(keys, segIndex);
    if (!seg) return null;
    var x1 = M.clamp(seg.infOut / 100, 0, 1);
    var x2 = M.clamp(1 - seg.infIn / 100, 0, 1);
    return {
      x1: x1,
      y1: seg.mOut * x1,
      x2: x2,
      y2: 1 - seg.mIn * (1 - x2)
    };
  }

  /** 归一化贝塞尔上的点：p0=(0,0)、p1=(x1,y1)、p2=(x2,y2)、p3=(1,1) */
  function bezierPoint(b, u) {
    var mt = 1 - u;
    var w1 = 3 * mt * mt * u;
    var w2 = 3 * mt * u * u;
    var w3 = u * u * u;
    return {
      x: w1 * b.x1 + w2 * b.x2 + w3,
      y: w1 * b.y1 + w2 * b.y2 + w3
    };
  }

  /* ============================================================
   * 四、画布
   * ============================================================ */

  function setupCanvas() {
    var canvas = el.canvas;
    var stage = el.stage;
    if (!canvas || !stage) return null;

    var ratio = window.devicePixelRatio || 1;
    var w = stage.clientWidth;
    var h = stage.clientHeight;
    if (!w || !h) return null;

    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  /**
   * 单位方块：0→1 的正方形编辑区（Flow 的做法）。
   *
   * 归一化之后每条段的曲线都是 (0,0)→(1,1)，与属性的实际值域、时间段都无关，
   * 所以同一条模板可以服务任何属性。方块缩到可用空间的 86%，四周留出的
   * 余量给回弹/过冲的把手 —— back 族会跑到 0..1 之外。
   */
  function unitSquare(w, h) {
    var padTop = 16;
    var padBottom = 18;
    var padSide = 16;
    var availW = Math.max(40, w - padSide * 2);
    var availH = Math.max(40, h - padTop - padBottom);
    var size = Math.min(availW, availH) * 0.9;
    var cx = padSide + availW / 2;
    var cy = padTop + availH / 2;
    return { x: cx - size / 2, y: cy - size / 2, w: size, h: size };
  }

  /** 0..1 → 像素。单位方块的映射与属性数据无关，所以只需要 rect。 */
  function makeMap(rect) {
    return {
      rect: rect,
      X: function (u) { return rect.x + u * rect.w; },
      T: function (px) { return (px - rect.x) / Math.max(1, rect.w); },
      Y: function (v) { return rect.y + (1 - v) * rect.h; },
      V: function (py) { return 1 - (py - rect.y) / Math.max(1, rect.h); }
    };
  }

  function plotRect(w, h) {
    return { x: 42, y: 14, w: Math.max(20, w - 56), h: Math.max(20, h - 36) };
  }

  function draw() {
    var v = setupCanvas();
    if (!v) return;
    var ctx = v.ctx;
    ctx.clearRect(0, 0, v.w, v.h);

    if (st.mode === "value") {
      var rect = unitSquare(v.w, v.h);
      st.map = makeMap(rect);
      drawTemplate(ctx, rect);
      updateReadout();
      return;
    }

    st.map = null;
    drawInspect(ctx, v.w, v.h);
    updateReadout();
  }

  /* ---------- 单位方块（值图，可编辑） ---------- */

  function drawTemplate(ctx, rect) {
    drawUnitGrid(ctx, rect);

    /* 灰色参考：上次应用读到的属性，各段现在的样子。
       刚应用完时它会和亮线重合 —— 那正是「写入生效」的视觉证据。 */
    var keysList = snapKeysList();
    for (var i = 0; i < keysList.length; i++) {
      var keys = keysList[i];
      for (var j = 0; j + 1 < keys.length; j++) {
        var gb = keysBezier(keys, j);
        if (gb) strokeBezier(ctx, gb, "rgba(127,166,170,0.20)", 1.2);
      }
    }

    strokeBezier(ctx, st.curve, "#cfe3e5", 2);

    drawCorner(ctx, rect.x, rect.y + rect.h);
    drawCorner(ctx, rect.x + rect.w, rect.y);

    drawHandles(ctx, rect);
  }

  function snapKeysList() {
    var out = [];
    if (!st.snap || !st.snap.props) return out;
    for (var i = 0; i < st.snap.props.length; i++) {
      var keys = st.snap.props[i].keys || [];
      if (keys.length >= 2) out.push(keys);
    }
    return out;
  }

  function strokeBezier(ctx, b, color, width) {
    var map = st.map;
    var steps = 60;
    ctx.beginPath();
    for (var i = 0; i <= steps; i++) {
      var pt = bezierPoint(b, i / steps);
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

    /* 线性参考（左下 → 右上）：曲线在它上方是「快起」，下方是「慢起」 */
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.beginPath();
    ctx.moveTo(rect.x, rect.y + rect.h);
    ctx.lineTo(rect.x + rect.w, rect.y);
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = "rgba(160,190,195,0.28)";
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, Math.max(1, rect.w - 1), Math.max(1, rect.h - 1));
  }

  function drawCorner(ctx, x, y) {
    ctx.beginPath();
    ctx.rect(x - 4.5, y - 4.5, 9, 9);
    ctx.fillStyle = "#101214";
    ctx.fill();
    ctx.strokeStyle = "#86aeb2";
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  /** 两条把手：起点 → P1、终点 → P2 */
  function drawHandles(ctx, rect) {
    var map = st.map;
    var origin = { x: rect.x, y: rect.y + rect.h };
    var end = { x: rect.x + rect.w, y: rect.y };
    drawHandlePair(ctx, origin, { x: map.X(st.curve.x1), y: map.Y(st.curve.y1) }, "out");
    drawHandlePair(ctx, end, { x: map.X(st.curve.x2), y: map.Y(st.curve.y2) }, "in");
  }

  function drawHandlePair(ctx, base, tip, side) {
    var hot = st.drag ? st.drag.side === side : st.hoverHandle === side;

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
    ctx.strokeStyle = "#0a0b0c";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /* ---------- 速 / 路（只读检查视图） ---------- */

  function activeSnapProp() {
    if (!st.snap || !st.snap.props || !st.snap.props.length) return null;
    var i = st.snapIndex;
    if (i < 0 || i >= st.snap.props.length) i = 0;
    return st.snap.props[i];
  }

  function drawInspect(ctx, w, h) {
    var prop = activeSnapProp();
    if (!prop) {
      drawEmpty(ctx, w, h, t("应用一次后这里能看实际曲线",
        "Apply once to inspect the real curve"));
      return;
    }
    if (st.mode === "path" && !(prop.spatial && prop.dims >= 2)) {
      drawEmpty(ctx, w, h, t("这条属性没有空间路径", "This property has no spatial path"));
      return;
    }

    var keys = prop.keys || [];
    if (keys.length < 2) {
      drawEmpty(ctx, w, h, t("关键帧不足两把", "Fewer than two keyframes"));
      return;
    }

    var rect = plotRect(w, h);
    var range = inspectRange(keys, prop);
    var map = {
      X: function (time) { return rect.x + ((time - range.t0) / (range.t1 - range.t0)) * rect.w; },
      Y: function (value) { return rect.y + (1 - (value - range.lo) / (range.hi - range.lo)) * rect.h; }
    };

    drawInspectGrid(ctx, rect, range);

    var steps = 80;
    var t0 = keys[0].t;
    var t1 = keys[keys.length - 1].t;
    ctx.beginPath();
    for (var i = 0; i <= steps; i++) {
      var time = t0 + ((t1 - t0) * i) / steps;
      var seg = segAtTime(keys, time);
      if (!seg) continue;
      var px, py;
      if (st.mode === "path") {
        var prog = M.progress(seg, time);
        var u = M.uAtProgress ? M.uAtProgress(seg, prog) : prog;
        var pt = M.pathPoint(seg, u);
        px = map.X(pt[0]);
        py = map.Y(pt[1]);
      } else {
        px = map.X(time);
        py = map.Y(M.speedAt(seg, 0, time));
      }
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = "#cfe3e5";
    ctx.lineWidth = 2;
    ctx.stroke();

    for (var k = 0; k < keys.length; k++) {
      var kx = map.X(keys[k].t);
      var kd = st.mode === "path" ? 1 : 0;
      var ky = map.Y(Number((keys[k].v || [])[kd] || 0));
      ctx.beginPath();
      ctx.rect(kx - 3, ky - 3, 6, 6);
      ctx.fillStyle = "#101214";
      ctx.fill();
      ctx.strokeStyle = "#86aeb2";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    ctx.font = "10px 'DreamEngine Sans', 'Microsoft YaHei UI', sans-serif";
    ctx.fillStyle = "#5c646b";
    ctx.textAlign = "left";
    ctx.fillText(prop.name + t("（只读）", " (read-only)"), rect.x, rect.y - 4);
    if (st.snap.props.length > 1) {
      ctx.textAlign = "right";
      ctx.fillText((st.snapIndex + 1) + " / " + st.snap.props.length, rect.x + rect.w, rect.y - 4);
      ctx.textAlign = "left";
    }
  }

  function segAtTime(keys, time) {
    for (var i = 0; i + 1 < keys.length; i++) {
      if (time >= keys[i].t - 1e-9 && time <= keys[i + 1].t + 1e-9) {
        return M.segmentOf(keys, i);
      }
    }
    return M.segmentOf(keys, keys.length - 2);
  }

  function inspectRange(keys, prop) {
    var t0 = keys[0].t;
    var t1 = keys[keys.length - 1].t;
    if (t1 - t0 < 1e-6) t1 = t0 + 1;
    var lo = Infinity;
    var hi = -Infinity;
    var dims = prop.dims || 1;
    for (var i = 0; i < keys.length; i++) {
      for (var d = 0; d < dims; d++) {
        var v = Number((keys[i].v || [])[d] || 0);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-6) hi = lo + 1;
    var pad = (hi - lo) * 0.12;
    return { t0: t0, t1: t1, lo: lo - pad, hi: hi + pad };
  }

  function drawInspectGrid(ctx, rect, range) {
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var gy = Math.round(rect.y + (rect.h * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(rect.x, gy);
      ctx.lineTo(rect.x + rect.w, gy);
      ctx.stroke();
    }
    ctx.font = "10px 'DreamEngine Sans', 'Microsoft YaHei UI', sans-serif";
    ctx.fillStyle = "#5c646b";
    ctx.textAlign = "right";
    for (var j = 0; j <= 4; j++) {
      var value = range.hi - ((range.hi - range.lo) * j) / 4;
      ctx.fillText(fmt(value, range.hi - range.lo), rect.x - 6, rect.y + (rect.h * j) / 4 + 3);
    }
    ctx.textAlign = "left";
  }

  function drawEmpty(ctx, w, h, text) {
    ctx.fillStyle = "#5c646b";
    ctx.font = "12px 'DreamEngine Sans', 'Microsoft YaHei UI', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(text, w / 2, h / 2);
    ctx.textAlign = "left";
  }

  /* ============================================================
   * 五、交互：只改本地模板，绝不在这里过桥
   * ============================================================ */

  function localPoint(event) {
    var box = el.canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  /** 命中把手。只有值图有把手：速/路是只读检查，不给操作点。 */
  function handleAt(px, py) {
    if (st.mode !== "value" || !st.map) return null;
    var rect = st.map.rect;
    /* 方块外一点点就不判命中：过冲的把手会跑到框外，
       但没有理由在远离方块的地方抓它 */
    if (py < rect.y - rect.h * 0.16 || py > rect.y + rect.h * 1.16) return null;
    if (px < rect.x - rect.w * 0.16 || px > rect.x + rect.w * 1.16) return null;

    var cands = [
      { side: "out", x: st.map.X(st.curve.x1), y: st.map.Y(st.curve.y1) },
      { side: "in", x: st.map.X(st.curve.x2), y: st.map.Y(st.curve.y2) }
    ];
    var best = null;
    var bestD = 12 * 12;
    for (var i = 0; i < cands.length; i++) {
      var dx = px - cands[i].x;
      var dy = py - cands[i].y;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = cands[i]; }
    }
    return best;
  }

  function onMouseDown(event) {
    if (event.button !== 0) return;
    var pt = localPoint(event);
    var hit = handleAt(pt.x, pt.y);
    if (!hit) return;
    st.drag = { side: hit.side, shift: event.shiftKey, curve: curveCopy(st.curve) };
    event.preventDefault();
    draw();
    updateHint();
  }

  function onMouseMove(event) {
    var pt = localPoint(event);
    if (st.drag) {
      applyDrag(pt);
      return;
    }
    var hit = handleAt(pt.x, pt.y);
    var next = hit ? hit.side : null;
    if (next !== st.hoverHandle) {
      st.hoverHandle = next;
      if (el.canvas) el.canvas.style.cursor = next ? "pointer" : "default";
      draw();
    }
  }

  function applyDrag(pt) {
    var drag = st.drag;
    var map = st.map;
    if (!map) return;

    var nx = M.clamp(map.T(pt.x), 0, 1);
    var ny = map.V(pt.y);
    if (drag.shift) ny = drag.side === "out" ? drag.curve.y1 : drag.curve.y2;

    if (drag.side === "out") {
      st.curve.x1 = nx;
      st.curve.y1 = ny;
    } else {
      st.curve.x2 = nx;
      st.curve.y2 = ny;
    }
    clampCurve(st.curve);

    /* 手动改过就不再是任何预设的精确值 —— 取消高亮，
       否则会出现「高亮着缓动、曲线其实已经变了」的假象 */
    if (st.preset) {
      st.preset = "";
      renderPresets();
    }
    draw();
    updateHint();
  }

  function onMouseUp() {
    if (!st.drag) return;
    st.drag = null;
    draw();
    updateHint();
  }

  function onKeyDown(event) {
    if (event.key !== "Escape" && event.keyCode !== 27) return;
    if (st.drag) {
      st.curve = curveCopy(st.drag.curve);
      st.drag = null;
      draw();
      updateHint();
      setMessage(t("已取消这次拖拽", "Drag cancelled"), false);
      return;
    }
    if (el.saveDialog && !el.saveDialog.hidden) {
      closeSavePreset();
      return;
    }
    if (el.deleteDialog && !el.deleteDialog.hidden) {
      closeDeletePreset();
      return;
    }
    if (el.conflict && !el.conflict.hidden) hideConflict();
    if (st.modeMenuOpen) {
      st.modeMenuOpen = false;
      renderMode();
    }
  }

  /* ============================================================
   * 六、应用：只有这里读 AE
   * ============================================================ */

  /**
   * 把模板曲线铺到快照里每条属性的**每一段**。
   *
   * 为什么不是「选中的段」：AE 不暴露「选中关键帧」，面板既然不常驻快照
   * 就没有选区来源。应用时读到什么就作用什么 —— 快照本身已按 AE 选中态
   * 过滤过属性，作用范围就是这些属性的全部区间。
   */
  function buildText(props, curve) {
    var e = bezierToEase(curve);
    var lines = [];
    var segs = 0;
    for (var i = 0; i < props.length; i++) {
      var p = props[i];
      var keys = p.keys || [];
      if (keys.length < 2) continue;
      lines.push("expect\t" + p.loc + "\t" + p.sig);
      for (var s = 0; s + 1 < keys.length; s++) {
        lines.push(["out", p.loc, String(s), numText(e.infOut), numText(e.mOut)].join("\t"));
        lines.push(["in", p.loc, String(s + 1), numText(e.infIn), numText(e.mIn)].join("\t"));
        segs++;
      }
    }
    return { text: lines.join("\n"), segs: segs };
  }

  function apply() {
    if (st.busy) return;
    setBusy(true);
    setMessage(t("正在读取 AE 选中态…", "Reading AE selection…"), false);

    engine("AEV_Curve.snapshotJson()", function (text) {
      var data = deps.parse ? deps.parse(text) : null;

      if (!data || data.status !== "ok") {
        setBusy(false);
        st.snap = null;
        draw();
        var reason = (data && data.reason) || String(text).slice(0, 120);
        setMessage(
          reason === "no_comp"
            ? t("AE 里没有打开的合成", "No composition open")
            : t("读取失败：" + reason, "Read failed: " + reason),
          true
        );
        return;
      }

      st.snap = data;
      st.snapIndex = 0;

      if (!data.props || !data.props.length) {
        setBusy(false);
        draw();
        setMessage(data.filtered > 0
          ? t("选中的 " + data.filtered + " 个属性没有时间缓动（路径、文本、标记类改不了曲线）",
              "Selected properties have no temporal ease (paths, text, markers)")
          : t("AE 里没有可编辑的动画属性：先选中一个带动画的属性，或选中带关键帧的图层",
              "Nothing animated is selected — pick an animated property or a layer with keyframes"),
          true);
        return;
      }

      var built = buildText(data.props, st.curve);
      if (!built.segs) {
        setBusy(false);
        draw();
        setMessage(t("选中的属性不足两把关键帧", "Selected properties need at least two keyframes"), true);
        return;
      }

      st.pendingSegs = built.segs;
      send(built.text);
    });
  }

  function send(text) {
    st.pendingText = text;
    engine("AEV_Curve.applyText(" + JSON.stringify(text) + ")", function (res) {
      var data = deps.parse ? deps.parse(res) : null;

      if (!data) {
        setBusy(false);
        setMessage(t("写回失败：" + String(res).slice(0, 120),
          "Write failed: " + String(res).slice(0, 120)), true);
        return;
      }
      if (data.status === "conflict") {
        setBusy(false);
        showConflict(data);
        return;
      }
      if (data.status !== "ok") {
        setBusy(false);
        /* 以前只报 reason（work_failed 之类的代号），detail 与 loc 被丢掉了，
           等于告诉用户「失败了」却不说为什么。现在三段一起给。 */
        var why = data.reason || data.status || "unknown";
        if (data.detail) why += " · " + data.detail;
        if (data.loc) why += " · " + shortLoc(data.loc);
        setMessage(t("写入被拒：" + why, "Rejected: " + why), true);
        return;
      }

      setBusy(false);
      st.pendingText = "";
      var applied = data.applied || 0;
      var skipped = data.skipped || [];
      var note = skipNote(skipped);
      /* detail 是 AE 的原话（哪条属性、写的是什么、AE 嫌什么），必须带给用户 */
      var detail = data.detail ? " · " + data.detail : "";

      /* 一条都没写进去：这不是成功，别让用户以为生效了 */
      if (!applied) {
        setMessage(t("没有写入任何关键帧" + (note ? "：" + note : "（属性不支持缓动）") + detail,
          "Nothing was written" + (note ? ": " + note : " (no temporal ease)") + detail), true);
        return;
      }

      setMessage(t("已应用 " + applied + " 处 · " + describeScope() + note + detail,
        "Applied " + applied + " · " + describeScope() + note + detail), false);
      setStatus(t("已应用曲线", "Curve applied"));

      /* 重读一次：灰色参考要反映 AE 的真实值。
         不假设 AE 接受了我们的数（它可能钳位或规范化）。 */
      refreshSnap();
    });
  }

  /**
   * 把 skipped 数组归成一句人话。
   *
   * AE 侧的 skipped 是重复出现的原因码（failed / roving / edge / loc_missing /
   * key_out_of_range），直接数总数说明不了问题 —— 「跳过 8 处」既可能是
   * 端点（正常），也可能是属性根本不支持缓动（要用户换属性）。
   */
  function skipNote(skipped) {
    if (!skipped || !skipped.length) return "";
    var counts = {};
    for (var i = 0; i < skipped.length; i++) {
      var k = skipped[i];
      counts[k] = (counts[k] || 0) + 1;
    }
    var parts = [];
    if (counts.failed) {
      parts.push(t(counts.failed + " 条属性不支持缓动", counts.failed + " without ease"));
    }
    if (counts.roving) parts.push(t("roving " + counts.roving, "roving " + counts.roving));
    if (counts.edge) parts.push(t("端点 " + counts.edge, "edge " + counts.edge));
    if (counts.loc_missing) {
      parts.push(t(counts.loc_missing + " 条属性已不存在", counts.loc_missing + " gone"));
    }
    if (counts.key_out_of_range) {
      parts.push(t(counts.key_out_of_range + " 处关键帧越界", counts.key_out_of_range + " out of range"));
    }
    return parts.length
      ? t("（跳过 " + parts.join("、") + "）", " (" + parts.join(", ") + " skipped)")
      : "";
  }

  function describeScope() {
    var n = st.snap && st.snap.props ? st.snap.props.length : 0;
    return t(n + " 条属性 / " + st.pendingSegs + " 段",
      n + " prop(s) / " + st.pendingSegs + " seg(s)");
  }

  function refreshSnap() {
    engine("AEV_Curve.snapshotJson()", function (text) {
      var data = deps.parse ? deps.parse(text) : null;
      if (data && data.status === "ok") st.snap = data;
      /* 快照换了，「路」能不能用也跟着变 —— 不刷新的话菜单还停在旧状态 */
      renderMode();
      draw();
    });
  }

  function setStatus(text) {
    if (deps && typeof deps.status === "function") {
      try { deps.status(text); } catch (e) {}
    }
  }

  /* ---------- 并发冲突 ---------- */

  function showConflict(data) {
    if (!el.conflict || !el.conflictText) return;
    el.conflictText.textContent = t(
      "“" + shortLoc(data.loc) + "” 在你调曲线期间被改过（可能是时间轴上的手动操作）。" +
        "覆盖会丢掉那处改动；放弃则保留 AE 现状。",
      "“" + shortLoc(data.loc) + "” changed while you were editing. " +
        "Overwrite discards that change; Discard keeps AE as is."
    );
    el.conflict.hidden = false;
  }

  function shortLoc(loc) {
    var parts = String(loc || "").split("|");
    return parts.length >= 2 ? parts[parts.length - 1] : String(loc || "");
  }

  function hideConflict() {
    if (el.conflict) el.conflict.hidden = true;
  }

  /** 覆盖：去掉 expect 行加 force 重发。expect 不匹配就是当初拒它的原因。 */
  function overwrite() {
    hideConflict();
    if (!st.pendingText) return;
    var lines = st.pendingText.split("\n");
    var kept = [];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("expect\t") !== 0) kept.push(lines[i]);
    }
    setBusy(true);
    send("force\n" + kept.join("\n"));
  }

  /* ============================================================
   * 七、预设网格（以曲线形式呈现）
   * ============================================================ */

  function renderPresets() {
    var box = el.presets;
    if (!box) return;
    box.textContent = "";
    var items = allPresets();
    for (var i = 0; i < items.length; i++) box.appendChild(makeChip(items[i]));
  }

  function makeChip(preset) {
    var chip = document.createElement("button");
    chip.type = "button";
    chip.className = "preset-chip";
    chip.setAttribute("data-pid", preset.id);
    chip.title = preset.builtin === false ? preset.name : t(preset.zh, preset.en);
    if (preset.id === st.preset) chip.className += " active";

    var cv = document.createElement("canvas");
    cv.width = 92;
    cv.height = 54;
    chip.appendChild(cv);

    var label = document.createElement("span");
    label.textContent = chip.title;
    chip.appendChild(label);

    chip.addEventListener("pointerdown", function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      startPresetHold(preset.id);
    });
    chip.addEventListener("pointerup", cancelPresetHold);
    chip.addEventListener("pointerleave", cancelPresetHold);
    chip.addEventListener("pointercancel", cancelPresetHold);
    chip.addEventListener("click", function (event) {
      if (st.holdTriggeredId === preset.id) {
        st.holdTriggeredId = "";
        event.preventDefault();
        return;
      }
      selectPreset(preset.id);
    });
    drawChip(cv, preset.b);
    return chip;
  }

  function startPresetHold(id) {
    cancelPresetHold();
    st.holdTimer = setTimeout(function () {
      st.holdTimer = null;
      st.holdTriggeredId = id;
      openDeletePreset(id);
    }, 650);
  }

  function cancelPresetHold() {
    if (!st.holdTimer) return;
    clearTimeout(st.holdTimer);
    st.holdTimer = null;
  }

  /** 缩略图按 y 的实际范围取景，回弹族才不会画到框外 */
  function drawChip(cv, b) {
    var ctx = cv.getContext("2d");
    var w = cv.width;
    var h = cv.height;
    ctx.clearRect(0, 0, w, h);

    var curve = { x1: b[0], y1: b[1], x2: b[2], y2: b[3] };
    var lo = Math.min(0, curve.y1, curve.y2);
    var hi = Math.max(1, curve.y1, curve.y2);
    var pad = (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;

    var padX = 7;
    var padY = 6;
    var ww = w - padX * 2;
    var hh = h - padY * 2;

    ctx.beginPath();
    for (var i = 0; i <= 28; i++) {
      var pt = bezierPoint(curve, i / 28);
      var px = padX + pt.x * ww;
      var py = padY + (1 - (pt.y - lo) / (hi - lo)) * hh;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = "#a8c6ca";
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  function selectPreset(id) {
    var preset = findPreset(id);
    if (!preset) return;
    var b = preset.b;
    st.curve = { x1: b[0], y1: b[1], x2: b[2], y2: b[3] };
    st.preset = id;
    renderPresets();
    draw();
    var name = preset.builtin === false ? preset.name : t(preset.zh, preset.en);
    setMessage(t("已选「" + name + "」，按「应用」写到 AE",
      "“" + name + "” selected — press Apply"), false);
  }

  function openSavePreset() {
    if (!el.saveDialog) return;
    el.saveDialog.hidden = false;
    if (el.presetName) {
      el.presetName.value = "";
      setTimeout(function () {
        try { el.presetName.focus(); } catch (e) {}
      }, 0);
    }
  }

  function closeSavePreset() {
    if (el.saveDialog) el.saveDialog.hidden = true;
  }

  function saveCurrentPreset() {
    var name = el.presetName ? String(el.presetName.value || "").replace(/^\s+|\s+$/g, "") : "";
    if (!name) name = t("自定义曲线", "Custom curve");
    name = name.substring(0, 24);
    var id = "custom-" + new Date().getTime().toString(36) + "-" +
      Math.floor(Math.random() * 1000000).toString(36);
    st.customPresets.push({
      id: id,
      name: name,
      builtin: false,
      b: [st.curve.x1, st.curve.y1, st.curve.x2, st.curve.y2]
    });
    saveCustomPresets();
    st.preset = id;
    closeSavePreset();
    renderPresets();
    draw();
    setMessage(t("已保存预设「" + name + "」", "Saved preset “" + name + "”"), false);
  }

  function openDeletePreset(id) {
    var preset = findPreset(id);
    if (!preset || !el.deleteDialog) return;
    st.deletePresetId = id;
    var name = preset.builtin === false ? preset.name : t(preset.zh, preset.en);
    el.deleteText.textContent = t(
      "确定删除预设「" + name + "」？",
      "Delete preset “" + name + "”?");
    el.deleteDialog.hidden = false;
  }

  function closeDeletePreset() {
    st.deletePresetId = "";
    st.holdTriggeredId = "";
    if (el.deleteDialog) el.deleteDialog.hidden = true;
  }

  function deletePreset() {
    var id = st.deletePresetId;
    if (!id) return;
    var preset = findPreset(id);
    var deletedName = preset
      ? (preset.builtin === false ? preset.name : t(preset.zh, preset.en))
      : id;
    if (isBuiltinPreset(id)) {
      if (!isDeletedPreset(id)) st.deletedPresets.push(id);
      saveDeletedPresetIds();
    } else {
      var kept = [];
      for (var i = 0; i < st.customPresets.length; i++) {
        if (st.customPresets[i].id !== id) kept.push(st.customPresets[i]);
      }
      st.customPresets = kept;
      saveCustomPresets();
    }
    if (st.preset === id) st.preset = "";
    closeDeletePreset();
    renderPresets();
    draw();
    setMessage(t("已删除预设「" + deletedName + "」",
      "Deleted preset “" + deletedName + "”"), false);
  }

  /* ============================================================
   * 八、读数、提示、模式
   * ============================================================ */

  function updateReadout() {
    if (!el.readout) return;
    if (st.mode !== "value") {
      el.readout.textContent = t("只读检查视图", "read-only");
      return;
    }
    el.readout.textContent =
      st.curve.x1.toFixed(2) + ", " + st.curve.y1.toFixed(2) + ", " +
      st.curve.x2.toFixed(2) + ", " + st.curve.y2.toFixed(2);
  }

  function updateHint() {
    if (st.msgError) return;
    if (st.drag) {
      var text = "cubic-bezier(" + st.curve.x1.toFixed(2) + ", " + st.curve.y1.toFixed(2) +
        ", " + st.curve.x2.toFixed(2) + ", " + st.curve.y2.toFixed(2) + ")";
      setMessage(text, false);
      return;
    }
    if (st.mode !== "value") {
      setMessage(t("只读：改曲线请切回「值」", "Read-only — switch back to Value to edit"), false);
      return;
    }
    setMessage(t("拖两端把手调曲线，或点下面的预设，然后按「应用」",
      "Drag a handle or pick a preset, then Apply"), false);
  }

  function renderMode() {
    if (!el.modeMenu) return;
    /* 换了属性（或换了个合成）之后「路」可能不再可用：
       停在一个画不出来的模式上比自动退回值图更糟 */
    if (st.mode === "path") {
      var cur = activeSnapProp();
      if (!(cur && cur.spatial && cur.dims >= 2)) st.mode = "value";
    }
    el.modeMenu.hidden = !st.modeMenuOpen;
    if (el.modeBtn) {
      el.modeBtn.setAttribute("aria-expanded", st.modeMenuOpen ? "true" : "false");
      el.modeBtn.textContent = st.mode === "value"
        ? t("值", "V")
        : (st.mode === "speed" ? t("速", "S") : t("路", "P"));
    }
    var items = [[el.modeValue, "value"], [el.modeSpeed, "speed"], [el.modePath, "path"]];
    for (var i = 0; i < items.length; i++) {
      var node = items[i][0];
      if (!node) continue;
      node.className = "mode-item" + (st.mode === items[i][1] ? " active" : "");
    }
    if (el.modePath) {
      var prop = activeSnapProp();
      el.modePath.disabled = !(prop && prop.spatial && prop.dims >= 2);
    }
  }

  function setMode(mode) {
    st.mode = mode;
    st.modeMenuOpen = false;
    renderMode();
    draw();
    setMessage(st.mode === "value"
      ? t("拖两端把手调曲线，或点下面的预设，然后按「应用」",
        "Drag a handle or pick a preset, then Apply")
      : t("只读：改曲线请切回「值」", "Read-only — switch back to Value to edit"), false);
  }

  /* ============================================================
   * 九、生命周期
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
    el.apply = byId("curveApply");
    el.saveOpen = byId("curvePresetSaveOpen");
    el.presets = byId("curvePresets");
    el.modeBtn = byId("curveModeBtn");
    el.modeMenu = byId("curveModeMenu");
    el.modeValue = byId("curveModeValue");
    el.modeSpeed = byId("curveModeSpeed");
    el.modePath = byId("curveModePath");
    el.conflict = byId("curveConflict");
    el.conflictText = byId("curveConflictText");
    el.saveDialog = byId("curvePresetSaveDialog");
    el.presetName = byId("curvePresetName");
    el.saveConfirm = byId("curvePresetSaveConfirm");
    el.saveCancel = byId("curvePresetSaveCancel");
    el.deleteDialog = byId("curvePresetDeleteDialog");
    el.deleteText = byId("curvePresetDeleteText");
    el.deleteConfirm = byId("curvePresetDeleteConfirm");
    el.deleteCancel = byId("curvePresetDeleteCancel");

    setBusy(false);
    st.customPresets = loadCustomPresets();
    st.deletedPresets = loadDeletedPresetIds();

    if (el.apply) el.apply.addEventListener("click", apply);
    if (el.saveOpen) el.saveOpen.addEventListener("click", openSavePreset);

    if (el.modeBtn) {
      el.modeBtn.addEventListener("click", function (event) {
        event.stopPropagation();
        st.modeMenuOpen = !st.modeMenuOpen;
        renderMode();
      });
    }
    if (el.modeValue) el.modeValue.addEventListener("click", function () { setMode("value"); });
    if (el.modeSpeed) el.modeSpeed.addEventListener("click", function () { setMode("speed"); });
    if (el.modePath) {
      el.modePath.addEventListener("click", function () {
        var prop = activeSnapProp();
        if (prop && prop.spatial && prop.dims >= 2) setMode("path");
      });
    }
    document.addEventListener("mousedown", function (event) {
      if (!st.modeMenuOpen) return;
      if (el.modeMenu && el.modeMenu.contains(event.target)) return;
      if (el.modeBtn && el.modeBtn.contains(event.target)) return;
      st.modeMenuOpen = false;
      renderMode();
    });

    if (el.canvas) el.canvas.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keydown", onKeyDown);

    if (byId("curveConflictOverwrite")) {
      byId("curveConflictOverwrite").addEventListener("click", overwrite);
    }
    if (byId("curveConflictDrop")) {
      byId("curveConflictDrop").addEventListener("click", function () {
        hideConflict();
        setMessage(t("已放弃这次写入，AE 未改动", "Discarded — AE untouched"), false);
      });
    }
    if (el.saveConfirm) el.saveConfirm.addEventListener("click", saveCurrentPreset);
    if (el.saveCancel) el.saveCancel.addEventListener("click", closeSavePreset);
    if (el.presetName) {
      el.presetName.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.keyCode === 13) {
          event.preventDefault();
          saveCurrentPreset();
        }
      });
    }
    if (el.deleteConfirm) el.deleteConfirm.addEventListener("click", deletePreset);
    if (el.deleteCancel) el.deleteCancel.addEventListener("click", closeDeletePreset);

    renderPresets();
    renderMode();
    draw();
    updateHint();

    if (window.ResizeObserver && el.stage) {
      /* 回调里 draw() 会重设画布尺寸 → 可能再次触发布局观察。
         推到下一帧再画，避免同一帧内自触发（浏览器会报 RO 循环警告）。 */
      var pending = false;
      try {
        new ResizeObserver(function () {
          if (pending) return;
          pending = true;
          window.requestAnimationFrame(function () {
            pending = false;
            draw();
          });
        }).observe(el.stage);
      } catch (e) {}
    } else {
      window.addEventListener("resize", function () { draw(); });
    }
  }

  /** 切进曲线视图时调用：不读 AE，只保证画布尺寸与预设网格是对的 */
  function enter() {
    renderPresets();
    draw();
  }

  /**
   * 语言切换后重新生成本地文案。
   *
   * HTML 上标了 data-i18n 的那部分由 i18n.js 管；这里管 JS 自己生成的：
   * 预设卡片的名字、模式按钮、应用按钮、提示语。
   */
  function relang() {
    // 清空再建：卡片的名字是创建时写进去的，不重建就换不掉
    if (el.presets) el.presets.textContent = "";
    renderPresets();
    setBusy(st.busy);
    renderMode();
    st.msg = "";
    st.msgError = false;
    draw();
    updateHint();
  }

  /** 调试/自动化用（无头浏览器实测靠它断言） */
  function snapshot() {
    var handle = null;
    var handleIn = null;
    if (st.mode === "value" && st.map) {
      handle = { x: st.map.X(st.curve.x1), y: st.map.Y(st.curve.y1) };
      handleIn = { x: st.map.X(st.curve.x2), y: st.map.Y(st.curve.y2) };
    }
    return {
      mode: st.mode,
      curve: curveCopy(st.curve),
      preset: st.preset,
      busy: st.busy,
      handle: handle,
      handleIn: handleIn,
      readout: el.readout ? el.readout.textContent : "",
      hasSnap: !!st.snap,
      snapProps: st.snap && st.snap.props ? st.snap.props.length : 0,
      presets: allPresets().length,
      chips: el.presets ? el.presets.childNodes.length : 0,
      activeChip: el.presets ? activeChipId() : "",
      message: st.msg,
      msgError: st.msgError,
      size: el.stage ? { w: el.stage.clientWidth, h: el.stage.clientHeight } : null
    };
  }

  function activeChipId() {
    for (var i = 0; i < el.presets.childNodes.length; i++) {
      var node = el.presets.childNodes[i];
      if (node.className && node.className.indexOf("active") >= 0) {
        return node.getAttribute("data-pid") || "";
      }
    }
    return "";
  }

  return {
    init: init,
    enter: enter,
    relang: relang,
    draw: draw,
    apply: apply,
    snapshot: snapshot,
    presetIds: function () {
      var out = [];
      var items = allPresets();
      for (var i = 0; i < items.length; i++) out.push(items[i].id);
      return out;
    }
  };
})();
