// ============================================================
// curvelib.jsx —— 关键帧曲线读写（M4）
//
// 纯数学在 engine/curve_math.js（浏览器与 ExtendScript 共用同一份），
// 本文件只负责 AE 侧的读与写：
//   读：选中属性/图层 → 关键帧快照（时间、值、插值类型、ease、空间切线、标志位）
//   写：把手拖拽结果 → setTemporalEaseAtKey / setSpatialTangentsAtKey
//
// 换算模型（设计文档 §7.2）：
//   AE 的 temporal ease 由 (speed, influence) 描述：
//     · influence = 把手水平长度占「该区间时长」的百分比（0.1 ~ 100）
//     · speed     = 把手的垂直速度（属性单位/秒）
//   值图上的三次贝塞尔控制点因此是：
//     P0 = (tA, vA)
//     P1 = (tA + infOut%·dt, vA + speedOut·infOut%·dt)
//     P2 = (tB - infIn%·dt,  vB - speedIn·infIn%·dt)
//     P3 = (tB, vB)
//   线性关键帧（speed = 弦斜率、influence = 33.33）落在弦上，看起来就是直线。
//
// 为什么内部用「斜率倍率 m」而不是直接存 speed：
//   多维属性（位置/缩放）每个维度有自己的弦斜率，但 temporal ease 本质是
//   **一条统一的时间重映射**。用 m = speed / 弦斜率 表示，就能让「同一条缓动
//   曲线作用于所有维度」在数学上自洽，写回时再按各维弦斜率还原 speed。
//   这条假设由 T5.1 标定夹具验证（tools/curve_fixture.jsx）。
//
// 语法：ES3 only。不依赖 JSON（手工拼字符串），不用 Array.prototype 扩展方法。
// ============================================================

