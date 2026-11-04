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

        /* 斜率倍率 m 用**位移模长**（而非某一维的弦斜率）：
           AE 2021 实测 keyInTemporalEase 对多维属性只返回 **1 个** KeyframeEase
           （长度 2 会直接报「值数组没有 1 元素」），也就是说 temporal ease
           对所有维度只有一条曲线。对应的速度就是沿路径的模长速度
           |ΔP|/dt（一维时等于 |dv|/dt），所以 m = speed ÷ 模长速度。 */
        var mag = 0;
        for (d = 0; d < dims; d++) {
            var dv = num(at(b.v, d, 0)) - num(at(a.v, d, 0));
            mag += dv * dv;
        }
        mag = Math.sqrt(mag);
        var chordMag = dt > 0 ? mag / dt : 0;

        /* speed 的参照基准按维度分两类（实机对照结论，不是猜的）：
           · 一维属性（滑杆/不透明度/分离后的单轴）：speed 是**带符号的值速度**，
             基准取有符号弦斜率。100→30 的段上 speed=+100 会让曲线先往上冲。
           · 多维属性：speed 是**沿路径的模长速度**，基准取 |ΔP|/dt。
             夹具对照：一维用模长偏差 41px、多维用有符号弦偏差 18–21px。 */
        var baseOut = dims === 1 ? chord[dominant] : chordMag;
        var baseIn = baseOut;
        var mOut = 0;
        var mIn = 0;
        if (Math.abs(baseOut) > 1e-9) {
            mOut = num(at(a.os, dominant, 0)) * CALIBRATION.speedScale / baseOut;
            mIn = num(at(b.is, dominant, 0)) * CALIBRATION.speedScale / baseIn;
        }

        return {
            tA: num(a.t),
            tB: num(b.t),
            vA: a.v,
            vB: b.v,
            dims: dims,
            dt: dt,
            // 出发键的插值类型决定这一段怎么算
            type: num(a.tout) || TYPE_BEZIER,
            infOut: clamp(num(at(a.oi, dominant, 33.33)) * CALIBRATION.influenceScale, MIN_INFLUENCE, MAX_INFLUENCE),
            infIn: clamp(num(at(b.ii, dominant, 33.33)) * CALIBRATION.influenceScale, MIN_INFLUENCE, MAX_INFLUENCE),
            mOut: mOut,
            mIn: mIn,
            chord: chord,
            chordMag: chordMag,
            dominant: dominant,
            spatial: !!a.sp,
            tanOut: a.ot,
            tanIn: b.it
        };
    }

    /**
     * 归一化把手：纵轴用 0→1 的「进度」，与具体维度无关。
     *
     * 为什么要有这一层：temporal ease 本质是一条时间重映射，
     * 各维度的值只是被同一张进度曲线缩放。空间属性的进度还会继续喂给
     * 路径贝塞尔（见 sampleValue），所以进度必须单独算。
     */
    function normalizedHandles(seg) {
        var fo = (seg.infOut || 0) / 100;
        var fi = (seg.infIn || 0) / 100;
        return {
            p0: { x: seg.tA, y: 0 },
            p1: { x: seg.tA + seg.dt * fo, y: seg.mOut * fo },
            p2: { x: seg.tB - seg.dt * fi, y: 1 - seg.mIn * fi },
            p3: { x: seg.tB, y: 1 }
        };
    }

    /** 时刻 t 的归一化进度（0..1），已含 ease */
    function progress(seg, t) {
        if (seg.dt <= 0) return 0;
        var p = clamp((num(t) - seg.tA) / seg.dt, 0, 1);
        if (seg.type === TYPE_HOLD) return 0;
        if (seg.type === TYPE_LINEAR) return p;
        var h = normalizedHandles(seg);
        var u = solveU(h.p0.x, h.p1.x, h.p2.x, h.p3.x, num(t));
        return bezier1(h.p0.y, h.p1.y, h.p2.y, h.p3.y, u);
    }

    /** 值图上的四个控制点（某一维度） */
    function handles(seg, dim) {
        var vA = num(at(seg.vA, dim, 0));
        var vB = num(at(seg.vB, dim, 0));
        var dv = vB - vA;
        var h = normalizedHandles(seg);
        return {
            p0: { x: h.p0.x, y: vA },
            p1: { x: h.p1.x, y: vA + dv * h.p1.y },
            p2: { x: h.p2.x, y: vA + dv * h.p2.y },
            p3: { x: h.p3.x, y: vB }
        };
    }

    /**
     * 线段在时刻 t 的值（某一维度）。
     *
     * 空间属性（位置/3D 点）走的是「进度 → 路径贝塞尔」：
     * 时间决定走到路径的第几成，几何形状由空间切线决定。只按弦做线性插值
     * 会与 AE 差出 8–10%（实测），因为 AE 的采样点落在弯曲的路径上。
     */
    function sampleValue(seg, dim, t) {
        var vA = num(at(seg.vA, dim, 0));
        var vB = num(at(seg.vB, dim, 0));
        if (seg.dt <= 0) return vA;
        var p = progress(seg, t);
        if (seg.spatial && seg.dims >= 2) {
            var pt = pathPoint(seg, uAtProgress(seg, p));
            return num(at(pt, dim, vA));
        }
        if (seg.type === TYPE_HOLD) return vA;
        return vA + (vB - vA) * p;
    }

    /** 线段在时刻 t 的瞬时速度（值/秒），用于速度图 */
    function speedAt(seg, dim, t) {
        if (seg.dt <= 0) return 0;
        if (seg.type === TYPE_HOLD) return 0;
        if (seg.type === TYPE_LINEAR) {
            return (num(at(seg.vB, dim, 0)) - num(at(seg.vA, dim, 0))) / seg.dt;
        }
        if (seg.spatial && seg.dims >= 2) {
            // 路径是弯的，解析导数要连乘，直接数值微分更稳
            var h = Math.max(1e-4, seg.dt / 2000);
            var left = Math.max(seg.tA, num(t) - h);
            var right = Math.min(seg.tB, num(t) + h);
            if (right - left < 1e-9) return 0;
            return (sampleValue(seg, dim, right) - sampleValue(seg, dim, left)) / (right - left);
        }
        var nh = normalizedHandles(seg);
        var u = solveU(nh.p0.x, nh.p1.x, nh.p2.x, nh.p3.x, num(t));
        var dx = bezier1d(nh.p0.x, nh.p1.x, nh.p2.x, nh.p3.x, u);
        var dy = bezier1d(nh.p0.y, nh.p1.y, nh.p2.y, nh.p3.y, u);
        if (Math.abs(dx) < 1e-9) return 0;
        return (dy / dx) * (num(at(seg.vB, dim, 0)) - num(at(seg.vA, dim, 0)));
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
     * 空间路径的弧长表（缓存到线段对象上）。
     *
     * 为什么需要：AE 走运动路径是**按弧长**推进的，不是按贝塞尔参数。
     * 实测对照（夹具 3d-spatial）：参数法最大偏差 70px，弧长法 3.5px。
     * 一条弯路径上「时间过了一半」不等于「参数走到 0.5」。
     */
    function arcTable(seg) {
        if (seg.__arc) return seg.__arc;
        var steps = 128;   // 128 与 512 的残差相同（0.6~3.5px），取小的
        var cum = [0];
        var total = 0;
        var prev = pathPoint(seg, 0);
        for (var i = 1; i <= steps; i++) {
            var cur = pathPoint(seg, i / steps);
            var d = 0;
            for (var k = 0; k < cur.length; k++) {
                var dv = cur[k] - prev[k];
                d += dv * dv;
            }
            total += Math.sqrt(d);
            cum.push(total);
            prev = cur;
        }
        seg.__arc = { cum: cum, total: total, steps: steps };
        return seg.__arc;
    }

    /** 归一化进度 p（0..1，按弧长）→ 贝塞尔参数 u */
    function uAtProgress(seg, p) {
        if (!seg.spatial || seg.dims < 2) return p;
        var arc = arcTable(seg);
        if (arc.total <= 1e-9) return p;
        var target = clamp(p, 0, 1) * arc.total;
        var lo = 0;
        var hi = arc.cum.length - 1;
        while (lo + 1 < hi) {
            var mid = (lo + hi) >> 1;
            if (arc.cum[mid] < target) lo = mid;
            else hi = mid;
        }
        var span = arc.cum[hi] - arc.cum[lo];
        var frac = span > 1e-12 ? (target - arc.cum[lo]) / span : 0;
        return (lo + frac) / arc.steps;
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
        normalizedHandles: normalizedHandles,
        progress: progress,
        uAtProgress: uAtProgress,
        handles: handles,
        sampleValue: sampleValue,
        speedAt: speedAt,
        pathPoint: pathPoint,
        easeFromHandle: easeFromHandle
    };
})();
