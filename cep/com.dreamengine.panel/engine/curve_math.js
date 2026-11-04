// ============================================================
// curve_math.js —— 曲线纯数学（M4），浏览器与 ExtendScript 共用
//
// 为什么单独一个文件而不是塞进 curvelib.jsx：
//   面板拖拽时要**逐帧重绘**，不可能每动一下鼠标就过一趟 AE 的 evalScript。
//   但两份实现（面板一份、引擎一份）一定会漂移 —— 这是这类项目最常见的
//   隐性 bug 来源。所以数学只写一次，两个运行时加载同一个文件：
//     · CEP 面板：<script src="engine/curve_math.js">
//     · ExtendScript：$.evalFile(engine/curve_math.js)（bridge 的加载清单里）
//   本文件必须保持 ES3 语法（es3check 会单独检查它）。
//
// 职责边界：只有纯函数，不碰 app / File / 任何 AE 对象。
// AE 数据读写一律在 curvelib.jsx。
//
// 换算模型说明见 curvelib.jsx 顶部。
// ============================================================

var AEV_CurveMath = (function () {
    var TYPE_LINEAR = 1;
    var TYPE_BEZIER = 2;
    var TYPE_HOLD = 3;

    var MIN_INFLUENCE = 0.1;
    var MAX_INFLUENCE = 100;

    /* 拖拽时 m 的上下限：AE 的 speed 可以很大，但面板上把手长度有限，
       超出这个范围拖不动也画不下，钳住避免出现退化的把手。 */
    var MIN_M = -6;
    var MAX_M = 6;

    /* 标定系数：由 tools/check_curve_calibration.mjs 依据实机夹具结果回填。
       语义统一为「AE 原始值 → 图表空间」的乘数，写回时反除：
         influence_graph = influence_ae × influenceScale
         m_graph         = speed_ae × speedScale ÷ 弦斜率
       1.0 = 完全按文档语义计算。 */
    var CALIBRATION = {
        influenceScale: 1,
        speedScale: 1
    };

    function num(value) {
        var n = Number(value);
        return isNaN(n) || !isFinite(n) ? 0 : n;
    }

    function clamp(value, lo, hi) {
        var n = num(value);
        if (n < lo) return lo;
        if (n > hi) return hi;
        return n;
    }

    function isArr(value) {
        return !!value && typeof value === "object" && typeof value.length === "number";
    }

    /** 数组取第 i 项；越界时退回第 0 项（AE 对多维属性的 ease 数组长度
     *  在「未分离 / 已分离」两种状态下不一样，退到第 0 项比报错好）。 */
    function at(list, index, fallback) {
        if (!isArr(list)) return fallback;
        if (index >= 0 && index < list.length) return list[index];
        if (list.length > 0) return list[0];
        return fallback;
    }

    /** 一次三次贝塞尔（单轴） */
    function bezier1(p0, p1, p2, p3, t) {
        var mt = 1 - t;
        var a = mt * mt * mt;
        var b = 3 * mt * mt * t;
        var c = 3 * mt * t * t;
        var d = t * t * t;
        return a * p0 + b * p1 + c * p2 + d * p3;
    }

    /** 一次导数（单轴） */
    function bezier1d(p0, p1, p2, p3, t) {
        var mt = 1 - t;
        return 3 * mt * mt * (p1 - p0) + 6 * mt * t * (p2 - p1) + 3 * t * t * (p3 - p2);
    }

    /**
     * 已知 x 求参数 u。
     *
     * 先牛顿迭代（收敛快），失败再二分。把手水平长度被 influence 限在区间内，
     * x(u) 单调不减，所以二分永远有解 —— 这一步不能省：牛顿在把手接近
     * 区间端点（influence=100）时会震荡。
     */
    function solveU(x0, x1, x2, x3, x) {
        var span = x3 - x0;
        if (span <= 0) return 0;
        var u = clamp((x - x0) / span, 0, 1);
        var i, dx, d;
        for (i = 0; i < 12; i++) {
            dx = bezier1(x0, x1, x2, x3, u) - x;
            if (Math.abs(dx) < 1e-9) return u;
            d = bezier1d(x0, x1, x2, x3, u);
            if (Math.abs(d) < 1e-9) break;
            u -= dx / d;
            if (u < 0) u = 0;
            if (u > 1) u = 1;
        }
        var lo = 0, hi = 1, mid;
        for (i = 0; i < 40; i++) {
            mid = (lo + hi) / 2;
            dx = bezier1(x0, x1, x2, x3, mid) - x;
            if (Math.abs(dx) < 1e-9) return mid;
            if (dx > 0) hi = mid; else lo = mid;
        }
        return (lo + hi) / 2;
    }

    /**
     * 由两个相邻关键帧构造线段模型。
     *
     * keys 是快照里的关键帧数组（plain object）：
     *   {t, v:[...], in, out, os:[], oi:[], is:[], ii:[], ot:[], it:[]}
     *   os/oi = keyOutTemporalEase 的 speed/influence（该键出发的那一段）
     *   is/ii = keyInTemporalEase（进入该键的那一段）
     */
    function segmentOf(keys, index) {
        if (!isArr(keys) || index < 0 || index + 1 >= keys.length) return null;
        var a = keys[index];
        var b = keys[index + 1];
        var dims = Math.max(isArr(a.v) ? a.v.length : 1, isArr(b.v) ? b.v.length : 1);

        var dt = num(b.t) - num(a.t);
        var chord = [];
        var dominant = 0;
        var best = -1;
        var d, c;

        for (d = 0; d < dims; d++) {
            c = dt > 0 ? (num(at(b.v, d, 0)) - num(at(a.v, d, 0))) / dt : 0;
            chord.push(c);
            if (Math.abs(c) > best) {
                best = Math.abs(c);
                dominant = d;
            }
        }

        // 弦斜率为 0（值不变）时 speed 必然为 0，把手水平；m 没有意义，记 0
        var mOut = 0;
        var mIn = 0;
        if (best > 1e-9) {
            mOut = num(at(a.os, dominant, 0)) * CALIBRATION.speedScale / chord[dominant];
            mIn = num(at(b.is, dominant, 0)) * CALIBRATION.speedScale / chord[dominant];
        }

        return {
            tA: num(a.t),
            tB: num(b.t),
            vA: a.v,
            vB: b.v,
            dims: dims,
            dt: dt,
            // 出发键的插值类型决定这一段怎么算
            type: num(a.out) || TYPE_BEZIER,
            infOut: clamp(num(at(a.oi, dominant, 33.33)) * CALIBRATION.influenceScale, MIN_INFLUENCE, MAX_INFLUENCE),
            infIn: clamp(num(at(b.ii, dominant, 33.33)) * CALIBRATION.influenceScale, MIN_INFLUENCE, MAX_INFLUENCE),
            mOut: mOut,
            mIn: mIn,
            chord: chord,
            dominant: dominant,
            tanOut: a.ot,
            tanIn: b.it
        };
    }

    /** 值图上的四个控制点（某一维度） */
    function handles(seg, dim) {
        var vA = num(at(seg.vA, dim, 0));
        var vB = num(at(seg.vB, dim, 0));
        var dv = vB - vA;
        var fo = seg.infOut / 100;
        var fi = seg.infIn / 100;
        return {
            p0: { x: seg.tA, y: vA },
            p1: { x: seg.tA + seg.dt * fo, y: vA + seg.mOut * dv * fo },
            p2: { x: seg.tB - seg.dt * fi, y: vB - seg.mIn * dv * fi },
            p3: { x: seg.tB, y: vB }
        };
    }

    /** 线段在时刻 t 的值（某一维度） */
    function sampleValue(seg, dim, t) {
        var vA = num(at(seg.vA, dim, 0));
        var vB = num(at(seg.vB, dim, 0));
        if (seg.dt <= 0) return vA;
        var p = clamp((num(t) - seg.tA) / seg.dt, 0, 1);
        if (seg.type === TYPE_HOLD) return vA;
        if (seg.type === TYPE_LINEAR) return vA + (vB - vA) * p;
        var h = handles(seg, dim);
        var u = solveU(h.p0.x, h.p1.x, h.p2.x, h.p3.x, num(t));
        return bezier1(h.p0.y, h.p1.y, h.p2.y, h.p3.y, u);
    }

    /** 线段在时刻 t 的瞬时速度（值/秒），用于速度图 */
    function speedAt(seg, dim, t) {
        if (seg.dt <= 0) return 0;
        if (seg.type === TYPE_HOLD) return 0;
        if (seg.type === TYPE_LINEAR) {
            return (num(at(seg.vB, dim, 0)) - num(at(seg.vA, dim, 0))) / seg.dt;
        }
        var h = handles(seg, dim);
        var u = solveU(h.p0.x, h.p1.x, h.p2.x, h.p3.x, num(t));
        var dx = bezier1d(h.p0.x, h.p1.x, h.p2.x, h.p3.x, u);
        var dy = bezier1d(h.p0.y, h.p1.y, h.p2.y, h.p3.y, u);
        if (Math.abs(dx) < 1e-9) return 0;
        return dy / dx;
    }

    /**
     * 空间路径上的点（s ∈ [0,1] 为归一化进度）。
     *
     * 空间切线是**绝对偏移量**：把手 = 关键帧值 + 切线。
     * 路径形状与时间缓动是两件事：这里只算形状，进度由调用方用
     * sampleValue 的时间重映射给出（T5.10 第④条要求两者不串数据）。
     */
    function pathPoint(seg, s) {
        var u = clamp(num(s), 0, 1);
        var out = [];
        for (var d = 0; d < seg.dims; d++) {
            var vA = num(at(seg.vA, d, 0));
            var vB = num(at(seg.vB, d, 0));
            var tA = num(at(seg.tanOut, d, 0));
            var tB = num(at(seg.tanIn, d, 0));
            out.push(bezier1(vA, vA + tA, vB + tB, vB, u));
        }
        return out;
    }

    /**
     * 把手拖到 (handleTime, handleValue) 后的 ease 参数。
     *
     * side  = "out"（该键出发的把手）| "in"（进入该键的把手）
     * 返回 {inf, m}，都是**图表空间**的值：
     *   inf = 把手水平长度 / 该段时长 × 100，钳在 [0.1, 100]
     *   m   = 斜率倍率（相对弦），值不变时恒为 0
     */
    function easeFromHandle(seg, side, dim, handleTime, handleValue) {
        if (!seg || seg.dt <= 0) return { inf: 33.33, m: 0 };
        var vA = num(at(seg.vA, dim, 0));
        var vB = num(at(seg.vB, dim, 0));
        var dv = vB - vA;
        var inf, m;

        if (side === "in") {
            inf = ((seg.tB - num(handleTime)) / seg.dt) * 100;
            inf = clamp(inf, MIN_INFLUENCE, MAX_INFLUENCE);
            if (Math.abs(dv) < 1e-9) {
                m = 0;
            } else {
                m = (vB - num(handleValue)) / (dv * (inf / 100));
            }
        } else {
            inf = ((num(handleTime) - seg.tA) / seg.dt) * 100;
            inf = clamp(inf, MIN_INFLUENCE, MAX_INFLUENCE);
            if (Math.abs(dv) < 1e-9) {
                m = 0;
            } else {
                m = (num(handleValue) - vA) / (dv * (inf / 100));
            }
        }
        return { inf: inf, m: clamp(m, MIN_M, MAX_M) };
    }

    return {
        TYPE_LINEAR: TYPE_LINEAR,
        TYPE_BEZIER: TYPE_BEZIER,
        TYPE_HOLD: TYPE_HOLD,
        MIN_INFLUENCE: MIN_INFLUENCE,
        MAX_INFLUENCE: MAX_INFLUENCE,
        MIN_M: MIN_M,
        MAX_M: MAX_M,
        CALIBRATION: CALIBRATION,

        num: num,
        clamp: clamp,
        isArr: isArr,
        at: at,
        bezier1: bezier1,
        bezier1d: bezier1d,
        solveU: solveU,
        segmentOf: segmentOf,
        handles: handles,
        sampleValue: sampleValue,
        speedAt: speedAt,
        pathPoint: pathPoint,
        easeFromHandle: easeFromHandle
    };
})();
