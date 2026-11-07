/* ============================================================
 * curve_toolbar.js —— 曲线页工具栏与本地撤销历史
 *
 * 职责边界：
 *   · 只管按钮状态、本地历史栈和「哪一类操作要过桥」的判定；
 *   · 图的编辑与绘制在 curve.js，AE 读写由 curve.js 转给 curvelib.jsx；
 *   · 本文件不碰 AE、不碰画布、不解析协议。
 *
 * 两类操作要分清（这是整个交互的安全底线）：
 *   · 本地操作（反向、撤销、重做、重置、切模式、开关磁吸）：只改内存里的图，
 *     **绝不过桥**，因此不需要 busy，也不需要 AE 的撤销组；
 *   · AE 操作（读取、关键帧交换、冻结左/右）：必须点一次才写一次，
 *     执行期间禁用所有会改 AE 的按钮，避免连点造出两组互相覆盖的撤销。
 *
 * 语法：ES5（跑在 CEF 里）。加载时不访问 DOM，node 测试可以直接 eval。
 * ============================================================ */

var AEV_CurveToolbar = (function () {
  var LIMIT = 20;

  var st = {
    mode: "two",
    snapEnabled: false,
    busy: false,
    history: null,
    deps: null,
    page: 0,
    pageRetry: null,
    el: {}
  };

  /* ---------- 历史栈（纯函数，node 测试直接调） ---------- */

  function cloneDeep(value) {
    if (!value || typeof value !== "object") return value;
    if (Object.prototype.toString.call(value) === "[object Array]") {
      var arr = [];
      for (var i = 0; i < value.length; i++) arr.push(cloneDeep(value[i]));
      return arr;
    }
    var out = {};
    for (var k in value) {
      if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = cloneDeep(value[k]);
    }
    return out;
  }

  function createHistory(limit) {
    var cap = limit > 0 ? Math.floor(limit) : LIMIT;
    return { limit: cap, items: [], index: -1 };
  }

  /** 压栈：先砍掉「撤销之后又编辑」留下的重做尾巴，再按上限淘汰最旧的 */
  function pushHistory(history, state) {
    if (!history) return history;
    if (history.index < history.items.length - 1) {
      history.items.length = history.index + 1;
    }
    history.items.push(cloneDeep(state));
    while (history.items.length > history.limit) history.items.shift();
    history.index = history.items.length - 1;
    return history;
  }

  function undoHistory(history) {
    if (!history || history.index <= 0) return null;
    history.index -= 1;
    return cloneDeep(history.items[history.index]);
  }

  function redoHistory(history) {
    if (!history || history.index >= history.items.length - 1) return null;
    history.index += 1;
    return cloneDeep(history.items[history.index]);
  }

  function canUndo(history) {
    return !!history && history.index > 0;
  }

  function canRedo(history) {
    return !!history && history.index < history.items.length - 1;
  }

  /* ---------- DOM ---------- */

  function byId(id) {
    if (typeof document === "undefined") return null;
    try {
      return document.getElementById(id);
    } catch (e) {
      return null;
    }
  }

  function setClass(node, name, on) {
    if (!node) return;
    var cls = String(node.className || "").replace(/\s+/g, " ").replace(/^\s|\s$/g, "");
    var parts = cls ? cls.split(" ") : [];
    var kept = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] && parts[i] !== name) kept.push(parts[i]);
    }
    if (on) kept.push(name);
    node.className = kept.join(" ");
  }

  function setDisabled(node, disabled) {
    if (!node) return;
    try {
      node.disabled = !!disabled;
    } catch (e) {}
  }

  function render() {
    var el = st.el;
    setClass(el.modeTwo, "active", st.mode === "two");
    setClass(el.modeMulti, "active", st.mode === "multi");
    setClass(el.snap, "active", !!st.snapEnabled);
    if (el.modeTwo) el.modeTwo.setAttribute("aria-pressed", st.mode === "two" ? "true" : "false");
    if (el.modeMulti) el.modeMulti.setAttribute("aria-pressed", st.mode === "multi" ? "true" : "false");
    if (el.snap) el.snap.setAttribute("aria-pressed", st.snapEnabled ? "true" : "false");

    // AE 侧按钮：忙碌时一律禁用，避免复制出第二组撤销
    var aeBusy = !!st.busy;
    setDisabled(el.read, aeBusy);
    setDisabled(el.swap, aeBusy);
    setDisabled(el.freezeLeft, aeBusy);
    setDisabled(el.freezeRight, aeBusy);

    // 本地按钮：忙碌时也禁用（图正在被 AE 结果覆盖，改了也会被冲掉）
    setDisabled(el.reverse, aeBusy);
    setDisabled(el.reset, aeBusy);
    setDisabled(el.undo, aeBusy || !canUndo(st.history));
    setDisabled(el.redo, aeBusy || !canRedo(st.history));

    renderPager();
  }

  /* ---------- 交互 ---------- */

  function status(text) {
    if (st.deps && typeof st.deps.status === "function") {
      try {
        st.deps.status(text);
      } catch (e) {}
    }
  }

  function currentGraph() {
    if (st.deps && typeof st.deps.getGraph === "function") return st.deps.getGraph();
    return null;
  }

  function setGraphState(state) {
    if (!state) return;
    if (st.deps && typeof st.deps.setGraph === "function") st.deps.setGraph(state);
    render();
  }

  /** 本地编辑前手动记一笔：撤销只回溯图的形状，不回溯 AE 状态 */
  function record() {
    var graph = currentGraph();
    if (!graph) return;
    pushHistory(st.history, { graph: cloneDeep(graph), mode: st.mode });
    render();
  }

  function setMode(mode) {
    st.mode = mode === "multi" ? "multi" : "two";
    if (st.deps && typeof st.deps.setMode === "function") {
      try {
        st.deps.setMode(st.mode);
      } catch (e) {}
    }
    render();
  }

  function setSnap(enabled) {
    st.snapEnabled = !!enabled;
    if (st.deps && typeof st.deps.setSnap === "function") {
      try {
        st.deps.setSnap(st.snapEnabled);
      } catch (e) {}
    }
    render();
  }

  function setBusy(flag) {
    st.busy = !!flag;
    render();
  }

  /* ---------- 分页：工具栏按钮定宽，超出就翻页，永不挤出面板 ---------- */

  /** 当前每页能放多少、最多能翻到第几页。量不到宽度时返回 null（还没布局完） */
  function pageMetrics() {
    var vp = st.el.viewport;
    var track = st.el.track;
    if (!vp || !track) return null;
    var view = vp.clientWidth;
    var total = track.scrollWidth;
    if (!view || !total) return null;
    var overflow = Math.max(0, total - view);
    return {
      view: view,
      overflow: overflow,
      maxPage: overflow <= 0 ? 0 : Math.ceil(overflow / view)
    };
  }

  function renderPager() {
    var m = pageMetrics();
    var track = st.el.track;
    if (!m || !track) {
      /* 页签刚切回来时视图可能还没宽度，量不到就下一帧再量一次 */
      if (!st.pageRetry) {
        st.pageRetry = setTimeout(function () {
          st.pageRetry = null;
          renderPager();
        }, 60);
      }
      return;
    }
    if (st.page > m.maxPage) st.page = m.maxPage;
    if (st.page < 0) st.page = 0;
    var offset = Math.min(st.page * m.view, m.overflow);
    track.style.transform = offset ? "translateX(-" + offset + "px)" : "";
    /* 不溢出时让按钮居中（左右留白相等）；溢出时才左对齐，翻页位移才对得上 */
    if (st.el.viewport) {
      if (m.overflow > 0) st.el.viewport.classList.add("is-overflowing");
      else st.el.viewport.classList.remove("is-overflowing");
    }
    if (st.el.prev) st.el.prev.disabled = st.page <= 0;
    if (st.el.next) st.el.next.disabled = st.page >= m.maxPage;
  }

  function pageBy(delta) {
    var m = pageMetrics();
    if (!m) return;
    var next = st.page + delta;
    if (next < 0) next = 0;
    if (next > m.maxPage) next = m.maxPage;
    if (next === st.page) return;
    st.page = next;
    renderPager();
  }

  function resetPage() {
    st.page = 0;
    renderPager();
  }

  function bind() {
    var el = st.el;
    el.toolbar = byId("curveToolbar");
    el.viewport = byId("curveToolbarViewport");
    el.track = byId("curveToolbarTrack");
    el.prev = byId("curveToolbarPrev");
    el.next = byId("curveToolbarNext");
    el.modeTwo = byId("curveModeTwo");
    el.modeMulti = byId("curveModeMulti");
    el.read = byId("curveRead");
    el.reverse = byId("curveReverse");
    el.swap = byId("curveSwap");
    el.freezeLeft = byId("curveFreezeLeft");
    el.freezeRight = byId("curveFreezeRight");
    el.snap = byId("curveSnap");
    el.undo = byId("curveUndo");
    el.redo = byId("curveRedo");
    el.reset = byId("curveReset");

    if (el.modeTwo) el.modeTwo.addEventListener("click", function () { setMode("two"); });
    if (el.modeMulti) el.modeMulti.addEventListener("click", function () { setMode("multi"); });
    if (el.prev) el.prev.addEventListener("click", function () { pageBy(-1); });
    if (el.next) el.next.addEventListener("click", function () { pageBy(1); });
    window.addEventListener("resize", function () { renderPager(); });
    if (el.snap) {
      el.snap.addEventListener("click", function () { setSnap(!st.snapEnabled); });
    }

    if (el.read) {
      el.read.addEventListener("click", function () {
        if (st.busy) return;
        if (st.deps && typeof st.deps.readCurrent === "function") st.deps.readCurrent();
      });
    }

    if (el.reverse) {
      el.reverse.addEventListener("click", function () {
        if (st.busy) return;
        record();
        if (st.deps && typeof st.deps.reverseLocal === "function") st.deps.reverseLocal();
        render();
      });
    }

    if (el.swap) {
      el.swap.addEventListener("click", function () {
        if (st.busy) return;
        if (st.deps && typeof st.deps.swapKeys === "function") st.deps.swapKeys();
      });
    }
    if (el.freezeLeft) {
      el.freezeLeft.addEventListener("click", function () {
        if (st.busy) return;
        if (st.deps && typeof st.deps.freezeLeft === "function") st.deps.freezeLeft();
      });
    }
    if (el.freezeRight) {
      el.freezeRight.addEventListener("click", function () {
        if (st.busy) return;
        if (st.deps && typeof st.deps.freezeRight === "function") st.deps.freezeRight();
      });
    }

    if (el.undo) {
      el.undo.addEventListener("click", function () {
        if (st.busy) return;
        var state = undoHistory(st.history);
        if (!state) {
          status("没有可撤销的本地改动");
          render();
          return;
        }
        setGraphState(state);
        status("已撤销一步本地改动");
      });
    }
    if (el.redo) {
      el.redo.addEventListener("click", function () {
        if (st.busy) return;
        var state = redoHistory(st.history);
        if (!state) {
          status("没有可重做的改动");
          render();
          return;
        }
        setGraphState(state);
        status("已重做一步本地改动");
      });
    }
    if (el.reset) {
      el.reset.addEventListener("click", function () {
        if (st.busy) return;
        record();
        if (st.deps && typeof st.deps.resetGraph === "function") st.deps.resetGraph();
        render();
      });
    }
  }

  function init(options) {
    st.deps = options || {};
    st.history = createHistory(LIMIT);
    st.mode = options && options.mode === "multi" ? "multi" : "two";
    st.snapEnabled = !!(options && options.snapEnabled);
    st.busy = false;
    if (typeof document !== "undefined") {
      bind();
      render();
    }
  }

  function snapshot() {
    return {
      mode: st.mode,
      canUndo: canUndo(st.history),
      canRedo: canRedo(st.history),
      snapEnabled: !!st.snapEnabled
    };
  }

  return {
    LIMIT: LIMIT,
    createHistory: createHistory,
    pushHistory: pushHistory,
    undoHistory: undoHistory,
    redoHistory: redoHistory,
    canUndo: canUndo,
    canRedo: canRedo,
    cloneDeep: cloneDeep,

    init: init,
    render: render,
    record: record,
    setBusy: setBusy,
    setMode: setMode,
    setSnap: setSnap,
    snapshot: snapshot,
    resetPage: resetPage,
    pageBy: pageBy
  };
})();