var AEV_Curve = (function () {
    if (typeof AEV_CurveMath === "undefined") {
        throw new Error("curvelib.jsx 需要先加载 engine/curve_math.js");
    }

    var M = AEV_CurveMath;
    var VERSION = "1.0.0";

    var TYPE_LINEAR = M.TYPE_LINEAR;
    var TYPE_BEZIER = M.TYPE_BEZIER;
    var TYPE_HOLD = M.TYPE_HOLD;
    var MIN_INFLUENCE = M.MIN_INFLUENCE;
    var MAX_INFLUENCE = M.MAX_INFLUENCE;
    var CALIBRATION = M.CALIBRATION;

    // 纯函数别名：对外仍挂在 AEV_Curve 上，node 测试与面板不必知道文件拆分
    var num = M.num;
    var clamp = M.clamp;
    var isArr = M.isArr;
    var at = M.at;
    var segmentOf = M.segmentOf;
    var sampleValue = M.sampleValue;
    var speedAt = M.speedAt;
    var pathPoint = M.pathPoint;
    var easeFromHandle = M.easeFromHandle;

    /* ============================================================
     * 一、JSON 输出（手工拼，ExtendScript 无 JSON.stringify）
     * ============================================================ */

    function jstr(value) {
        var out = String(value === undefined || value === null ? "" : value);
        out = out.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        out = out.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
        return '"' + out + '"';
    }

    function jnum(value) {
        var n = num(value);
        var r = Math.round(n * 1000000) / 1000000;
        return String(r);
    }

    function jbool(value) {
        return value ? "true" : "false";
    }

    function jnumArr(list) {
        var parts = [];
        if (isArr(list)) {
            for (var i = 0; i < list.length; i++) parts.push(jnum(list[i]));
        } else {
            parts.push(jnum(list));
        }
        return "[" + parts.join(",") + "]";
    }

    function jfield(key, jsonText) {
        return jstr(key) + ":" + jsonText;
    }

    /** djb2 → base36，用作「面板快照 vs AE 现值」的乐观并发指纹 */
    function hash32(text) {
        var h = 5381;
        var s = String(text);
        for (var i = 0; i < s.length; i++) {
            h = ((h << 5) + h + s.charCodeAt(i)) % 4294967296;
        }
        return h.toString(36);
    }

    /* ============================================================
     * 二、AE 侧读
     * ============================================================ */

    /** 找当前合成。与 apply.jsx 同一套逻辑，只读不写。 */
    function isComp(item) {
        if (!item) return false;
        try {
            if (typeof CompItem !== "undefined" && item instanceof CompItem) return true;
        } catch (e) {}
        try {
            return typeof item.numLayers === "number";
        } catch (e2) {
            return false;
        }
    }

    function activeComp() {
        var active = null;
        try {
            active = app.project.activeItem;
        } catch (e) {}
        if (isComp(active)) return active;

        try {
            var items = app.project.items;
            for (var i = 1; i <= items.length; i++) {
                var item = items[i];
                if (!isComp(item)) continue;
                try {
                    if (item.selectedLayers && item.selectedLayers.length > 0) return item;
                } catch (e2) {}
            }
        } catch (e3) {}
        return null;
    }

    function valueDims(value) {
        if (isArr(value)) return value.length;
        return 1;
    }

    function valueText(value) {
        var i;
        if (isArr(value)) {
            var parts = [];
            for (i = 0; i < value.length; i++) parts.push(jnum(value[i]));
            return "[" + parts.join(",") + "]";
        }
        if (typeof value === "number") return String(value);
        if (typeof value === "boolean") return value ? "1" : "0";
        return "0";
    }

    function easeArrayText(eases) {
        var parts = [];
        if (isArr(eases)) {
            for (var i = 0; i < eases.length; i++) {
                var e = eases[i] || {};
                parts.push("[[" + jnum(e.speed) + "],[" + jnum(e.influence) + "]]");
            }
        }
        return "[" + parts.join(",") + "]";
    }

    /** 关键帧指纹：时间 / 值 / 插值类型 / 两侧 ease 全都进哈希。
     *  面板拿着它判断「我读到之后，AE 里的这段曲线有没有被别人改过」。 */
    function propSignature(prop) {
        var n = 0;
        try {
            n = prop.numKeys;
        } catch (e) {
            return "0";
        }
        var s = "";
        for (var k = 1; k <= n; k++) {
            s += jnum(prop.keyTime(k)) + ",";
            s += valueText(prop.keyValue(k)) + ",";
            s += prop.keyInInterpolationType(k) + "/" + prop.keyOutInterpolationType(k) + ",";
            s += easeArrayText(prop.keyInTemporalEase(k));
            s += easeArrayText(prop.keyOutTemporalEase(k));
        }
        return hash32(s);
    }

    function locOf(prop, comp) {
        var parts = [];
        var depth = 0;
        try {
            depth = prop.propertyDepth;
        } catch (e) {}
        for (var i = 1; i <= depth; i++) {
            try {
                var group = prop.propertyGroup(i);
                if (group && group.name) parts.push(String(group.name));
            } catch (e2) {}
        }
        var prefix = "";
        try {
            prefix = String(comp.name) + "|";
        } catch (e3) {}
        return prefix + parts.join("|") + "|" + String(prop.name);
    }

    function tangentOf(raw, dim, dims) {
        // AE 两种返回形态都见过：一维数组（每维一个偏移）或二维数组
        if (!isArr(raw)) return 0;
        var first = raw[0];
        if (isArr(first)) return num(at(at(raw, dim, 0), 0, 0));
        if (raw.length === dims) return num(raw[dim]);
        return num(raw[0]);
    }

    function easeField(eases, dim, field) {
        var e = at(eases, dim, null);
        if (!e && isArr(eases) && eases.length > 0) e = eases[0];
        if (!e) return 0;
        return num(e[field]);
    }

    function boolOf(value, dim) {
        if (isArr(value)) return !!at(value, dim, false);
        return !!value;
    }

    function keyJson(prop, k, dims) {
        var value = prop.keyValue(k);
        var inEase = null;
        var outEase = null;
        try {
            inEase = prop.keyInTemporalEase(k);
        } catch (e) {}
        try {
            outEase = prop.keyOutTemporalEase(k);
        } catch (e2) {}

        var inSpeeds = [];
        var inInfs = [];
        var outSpeeds = [];
        var outInfs = [];
        var d;
        for (d = 0; d < dims; d++) {
            inSpeeds.push(easeField(inEase, d, "speed"));
            inInfs.push(easeField(inEase, d, "influence"));
            outSpeeds.push(easeField(outEase, d, "speed"));
            outInfs.push(easeField(outEase, d, "influence"));
        }

        var inTans = [];
        var outTans = [];
        var inTanRaw = null;
        var outTanRaw = null;
        try {
            inTanRaw = prop.keyInSpatialTangent(k);
        } catch (e3) {}
        try {
            outTanRaw = prop.keyOutSpatialTangent(k);
        } catch (e4) {}
        for (d = 0; d < dims; d++) {
            inTans.push(tangentOf(inTanRaw, d, dims));
            outTans.push(tangentOf(outTanRaw, d, dims));
        }

        var auto = false, cont = false, roving = false;
        try {
            auto = boolOf(prop.keyTemporalAutoBezier(k), 0);
        } catch (e5) {}
        try {
            cont = boolOf(prop.keyTemporalContinuous(k), 0);
        } catch (e6) {}
        try {
            roving = boolOf(prop.keyRoving(k), 0);
        } catch (e7) {}

        return "{" + [
            jfield("i", String(k - 1)),
            jfield("t", jnum(prop.keyTime(k))),
            jfield("v", valueText(value)),
            jfield("in", String(num(prop.keyInInterpolationType(k)))),
            jfield("out", String(num(prop.keyOutInterpolationType(k)))),
            jfield("is", jnumArr(inSpeeds)),
            jfield("ii", jnumArr(inInfs)),
            jfield("os", jnumArr(outSpeeds)),
            jfield("oi", jnumArr(outInfs)),
            jfield("it", jnumArr(inTans)),
            jfield("ot", jnumArr(outTans)),
            jfield("ab", jbool(auto)),
            jfield("co", jbool(cont)),
            jfield("rv", jbool(roving))
        ].join(",") + "}";
    }

    function propJson(prop, loc, index, comp) {
        var numKeys = 0;
        try {
            numKeys = prop.numKeys;
        } catch (e) {}

        var dims = 1;
        try {
            dims = valueDims(prop.value);
        } catch (e2) {}

        var keys = [];
        var n = Math.max(0, numKeys);
        for (var k = 1; k <= n; k++) {
            try {
                keys.push(keyJson(prop, k, dims));
            } catch (ek) {
                keys.push("{" + jfield("i", String(k - 1)) + "," + jfield("t", "0") +
                          "," + jfield("v", "[0]") + "," + jfield("in", "3") +
                          "," + jfield("out", "3") + "}");
            }
        }

        var spatial = false;
        var separated = false;
        var vt = 0;
        try {
            spatial = !!prop.isSpatial;
        } catch (e3) {}
        try {
            separated = !!prop.dimensionsSeparated;
        } catch (e4) {}
        try {
            vt = num(prop.propertyValueType);
        } catch (e5) {}

        var groupName = "";
        try {
            var depth = prop.propertyDepth;
            if (depth > 1) groupName = String(prop.propertyGroup(depth - 1).name);
        } catch (e6) {}

        return "{" + [
            jfield("i", String(index)),
            jfield("loc", jstr(loc)),
            jfield("name", jstr(prop.name)),
            jfield("group", jstr(groupName)),
            jfield("matchName", jstr(safeMatchName(prop))),
            jfield("vt", String(vt)),
            jfield("dims", String(dims)),
            jfield("spatial", jbool(spatial)),
            jfield("sep", jbool(separated)),
            jfield("n", String(numKeys)),
            jfield("sig", jstr(propSignature(prop))),
            jfield("keys", "[" + keys.join(",") + "]")
        ].join(",") + "}";
    }

    function safeMatchName(prop) {
        try {
            return String(prop.matchName || "");
        } catch (e) {
            return "";
        }
    }

    /** 递归收图层下的动画属性（用户只选图层、没选属性时的兜底） */
    function walkGroup(group, depth, push) {
        if (!group || depth > 4) return;
        var count = 0;
        try {
            count = group.numProperties;
        } catch (e) {
            return;
        }
        for (var i = 1; i <= count; i++) {
            var child = null;
            try {
                child = group.property(i);
            } catch (e2) {
                continue;
            }
            if (!child) continue;
            var mn = safeMatchName(child);
            // 标记点不是动画属性，收进来只会干扰列表
            if (mn === "ADBE Marker") continue;
            var isGroup = false;
            try {
                isGroup = typeof child.numProperties === "number" && typeof child.numKeys !== "number";
            } catch (e3) {}
            if (isGroup) {
                walkGroup(child, depth + 1, push);
            } else {
                push(child);
            }
        }
    }

    /**
     * 收集「当前选中」的候选属性。
     *
     * 优先 comp.selectedProperties（用户在时间轴里直接点属性）；
     * 没有就看选中图层的 selectedProperties；
     * 再没有就把选中图层下所有带动画的属性递归收进来。
     * 三种路径都只读，绝不写选中态（AE 2021 给 selectedLayers 赋值会崩）。
     */
    function collect(comp) {
        var list = [];
        var seen = {};

        function push(prop) {
            if (!prop) return;
            var nk = -1;
            try {
                nk = prop.numKeys;
            } catch (e) {
                return;
            }
            if (typeof nk !== "number" || nk <= 0) return;
            var loc = locOf(prop, comp);
            if (seen[loc]) return;
            seen[loc] = true;
            list.push({ prop: prop, loc: loc });
        }

        try {
            var sp = comp.selectedProperties;
            if (sp) {
                for (var i = 0; i < sp.length; i++) push(sp[i]);
            }
        } catch (e1) {}

        if (!list.length) {
            var layers = null;
            try {
                layers = comp.selectedLayers;
            } catch (e2) {}
            for (var l = 0; layers && l < layers.length; l++) {
                var layer = layers[l];
                try {
                    var lp = layer.selectedProperties;
                    if (lp) {
                        for (var j = 0; j < lp.length; j++) push(lp[j]);
                    }
                } catch (e3) {}
                if (!list.length) walkGroup(layer, 0, push);
            }
        }

        return list;
    }

    function snapshotJson() {
        var comp = activeComp();
        if (!comp) {
            return "{" + jfield("status", jstr("error")) + "," +
                jfield("reason", jstr("no_comp")) + "}";
        }

        var list = collect(comp);
        var props = [];
        for (var i = 0; i < list.length; i++) {
            try {
                props.push(propJson(list[i].prop, list[i].loc, i, comp));
            } catch (e) {}
        }

        var time = 0;
        try {
            time = comp.time;
        } catch (e2) {}

        var version = "";
        try {
            version = String(app.version);
        } catch (e3) {}

        return "{" + [
            jfield("status", jstr("ok")),
            jfield("version", jstr(VERSION)),
            jfield("ae", jstr(version)),
            jfield("comp", jstr(String(comp.name))),
            jfield("time", jnum(time)),
            jfield("props", "[" + props.join(",") + "]")
        ].join(",") + "}";
    }

    /** 只取指纹：写回前用它做乐观并发校验（比整份快照便宜） */
    function signatureText(locsText) {
        var comp = activeComp();
        if (!comp) return "{" + jfield("status", jstr("error")) + "}";
        var list = collect(comp);
        var byLoc = {};
        for (var i = 0; i < list.length; i++) byLoc[list[i].loc] = list[i].prop;

        var lines = String(locsText || "").split("\n");
        var out = [];
        for (var j = 0; j < lines.length; j++) {
            var loc = lines[j];
            if (!loc) continue;
            var prop = byLoc[loc];
            var sig = "";
            if (prop) {
                try {
                    sig = propSignature(prop);
                } catch (e) {}
            }
            out.push("{" + jfield("loc", jstr(loc)) + "," + jfield("sig", jstr(sig)) + "}");
        }
        return "{" + jfield("status", jstr("ok")) + "," + jfield("sigs", "[" + out.join(",") + "]") + "}";
    }

    /* ============================================================
     * 三、AE 侧写
     * ============================================================ */

    var TYPE_CONST = {};

    function typeConst(code) {
        if (TYPE_CONST[code]) return TYPE_CONST[code];
        try {
            if (code === TYPE_LINEAR) return KeyframeInterpolationType.LINEAR;
            if (code === TYPE_HOLD) return KeyframeInterpolationType.HOLD;
            return KeyframeInterpolationType.BEZIER;
        } catch (e) {
            // 极少数环境没有这个全局枚举，退回文档里的数值
            if (code === TYPE_LINEAR) return 6613;
            if (code === TYPE_HOLD) return 6615;
            return 6614;
        }
    }

    function makeEase(speed, influence) {
        return new KeyframeEase(num(speed), clamp(num(influence), MIN_INFLUENCE, MAX_INFLUENCE));
    }

    /** 该键某一侧的 ease 数组（长度必须等于维度数）。
     *  入参 inf / m 都是**图表空间**的值，这里换算回 AE 的原始单位。 */
    function buildEase(keys, keyIndex, side, dims, inf, m) {
        // keyIndex 是快照里的 0 基序号
        var chord = [];
        var d;
        var dt = 0;
        var a, b;
        if (side === "out") {
            a = keys[keyIndex];
            b = keys[keyIndex + 1];
        } else {
            a = keys[keyIndex - 1];
            b = keys[keyIndex];
        }
        if (!a || !b) return null;
        dt = num(b.t) - num(a.t);
        if (dt <= 0) return null;
        for (d = 0; d < dims; d++) {
            chord.push((num(at(b.v, d, 0)) - num(at(a.v, d, 0))) / dt);
        }
        var aeInf = num(inf) / CALIBRATION.influenceScale;
        var aeM = num(m) / CALIBRATION.speedScale;
        var out = [];
        for (d = 0; d < dims; d++) {
            out.push(makeEase(aeM * chord[d], aeInf));
        }
        return out;
    }

    /** 取当前 ease 并原样重建（setTemporalEaseAtKey 要求两侧都给） */
    function currentEase(prop, aeIndex, side, dims) {
        var raw = null;
        try {
            raw = side === "in" ? prop.keyInTemporalEase(aeIndex) : prop.keyOutTemporalEase(aeIndex);
        } catch (e) {
            return null;
        }
        if (!isArr(raw) || raw.length === 0) return null;
        var out = [];
        for (var d = 0; d < dims; d++) {
            out.push(makeEase(easeField(raw, d, "speed"), easeField(raw, d, "influence")));
        }
        return out;
    }

    /**
     * 写一个键的一侧。
     *
     * 语义要点：
     *   · 拖把手隐含「这一侧改成贝塞尔」—— 线性/定格关键帧根本不吃 ease，
     *     不先把插值类型改掉，写进去的 ease 会被 AE 静默忽略。
     *   · 自动贝塞尔（keyTemporalAutoBezier）开着时 AE 会自己重算把手，
     *     脚本写的 ease 会被覆盖 → 先关掉。
     *   · roving 键的时间由 AE 自己排，写 ease 没有意义 → 直接跳过并报出来。
     */
    function writeSide(prop, keys, keyIndex, side, inf, m, dims, aeIndex) {
        if (side === "in" && keyIndex <= 0) return "edge";
        if (side === "out" && keyIndex >= keys.length - 1) return "edge";

        var roving = false;
        try {
            roving = boolOf(prop.keyRoving(aeIndex), 0);
        } catch (e) {}
        if (roving) return "roving";

        try {
            prop.setTemporalAutoBezierAtKey(aeIndex, false);
        } catch (e2) {}

        var inType = TYPE_BEZIER;
        var outType = TYPE_BEZIER;
        var inRaw = 0;
        var outRaw = 0;
        try {
            inRaw = num(prop.keyInInterpolationType(aeIndex));
            outRaw = num(prop.keyOutInterpolationType(aeIndex));
        } catch (e3) {}
        inType = inRaw === 6613 ? TYPE_LINEAR : (inRaw === 6615 ? TYPE_HOLD : TYPE_BEZIER);
        outType = outRaw === 6613 ? TYPE_LINEAR : (outRaw === 6615 ? TYPE_HOLD : TYPE_BEZIER);
        if (side === "in") inType = TYPE_BEZIER;
        else outType = TYPE_BEZIER;

        try {
            prop.setInterpolationTypeAtKey(aeIndex, typeConst(inType), typeConst(outType));
        } catch (e4) {}

        var eases = buildEase(keys, keyIndex, side, dims, inf, m);
        if (!eases) return "edge";

        var inArr = null;
        var outArr = null;
        if (side === "in") {
            inArr = eases;
            outArr = currentEase(prop, aeIndex, "out", dims);
        } else {
            inArr = currentEase(prop, aeIndex, "in", dims);
            outArr = eases;
        }
        if (!inArr || !outArr) return "edge";

        prop.setTemporalEaseAtKey(aeIndex, inArr, outArr);
        return "ok";
    }

    function writeLinear(prop, keys, keyIndex, aeIndex) {
        try {
            prop.setInterpolationTypeAtKey(aeIndex, typeConst(TYPE_LINEAR), typeConst(TYPE_LINEAR));
            return "ok";
        } catch (e) {
            return "failed";
        }
    }

    function writeTangents(prop, keys, keyIndex, side, coords, dims, aeIndex) {
        var inTans = [];
        var outTans = [];
        var i;
        for (i = 0; i < dims; i++) {
            inTans.push(0);
            outTans.push(0);
        }
        var key = keys[keyIndex];
        try {
            for (i = 0; i < dims; i++) {
                var keepIn = num(at(key.it, i, 0));
                var keepOut = num(at(key.ot, i, 0));
                var next = coords.length > i ? num(coords[i]) : 0;
                inTans[i] = side === "in" ? next : keepIn;
                outTans[i] = side === "out" ? next : keepOut;
            }
            prop.setSpatialTangentsAtKey(aeIndex, inTans, outTans);
            // 空间切线只在贝塞尔空间插值下生效
            try {
                prop.setSpatialAutoBezierAtKey(aeIndex, false);
            } catch (e2) {}
            return "ok";
        } catch (e3) {
            return "failed";
        }
    }

    var PRESETS = [
        { id: "linear", zh: "线性", en: "Linear", inf: 33.33, m: 1, sides: "both", linear: true },
        { id: "ease", zh: "缓动", en: "Easy Ease", inf: 33.33, m: 0, sides: "both" },
        { id: "ease-in", zh: "缓入", en: "Ease In", inf: 33.33, m: 0, sides: "in" },
        { id: "ease-out", zh: "缓出", en: "Ease Out", inf: 33.33, m: 0, sides: "out" },
        { id: "strong", zh: "强缓动", en: "Strong Ease", inf: 75, m: 0, sides: "both" },
        { id: "strong-in", zh: "强缓入", en: "Strong In", inf: 75, m: 0, sides: "in" },
        { id: "strong-out", zh: "强缓出", en: "Strong Out", inf: 75, m: 0, sides: "out" },
        { id: "hold", zh: "定格", en: "Hold", inf: 33.33, m: 1, sides: "both", hold: true }
    ];

    function presetById(id) {
        for (var i = 0; i < PRESETS.length; i++) {
            if (PRESETS[i].id === id) return PRESETS[i];
        }
        return null;
    }

    function presetsJson() {
        var out = [];
        for (var i = 0; i < PRESETS.length; i++) {
            out.push("{" + [
                jfield("id", jstr(PRESETS[i].id)),
                jfield("zh", jstr(PRESETS[i].zh)),
                jfield("en", jstr(PRESETS[i].en)),
                jfield("inf", jnum(PRESETS[i].inf)),
                jfield("m", jnum(PRESETS[i].m)),
                jfield("sides", jstr(PRESETS[i].sides))
            ].join(",") + "}");
        }
        return "{" + jfield("status", jstr("ok")) + "," + jfield("presets", "[" + out.join(",") + "]") + "}";
    }

    function writePreset(prop, keys, keyIndex, aeIndex, preset, dims) {
        if (!preset) return "unknown_preset";
        if (preset.linear) return writeLinear(prop, keys, keyIndex, aeIndex);
        if (preset.hold) {
            try {
                prop.setInterpolationTypeAtKey(aeIndex, typeConst(TYPE_HOLD), typeConst(TYPE_HOLD));
                return "ok";
            } catch (e) {
                return "failed";
            }
        }
        var result = "ok";
        var sides = preset.sides === "both" ? ["in", "out"] : [preset.sides];
        for (var i = 0; i < sides.length; i++) {
            var r = writeSide(prop, keys, keyIndex, sides[i], preset.inf, preset.m, dims, aeIndex);
            if (r !== "ok" && r !== "edge") result = r;
        }
        return result;
    }

    /* ============================================================
     * 四、文本协议（面板 → AE）
     *
     * 为什么不用 JSON：ExtendScript 没有 JSON.parse。整份 payload 只有几十行
     * 定长字段，用 \t 分隔比塞一个 JSON 解析器可靠得多。
     *
     * 行格式：
     *   expect\t loc \t sig
     *   force
     *   out   \t loc \t keyIndex(0基) \t influence \t m
     *   in    \t loc \t keyIndex(0基) \t influence \t m
     *   tan   \t loc \t keyIndex(0基) \t side(in|out) \t x \t y \t z
     *   linear\t loc \t keyIndex(0基)
     *   preset\t loc \t keyIndex(0基) \t presetId
     * ============================================================ */

    function speedsOf(prop, k, side, dims) {
        var raw = null;
        var out = [];
        try {
            raw = side === "in" ? prop.keyInTemporalEase(k) : prop.keyOutTemporalEase(k);
        } catch (e) {}
        for (var d = 0; d < dims; d++) out.push(easeField(raw, d, "speed"));
        return out;
    }

    function infsOf(prop, k, side, dims) {
        var raw = null;
        var out = [];
        try {
            raw = side === "in" ? prop.keyInTemporalEase(k) : prop.keyOutTemporalEase(k);
        } catch (e) {}
        for (var d = 0; d < dims; d++) out.push(easeField(raw, d, "influence"));
        return out;
    }

    function tangentsOf(prop, k, side, dims) {
        var raw = null;
        var out = [];
        try {
            raw = side === "in" ? prop.keyInSpatialTangent(k) : prop.keyOutSpatialTangent(k);
        } catch (e) {}
        for (var d = 0; d < dims; d++) out.push(tangentOf(raw, d, dims));
        return out;
    }

    function parseKeyFromSnapshot(prop, dims) {
        var keys = [];
        var n = 0;
        try {
            n = prop.numKeys;
        } catch (e) {
            return keys;
        }
        for (var k = 1; k <= n; k++) {
            keys.push({
                t: prop.keyTime(k),
                v: prop.keyValue(k),
                in: num(prop.keyInInterpolationType(k)),
                out: num(prop.keyOutInterpolationType(k)),
                is: speedsOf(prop, k, "in", dims),
                ii: infsOf(prop, k, "in", dims),
                os: speedsOf(prop, k, "out", dims),
                oi: infsOf(prop, k, "out", dims),
                it: tangentsOf(prop, k, "in", dims),
                ot: tangentsOf(prop, k, "out", dims)
            });
        }
        return keys;
    }

    /**
     * 执行面板下发的写操作（不含 undo 组，由 applyText 包住）。
     *
     * expect 行存在时做乐观并发校验：只有在「AE 现值指纹 == 面板快照指纹」
     * 时才写。AE 没有属性变化事件，这是唯一能避免静默覆盖外部改动的办法。
     * 面板选择「覆盖」时会带 force 行。
     */
    function applyTextRaw(text) {
        var comp = activeComp();
        if (!comp) {
            return "{" + jfield("status", jstr("error")) + "," + jfield("reason", jstr("no_comp")) + "}";
        }

        var list = collect(comp);
        var byLoc = {};
        var i;
        for (i = 0; i < list.length; i++) byLoc[list[i].loc] = list[i].prop;

        var lines = String(text === undefined || text === null ? "" : text).split("\n");
        var ops = [];
        var expects = {};
        var force = false;
        var j;

        for (j = 0; j < lines.length; j++) {
            var line = lines[j];
            if (!line) continue;
            var f = line.split("\t");
            var kind = f[0];
            if (kind === "force") {
                force = true;
            } else if (kind === "expect") {
                expects[f[1]] = f[2];
            } else if (kind === "out" || kind === "in" || kind === "tan" ||
                       kind === "linear" || kind === "preset") {
                ops.push(f);
            }
        }

        if (!force) {
            for (var checkLoc in expects) {
                if (!expects.hasOwnProperty(checkLoc)) continue;
                var p = byLoc[checkLoc];
                if (!p) {
                    return "{" + jfield("status", jstr("conflict")) + "," +
                        jfield("reason", jstr("loc_missing")) + "," +
                        jfield("loc", jstr(checkLoc)) + "}";
                }
                var cur = "";
                try {
                    cur = propSignature(p);
                } catch (e) {}
                if (cur !== expects[checkLoc]) {
                    return "{" + jfield("status", jstr("conflict")) + "," +
                        jfield("reason", jstr("changed")) + "," +
                        jfield("loc", jstr(checkLoc)) + "," +
                        jfield("sig", jstr(cur)) + "," +
                        jfield("expect", jstr(expects[checkLoc])) + "}";
                }
            }
        }

        var applied = 0;
        var skipped = [];
        for (j = 0; j < ops.length; j++) {
            var op = ops[j];
            var opLoc = op[1];
            var prop = byLoc[opLoc];
            if (!prop) {
                skipped.push("loc_missing");
                continue;
            }
            var dims = 1;
            try {
                dims = valueDims(prop.value);
            } catch (e2) {}
            var keys = parseKeyFromSnapshot(prop, dims);
            var keyIndex = parseInt(op[2], 10);
            if (isNaN(keyIndex) || keyIndex < 0 || keyIndex >= keys.length) {
                skipped.push("key_out_of_range");
                continue;
            }
            var aeIndex = keyIndex + 1;
            var status = "failed";

            try {
                if (op[0] === "out" || op[0] === "in") {
                    status = writeSide(prop, keys, keyIndex, op[0],
                        num(op[3]), num(op[4]), dims, aeIndex);
                } else if (op[0] === "tan") {
                    var coords = [];
                    for (var c = 4; c < op.length; c++) coords.push(num(op[c]));
                    status = writeTangents(prop, keys, keyIndex, op[3], coords, dims, aeIndex);
                } else if (op[0] === "linear") {
                    status = writeLinear(prop, keys, keyIndex, aeIndex);
                } else if (op[0] === "preset") {
                    status = writePreset(prop, keys, keyIndex, aeIndex, presetById(op[3]), dims);
                }
            } catch (e3) {
                return "{" + jfield("status", jstr("error")) + "," +
                    jfield("reason", jstr("write_failed")) + "," +
                    jfield("detail", jstr(String(e3))) + "," +
                    jfield("loc", jstr(opLoc)) + "}";
            }

            if (status === "ok") applied++;
            else skipped.push(status);
        }

        // 写回后把指纹回传给面板，面板据此更新自己的并发基线
        var sigs = [];
        for (var sigLoc in expects) {
            if (!expects.hasOwnProperty(sigLoc)) continue;
            var p2 = byLoc[sigLoc];
            var s = "";
            if (p2) {
                try {
                    s = propSignature(p2);
                } catch (e4) {}
            }
            sigs.push("{" + jfield("loc", jstr(sigLoc)) + "," + jfield("sig", jstr(s)) + "}");
        }

        var skipText = [];
        for (j = 0; j < skipped.length; j++) skipText.push(jstr(skipped[j]));

        return "{" + [
            jfield("status", jstr("ok")),
            jfield("applied", String(applied)),
            jfield("skipped", "[" + skipText.join(",") + "]"),
            jfield("sigs", "[" + sigs.join(",") + "]")
        ].join(",") + "}";
    }

    /**
     * 带 undo 组的批量写入。
     *
     * beginUndoGroup 必须与 endUndoGroup 严格配对：中途抛异常时 end 被跳过，
     * AE 之后的撤销栈都会错位。所以异常在 applyTextRaw 内部被吃掉并转成
     * 返回值，这里只负责成对调用。
     */
    function applyText(text) {
        var started = false;
        var result;
        try {
            app.beginUndoGroup("DreamEngine 曲线编辑");
            started = true;
        } catch (e0) {
            // 已有别的 undo 组开着：不强行嵌套，直接写（代价是撤销粒度变粗）
            started = false;
        }
        try {
            result = applyTextRaw(text);
        } catch (e) {
            result = "{" + jfield("status", jstr("error")) + "," +
                jfield("reason", jstr("write_exception")) + "," +
                jfield("detail", jstr(String(e))) + "}";
        }
        if (started) {
            try {
                app.endUndoGroup();
            } catch (e2) {}
        }
        return result;
    }

    /* ============================================================
     * 五、导出
     * ============================================================ */

    return {
        VERSION: VERSION,
        TYPE_LINEAR: TYPE_LINEAR,
        TYPE_BEZIER: TYPE_BEZIER,
        TYPE_HOLD: TYPE_HOLD,
        MIN_INFLUENCE: MIN_INFLUENCE,
        MAX_INFLUENCE: MAX_INFLUENCE,
        CALIBRATION: CALIBRATION,

        // 纯数学（node 测试直接用；实现见 curve_math.js）
        clamp: clamp,
        bezier1: M.bezier1,
        solveU: M.solveU,
        segmentOf: segmentOf,
        handles: M.handles,
        sampleValue: sampleValue,
        speedAt: speedAt,
        pathPoint: pathPoint,
        easeFromHandle: easeFromHandle,

        // AE 侧
        snapshotJson: snapshotJson,
        signatureText: signatureText,
        applyText: applyText,
        presetsJson: presetsJson,
        activeComp: activeComp,
        // 标定夹具用：直接 dump 某个属性，不依赖用户在时间轴上的选中态
        // （脚本改选中态在 AE 2021 上有崩溃风险，夹具一律不碰）
        dumpPropJson: propJson
    };
})();
