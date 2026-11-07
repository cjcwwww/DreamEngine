// ============================================================
// curve_graph.js —— 多点曲线图的纯模型（XLFlow 特征），
// 浏览器与 ExtendScript 共用同一份实现
//
// 为什么单独一层：
//   · 面板要逐帧重绘、拖拽时不能过桥，所以图的编辑必须在浏览器侧算完；
//   · AE 侧应用时又要用同一套几何（节点 → 关键帧 → ease），否则两边会漂移。
//   与 curve_math.js 一样，数学只写一次，两个运行时加载同一个文件：
//     · CEP 面板：<script src="engine/curve_graph.js">
//     · ExtendScript：bridge 的 ENGINE_FILES 里 $.evalFile
//
// 职责边界：纯数据结构 + 纯函数。不碰 app / File / DOM / localStorage。
// 读写 AE 的一切都在 curvelib.jsx。
//
// 图的规范形状（version 2）：
//   {
//     version: 2,
//     kind: "dreamengine-curve-graph",
//     propertyMode: "numeric",
//     nodes: [
//       { id, role: "endpoint"|"middle", t, v,
//         inHandle:  { dt, dv } | null,
//         outHandle: { dt, dv } | null }
//     ]
//   }
//   t / v 归一化到 0..1；中间节点的把手 dt 是相对该节点的时间偏移。
//   两节点图与旧的 cubic-bezier(x1,y1,x2,y2) 一一对应：
//     x1 = start.outHandle.dt, y1 = start.outHandle.dv
//     x2 = 1 + end.inHandle.dt, y2 = 1 + end.inHandle.dv
//
// 语法：ES3 only（与 curve_math.js 同一套限制），不用 JSON / 数组扩展方法。
// ============================================================

var AEV_CurveGraph = (function () {
    if (typeof AEV_CurveMath === "undefined") {
        throw new Error("curve_graph.js 需要先加载 engine/curve_math.js");
    }

    var num = AEV_CurveMath.num;
    var clamp = AEV_CurveMath.clamp;

    var VERSION = 2;
    var KIND = "dreamengine-curve-graph";
    var EPS = 0.0001;
    /* 编辑时留的间隙要比 EPS 大一倍：0.3001 - 0.3 在浮点里是 0.00009999999998，
       刚好卡在判据下面，会被 normalize 判成「节点重叠」。 */
    var GAP = 0.0002;
    var ID_RE = /[^A-Za-z0-9_]/g;

    /* ---------- 基础工具 ---------- */

    function isArr(value) {
        return !!value && typeof value === "object" && typeof value.length === "number";
    }

    /** 有限数字判定：NaN / Infinity / 字符串垃圾一律视为无效 */
    function finite(value) {
        var n = Number(value);
        return !isNaN(n) && isFinite(n);
    }

    function round4(value) {
        return Math.round(num(value) * 10000) / 10000;
    }

    /** 线上格式用固定四位小数，避免 0.33000000000000007 这种噪声 */
    function fmt4(value) {
        return round4(value).toFixed(4);
    }

    function cleanId(raw, fallback) {
        var s = String(raw === undefined || raw === null ? "" : raw).replace(ID_RE, "_");
        return s ? s : fallback;
    }

    function handleOf(raw) {
        if (!raw) return null;
        if (!finite(raw.dt) || !finite(raw.dv)) return null;
        return { dt: round4(raw.dt), dv: round4(raw.dv) };
    }

    function copyNode(node) {
        return {
            id: node.id,
            role: node.role,
            t: node.t,
            v: node.v,
            inHandle: node.inHandle ? { dt: node.inHandle.dt, dv: node.inHandle.dv } : null,
            outHandle: node.outHandle ? { dt: node.outHandle.dt, dv: node.outHandle.dv } : null
        };
    }

    /* ---------- 克隆与规范化 ---------- */

    function clone(graph) {
        if (!graph || !isArr(graph.nodes)) return null;
        var nodes = [];
        for (var i = 0; i < graph.nodes.length; i++) {
            var n = graph.nodes[i];
            if (!n) return null;
            nodes.push({
                id: String(n.id),
                role: String(n.role),
                t: num(n.t),
                v: num(n.v),
                inHandle: n.inHandle ? { dt: num(n.inHandle.dt), dv: num(n.inHandle.dv) } : null,
                outHandle: n.outHandle ? { dt: num(n.outHandle.dt), dv: num(n.outHandle.dv) } : null
            });
        }
        return {
            version: num(graph.version),
            kind: String(graph.kind),
            propertyMode: String(graph.propertyMode || "numeric"),
            nodes: nodes
        };
    }

    /** 按 t 升序排（插入排序：节点个位数，稳定且 ES3 无负担） */
    function sortNodes(nodes) {
        for (var i = 1; i < nodes.length; i++) {
            var cur = nodes[i];
            var j = i - 1;
            while (j >= 0 && nodes[j].t > cur.t) {
                nodes[j + 1] = nodes[j];
                j--;
            }
            nodes[j + 1] = cur;
        }
        return nodes;
    }

    /**
     * 校验并规范化一张图。
     *
     * 规则（任何一条不满足就返回 null，调用方据此拒绝整块数据）：
     *   · version 必须是 2，kind 必须匹配；
     *   · 至少两个节点，端点 t 必须落在 0 与 1，中间节点严格在两者之间；
     *   · 相邻节点的时间差不得小于 0.0001（否则写回 AE 会造出重叠关键帧）；
     *   · id 只保留 [A-Za-z0-9_]，重复时自动加后缀；
     *   · 端点不允许有朝外的把手（起点 inHandle、终点 outHandle 一律清空）。
     */
    function normalize(graph) {
        if (!graph || !isArr(graph.nodes)) return null;
        if (num(graph.version) !== VERSION) return null;
        if (String(graph.kind) !== KIND) return null;
        if (graph.nodes.length < 2) return null;

        var nodes = [];
        var seen = {};
        var i;
        for (i = 0; i < graph.nodes.length; i++) {
            var raw = graph.nodes[i];
            if (!raw) return null;
            if (!finite(raw.t) || !finite(raw.v)) return null;

            var id = cleanId(raw.id, "node_" + i);
            if (seen[id]) {
                var k = 2;
                while (seen[id + "_" + k]) k++;
                id = id + "_" + k;
            }
            seen[id] = true;

            nodes.push({
                id: id,
                role: i === 0 ? "endpoint" : (i === graph.nodes.length - 1 ? "endpoint" : "middle"),
                t: round4(clamp(raw.t, 0, 1)),
                v: round4(clamp(raw.v, 0, 1)),
                inHandle: handleOf(raw.inHandle),
                outHandle: handleOf(raw.outHandle)
            });
        }

        sortNodes(nodes);

        var last = nodes.length - 1;
        nodes[0].t = 0;
        nodes[0].role = "endpoint";
        nodes[0].inHandle = null;
        nodes[last].t = 1;
        nodes[last].role = "endpoint";
        nodes[last].outHandle = null;

        for (i = 1; i < nodes.length; i++) {
            if (nodes[i].t - nodes[i - 1].t < EPS) return null;
        }

        return {
            version: VERSION,
            kind: KIND,
            propertyMode: String(graph.propertyMode || "numeric"),
            nodes: nodes
        };
    }

    /* ---------- 与旧 cubic-bezier 互转 ---------- */

    /**
     * 旧的四元组 → 两节点图。
     * 接受数组 [x1,y1,x2,y2] 或对象 {x1,y1,x2,y2}（面板两种写法都有）。
     */
    function fromBezier(curve, propertyMode) {
        if (!curve) return null;
        var x1, y1, x2, y2;
        if (isArr(curve)) {
            x1 = curve[0]; y1 = curve[1]; x2 = curve[2]; y2 = curve[3];
        } else {
            x1 = curve.x1; y1 = curve.y1; x2 = curve.x2; y2 = curve.y2;
        }
        if (!finite(x1) || !finite(y1) || !finite(x2) || !finite(y2)) return null;

        return normalize({
            version: VERSION,
            kind: KIND,
            propertyMode: propertyMode || "numeric",
            nodes: [
                {
                    id: "start", role: "endpoint", t: 0, v: 0,
                    inHandle: null,
                    outHandle: { dt: round4(clamp(x1, 0, 1)), dv: round4(y1) }
                },
                {
                    id: "end", role: "endpoint", t: 1, v: 1,
                    inHandle: { dt: round4(clamp(x2, 0, 1) - 1), dv: round4(y2 - 1) },
                    outHandle: null
                }
            ]
        });
    }

    /** 两节点图 → 四元组；不是两节点就返回 null（多点图没有等价四元组） */
    function toBezier(graph) {
        var g = normalize(graph);
        if (!g || g.nodes.length !== 2) return null;
        var a = g.nodes[0];
        var b = g.nodes[1];
        var x1 = a.outHandle ? a.outHandle.dt : 0;
        var y1 = a.outHandle ? a.outHandle.dv : 0;
        var x2 = b.inHandle ? 1 + b.inHandle.dt : 1;
        var y2 = b.inHandle ? 1 + b.inHandle.dv : 1;
        return [round4(clamp(x1, 0, 1)), round4(y1), round4(clamp(x2, 0, 1)), round4(y2)];
    }

    /* ---------- 线上格式（面板 → AE） ---------- */

    function nodeLine(node) {
        var inDt = "-";
        var inDv = "-";
        var outDt = "-";
        var outDv = "-";
        if (node.inHandle) {
            inDt = fmt4(node.inHandle.dt);
            inDv = fmt4(node.inHandle.dv);
        }
        if (node.outHandle) {
            outDt = fmt4(node.outHandle.dt);
            outDv = fmt4(node.outHandle.dv);
        }
        return [
            "graph_node", node.id, node.role,
            fmt4(node.t), fmt4(node.v),
            inDt, inDv, outDt, outDv
        ].join("\t");
    }

    /**
     * 只输出图块（不含 expect 行）。
     * loc 为空时留空字段：脚本通道（applyGraphForPropertyJson）会自带 loc。
     */
    function encodeGraphPayload(graph, loc) {
        var g = normalize(graph);
        if (!g) return "";
        var where = loc === undefined || loc === null ? "" : String(loc);
        var lines = [];
        lines.push([
            "graph_begin", where, String(VERSION),
            KIND, g.propertyMode, String(g.nodes.length)
        ].join("\t"));
        for (var i = 0; i < g.nodes.length; i++) lines.push(nodeLine(g.nodes[i]));
        lines.push(["graph_end", where].join("\t"));
        return lines.join("\n");
    }

    /** 面板走的那条：expect 指纹 + 图块 */
    function encodeApplyLines(loc, signature, graph) {
        var where = loc === undefined || loc === null ? "" : String(loc);
        var sig = signature === undefined || signature === null ? "" : String(signature);
        return ["expect", where, sig].join("\t") + "\n" + encodeGraphPayload(graph, where);
    }

    /* ---------- 线段几何 ---------- */

    function indexOfNode(nodes, id) {
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].id === id) return i;
        }
        return -1;
    }

    /**
     * 第 index 段的归一化 cubic-bezier 四元组（x 是段内时间、y 是段内值进度）。
     *
     * 值不变（|Δv| ≈ 0）时 y 没有意义，取 y1 = 0 / y2 = 1：曲线退化成一条
     * 对角直线，进度与原时间一致 —— 这正是「值不变」应有的行为。
     */
    function segmentCurve(graph, index) {
        var g = normalize(graph);
        if (!g) return null;
        if (index < 0 || index + 1 >= g.nodes.length) return null;
        var a = g.nodes[index];
        var b = g.nodes[index + 1];
        var dt = b.t - a.t;
        if (dt <= 1e-12) return null;
        var dv = b.v - a.v;
        var flat = Math.abs(dv) <= 1e-9;

        /* 把手的 dt 夹进 [0, 1] 之外还要留一条命：dt=0 时 x=0，
           segmentEase 里 m = y/x 会退化成 0，AE 收到的是一条水平把手，
           而画出来的是竖直段 —— 这就是「曲线看着对、运动完全不对」的来源之一。
           给 x 留一个下限（对应 influence 0.2%，仍在 AE 的 0.1%..100% 内），
           陡峭就变成「很陡但有限」的斜率，画的和写回去的是同一条。 */
        var X_FLOOR = 0.002;

        var x1 = 0;
        var y1 = 0;
        var x2 = 1;
        var y2 = 1;
        if (a.outHandle) {
            x1 = clamp(a.outHandle.dt / dt, X_FLOOR, 1);
            y1 = flat ? 0 : a.outHandle.dv / dv;
        }
        if (b.inHandle) {
            x2 = clamp(1 + b.inHandle.dt / dt, 0, 1 - X_FLOOR);
            y2 = flat ? 1 : 1 + b.inHandle.dv / dv;
        }

        /* 交叉把手：out 的 x 跑到 in 的 x 右边，等价于时间上回折。
           AE 的缓动永远 x 单调，表示不出来 —— 画出来的 S 会变成另一条曲线。
           把两者在中间拉开 0.001，保证 x1 < x2（XLFlow 同样处理）。 */
        if (x2 <= x1) {
            var mid = (x1 + x2) / 2;
            x1 = clamp(mid - 0.001, X_FLOOR, 0.998);
            x2 = clamp(mid + 0.001, 0.002, 1 - X_FLOOR);
        }
        return [round4(x1), round4(y1), round4(x2), round4(y2)];
    }

    /** 段 → AE 语义的 influence / m（与 curve.js 的 bezierToEase 同一套换算） */
    function segmentEase(graph, index) {
        var c = segmentCurve(graph, index);
        if (!c) return null;
        var infOut = clamp(c[0] * 100, AEV_CurveMath.MIN_INFLUENCE, AEV_CurveMath.MAX_INFLUENCE);
        var infIn = clamp((1 - c[2]) * 100, AEV_CurveMath.MIN_INFLUENCE, AEV_CurveMath.MAX_INFLUENCE);
        var mOut = c[0] > 1e-6 ? c[1] / c[0] : 0;
        var mIn = (1 - c[2]) > 1e-6 ? (1 - c[3]) / (1 - c[2]) : 0;
        return { infOut: infOut, infIn: infIn, mOut: mOut, mIn: mIn };
    }

    /** 在时刻 t 采样，返回 [value]（数组是为了将来多维扩展时形状不变） */
    function sample(graph, t) {
        var g = normalize(graph);
        if (!g) return null;
        var time = clamp(num(t), 0, 1);
        var i = 0;
        while (i < g.nodes.length - 2 && time > g.nodes[i + 1].t) i++;
        var a = g.nodes[i];
        var b = g.nodes[i + 1];
        if (!a || !b) return null;
        var dt = b.t - a.t;
        if (dt <= 1e-12) return [a.v];
        var c = segmentCurve(g, i);
        if (!c) return [a.v];
        var x = clamp((time - a.t) / dt, 0, 1);
        var u = AEV_CurveMath.solveU(0, c[0], c[2], 1, x);
        var p = AEV_CurveMath.bezier1(0, c[1], c[3], 1, u);
        return [round4(a.v + (b.v - a.v) * p)];
    }

    /* ---------- 编辑操作 ---------- */

    /** 0.1 网格磁吸：只影响被拖拽的点，关闭时原样返回 */
    /* 磁吸步长：与画布上的 10×10 网格对齐（XLFlow 的网格数也是 0.1）。
       以前用 0.01，网格画的是 4 等分，两者对不上，看起来就像「开关没反应」。 */
    var GRID = 0.1;

    function snapPoint(t, v, enabled) {
        var tt = num(t);
        var vv = num(v);
        if (!enabled) return { t: tt, v: vv };
        return {
            /* 6 * 0.1 = 0.6000000000000001，不收敛一下会让节点落在奇怪的坐标上 */
            t: round4(Math.round(tt / GRID) * GRID),
            v: round4(Math.round(vv / GRID) * GRID)
        };
    }

    /** 插入中间节点；t 会先夹到相邻节点之间（至少留 EPS 间隙） */
    function insertNode(graph, t, v, id) {
        var g = normalize(graph);
        if (!g) return null;
        var nodes = [];
        var i;
        for (i = 0; i < g.nodes.length; i++) nodes.push(copyNode(g.nodes[i]));

        var want = clamp(num(t), EPS, 1 - EPS);
        // 找插入点：第一个 t 大于 want 的节点之前
        var at = nodes.length - 1;
        for (i = 1; i < nodes.length; i++) {
            if (nodes[i].t > want) { at = i; break; }
        }
        var prev = nodes[at - 1];
        var next = nodes[at];
        if (want - prev.t < GAP) want = prev.t + GAP;
        if (next.t - want < GAP) want = next.t - GAP;
        if (want <= prev.t || want >= next.t) return null;

        nodes.push({
            id: cleanId(id, "node_" + nodes.length),
            role: "middle",
            t: round4(want),
            v: round4(clamp(num(v), 0, 1)),
            inHandle: null,
            outHandle: null
        });
        return normalize({ version: VERSION, kind: KIND, propertyMode: g.propertyMode, nodes: nodes });
    }

    /** 删除中间节点；端点不可删 */
    function deleteNode(graph, id) {
        var g = normalize(graph);
        if (!g) return null;
        var at = indexOfNode(g.nodes, String(id));
        if (at <= 0 || at >= g.nodes.length - 1) return g;
        var nodes = [];
        for (var i = 0; i < g.nodes.length; i++) {
            if (i !== at) nodes.push(copyNode(g.nodes[i]));
        }
        return normalize({ version: VERSION, kind: KIND, propertyMode: g.propertyMode, nodes: nodes });
    }

    /** 移动节点：t 夹在相邻节点之间，v 夹在 0..1；端点不动 t */
    function moveNode(graph, id, t, v) {
        var g = normalize(graph);
        if (!g) return null;
        var at = indexOfNode(g.nodes, String(id));
        if (at < 0) return g;
        var nodes = [];
        var i;
        for (i = 0; i < g.nodes.length; i++) nodes.push(copyNode(g.nodes[i]));

        if (at > 0 && at < nodes.length - 1) {
            var lo = nodes[at - 1].t + GAP;
            var hi = nodes[at + 1].t - GAP;
            if (lo > hi) return g;
            nodes[at].t = round4(clamp(num(t), lo, hi));
            nodes[at].v = round4(clamp(num(v), 0, 1));
        } else {
            nodes[at].v = round4(clamp(num(v), 0, 1));
            nodes[at].t = at === 0 ? 0 : 1;
        }
        return normalize({ version: VERSION, kind: KIND, propertyMode: g.propertyMode, nodes: nodes });
    }

    /**
     * 拖动某个节点的把手。
     * 水平影响钳在相邻段内：朝外的把手会造出折返曲线，AE 写回也会越界。
     */
    function moveHandle(graph, id, side, dt, dv) {
        var g = normalize(graph);
        if (!g) return null;
        var at = indexOfNode(g.nodes, String(id));
        if (at < 0) return g;
        var nodes = [];
        var i;
        for (i = 0; i < g.nodes.length; i++) nodes.push(copyNode(g.nodes[i]));
        var node = nodes[at];
        var out = side === "in" ? "in" : "out";
        var ddt = num(dt);
        var ddv = num(dv);

        if (out === "out") {
            if (at >= nodes.length - 1) return g;          // 终点没有 out 把手
            var spanOut = nodes[at + 1].t - node.t;
            ddt = clamp(ddt, 0, spanOut);
            node.outHandle = { dt: round4(ddt), dv: round4(ddv) };
        } else {
            if (at <= 0) return g;                          // 起点没有 in 把手
            var spanIn = node.t - nodes[at - 1].t;
            ddt = clamp(ddt, -spanIn, 0);
            node.inHandle = { dt: round4(ddt), dv: round4(ddv) };
        }
        return normalize({ version: VERSION, kind: KIND, propertyMode: g.propertyMode, nodes: nodes });
    }

    /**
     * 曲线反向：每个相邻节点段的控制点在时间轴上左右互换，节点时间与数值不动。
     *
     * 不能把整张图旋转 180°：那会把 y1 改成 1-y2，回弹/过冲曲线会变成另一条。
     * 这里直接反转每段的 cubic-bezier 控制点：
     *   [x1,y1,x2,y2] -> [1-x2,y2,1-x1,y1]
     */
    function reverse(graph) {
        var g = normalize(graph);
        if (!g) return null;
        var nodes = [];
        var i;
        for (i = 0; i < g.nodes.length; i++) {
            nodes.push({
                id: g.nodes[i].id,
                role: g.nodes[i].role,
                t: g.nodes[i].t,
                v: g.nodes[i].v,
                inHandle: null,
                outHandle: null
            });
        }
        for (i = 0; i + 1 < g.nodes.length; i++) {
            var a = g.nodes[i];
            var b = g.nodes[i + 1];
            var c = segmentCurve(g, i);
            if (!c) return null;
            var dt = b.t - a.t;
            var dv = b.v - a.v;
            var flat = Math.abs(dv) <= 1e-9;

            nodes[i].outHandle = {
                dt: round4((1 - c[2]) * dt),
                dv: flat ? 0 : round4(c[3] * dv)
            };
            nodes[i + 1].inHandle = {
                dt: round4((1 - c[0] - 1) * dt),
                dv: flat ? 0 : round4((c[1] - 1) * dv)
            };
        }
        return normalize({
            version: VERSION,
            kind: KIND,
            propertyMode: g.propertyMode,
            nodes: nodes
        });
    }

    /**
     * 画布命中测试：先把手、后节点（把手更小、更容易被节点挡住）。
     * map 提供 X(t) / Y(v) 两个映射，radius 是像素半径。
     */
    function hitTest(graph, point, map, radius) {
        var g = normalize(graph);
        if (!g || !point || !map) return null;
        var r = num(radius) || 8;
        var r2 = r * r;
        var best = null;
        var bestD = r2;
        var i;
        var px = num(point.x);
        var py = num(point.y);

        function consider(x, y, hit) {
            var dx = px - x;
            var dy = py - y;
            var d = dx * dx + dy * dy;
            if (d <= bestD) {
                bestD = d;
                best = hit;
            }
        }

        for (i = 0; i < g.nodes.length; i++) {
            var n = g.nodes[i];
            if (n.outHandle) {
                consider(map.X(n.t + n.outHandle.dt), map.Y(n.v + n.outHandle.dv),
                    { kind: "handle", id: n.id, side: "out" });
            }
            if (n.inHandle) {
                consider(map.X(n.t + n.inHandle.dt), map.Y(n.v + n.inHandle.dv),
                    { kind: "handle", id: n.id, side: "in" });
            }
        }
        if (best) return best;

        bestD = r2;
        for (i = 0; i < g.nodes.length; i++) {
            consider(map.X(g.nodes[i].t), map.Y(g.nodes[i].v),
                { kind: "node", id: g.nodes[i].id });
        }
        return best;
    }

    return {
        VERSION: VERSION,
        KIND: KIND,
        EPS: EPS,
        GRID: GRID,

        num: num,
        clamp: clamp,
        round4: round4,
        finite: finite,

        clone: clone,
        normalize: normalize,
        fromBezier: fromBezier,
        toBezier: toBezier,

        insertNode: insertNode,
        deleteNode: deleteNode,
        moveNode: moveNode,
        moveHandle: moveHandle,
        snapPoint: snapPoint,
        sample: sample,
        reverse: reverse,
        segmentCurve: segmentCurve,
        segmentEase: segmentEase,
        hitTest: hitTest,

        encodeGraphPayload: encodeGraphPayload,
        encodeApplyLines: encodeApplyLines
    };
})();
