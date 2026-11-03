// ============================================================
// recipe.jsx —— 演示配方与启发式兜底
//
// 分两层：
//   1. 显式配方（RECIPES）：已经目视确认过"看得出名堂"的效果，按 matchName 写死参数
//   2. 启发式兜底（applyHeuristics）：没有配方的效果，按 propertyValueType 生成演示值
//
// 启发式的设计原则是「保守」而不是「激进」：
//   AE 的参数名与语义千差万别，把每个数值属性都拉到中值会让大量效果变糊、
//   变黑或直接看不出原貌。因此只处理四类语义明确的属性，并且每个效果
//   最多写 MAX_WRITES 次，宁可看着"变化不明显"也不要把效果改坏。
//
// 语法：ES3 only。
// ============================================================

var AEV_Recipe = (function () {
    var MAX_WRITES = 6;
    var MAX_DEPTH = 3;
    var PRESENTATION_TIME_RATIO = 0.5;

    /** 表达式控件族与音频族的分类名（中英文都要认，汉化版分类名是中文） */
    var NO_PREVIEW_CATEGORIES = [
        "expression controls", "表达式控制",
        "audio", "音频"
    ];

    /** 显式配方：matchName -> [{names:[...], value:...}] */
    var RECIPES = {
        "ADBE Gaussian Blur 2": [{ names: ["Blurriness", "模糊度"], value: 10 }],
        "ADBE Motion Blur": [
            { names: ["Direction", "方向"], value: 35 },
            { names: ["Blur Length", "模糊长度"], value: 40 }
        ],
        "ADBE Glo2": [
            { names: ["Glow Radius", "发光半径"], value: 24 },
            { names: ["Glow Intensity", "发光强度"], value: 1.5 }
        ],
        "ADBE Mosaic": [
            { names: ["Horizontal Blocks", "水平块"], value: 12 },
            { names: ["Vertical Blocks", "垂直块"], value: 12 }
        ],
        "CC Radial Fast Blur": [{ names: ["Amount", "数量"], value: 35 }],
        "CC Lens": [{ names: ["Size", "大小"], value: 145 }],
        "ADBE Turbulent Displace": [
            { names: ["Amount", "数量"], value: 60 },
            { names: ["Size", "大小"], value: 60 }
        ],
        "ADBE Wave Warp": [
            { names: ["Wave Height", "波形高度"], value: 30 },
            { names: ["Wave Width", "波形宽度"], value: 60 }
        ],
        "ADBE Ripple": [
            { names: ["Radius", "半径"], value: 60 },
            { names: ["Height", "高度"], value: 40 }
        ]
    };

    function lower(value) {
        return String(value === undefined || value === null ? "" : value).toLowerCase();
    }

    /** 表达式控件 / 音频族不渲图（设计文档 §4.3 的 no-preview 场景） */
    function isNoPreview(category) {
        var cat = lower(category);
        for (var i = 0; i < NO_PREVIEW_CATEGORIES.length; i++) {
            if (cat === NO_PREVIEW_CATEGORIES[i]) return true;
        }
        return false;
    }

    /** 展示时点：取合成中点，避开首帧尚未成形的效果 */
    function presentationTime(comp) {
        try {
            return comp.duration * PRESENTATION_TIME_RATIO;
        } catch (e) {
            return 0;
        }
    }

    /** 纯函数：给定属性类型与取值范围，返回启发式演示值。
     *  返回 undefined 表示"这个属性不动"，调用方必须跳过。
     *  kind: "color" | "checkbox" | "oneD" | "other"
     *
     *  ⚠️ TwoD 一律不碰（设计文档 §4.3 原本要求给"中心+偏移"，已按实测推翻）：
     *  AE 2021 上 CC 系列的 Center 等 Point 控件是 0–1 归一化坐标，赋像素值
     *  [128,128] 会触发 AE 内部脚本异常
     *    "After Effects错误: Line 1849: var center = cs.convertPoint([0.5, 0.5"
     *  而整网批量渲染是一损俱损的——一个格子报错会让整张网失败。
     *  位置类参数保持效果默认值，视觉上可能"看不出偏移"，但不会崩。
     */
    function heuristicValue(kind, minValue, maxValue, cellSize) {
        if (kind === "color") return [0.9, 0.35, 0.2];
        if (kind === "checkbox") return true;
        if (kind === "oneD") {
            if (minValue === null || minValue === undefined) return undefined;
            if (maxValue === null || maxValue === undefined) return undefined;
            return (Number(minValue) + Number(maxValue)) / 2;
        }
        return undefined;
    }

    /** 把 AE 属性的 propertyValueType 归一成上面四种 kind 之一 */
    function kindOf(prop) {
        var type = null;
        try {
            type = String(prop.propertyValueType);
        } catch (e) {
            return "other";
        }
        // PropertyValueType 的字符串化结果在不同版本可能是数字或枚举名
        if (type === "COLOR" || type === String(PropertyValueType.COLOR)) return "color";
        if (type === "CHECKBOX" || type === String(PropertyValueType.CHECKBOX)) return "checkbox";
        // TWO_D / TWO_D_SPATIAL 故意归为 other：位置类参数的单位在不同效果里
        // 可能是像素也可能是 0–1 归一化，统一赋值会踩到 AE 内部脚本异常。
        if (type === "OneD" || type === "ONE_D" || type === String(PropertyValueType.OneD)) return "oneD";
        return "other";
    }

    function setIfWritable(prop, value) {
        if (value === undefined) return false;
        try {
            prop.setValue(value);
            return true;
        } catch (e) {
            return false;
        }
    }

    function findByName(group, names) {
        var count = 0;
        try {
            count = group.numProperties;
        } catch (e) {
            return null;
        }
        for (var i = 1; i <= count; i++) {
            var prop = null;
            try {
                prop = group.property(i);
            } catch (e2) {
                continue;
            }
            if (!prop || !prop.name) continue;
            var name = String(prop.name);
            for (var n = 0; n < names.length; n++) {
                if (name === names[n]) return prop;
            }
        }
        return null;
    }

    /** 套显式配方；返回写入次数，0 表示该效果没有配方 */
    function applyRecipe(effectGroup, matchName) {
        var steps = RECIPES[matchName];
        if (!steps) return 0;
        var writes = 0;
        for (var i = 0; i < steps.length; i++) {
            var prop = findByName(effectGroup, steps[i].names);
            if (prop && setIfWritable(prop, steps[i].value)) writes++;
        }
        return writes;
    }

    /** 启发式兜底；返回写入次数 */
    function applyHeuristics(effectGroup, cellSize) {
        var budget = MAX_WRITES;
        var writes = 0;

        function walk(group, depth) {
            if (depth > MAX_DEPTH || writes >= budget) return;
            var count = 0;
            try {
                count = group.numProperties;
            } catch (e) {
                return;
            }
            for (var i = 1; i <= count && writes < budget; i++) {
                var prop = null;
                try {
                    prop = group.property(i);
                } catch (e2) {
                    continue;
                }
                if (!prop) continue;

                var childCount = 0;
                try {
                    childCount = prop.numProperties;
                } catch (e3) {
                    childCount = 0;
                }
                if (childCount && childCount > 0) {
                    walk(prop, depth + 1);
                    continue;
                }

                var kind = kindOf(prop);
                if (kind === "other") continue;

                var minValue = null;
                var maxValue = null;
                try {
                    if (prop.hasMin) minValue = prop.minValue;
                    if (prop.hasMax) maxValue = prop.maxValue;
                } catch (e4) {}

                var value = heuristicValue(kind, minValue, maxValue, cellSize);
                if (setIfWritable(prop, value)) writes++;
            }
        }

        walk(effectGroup, 0);
        return writes;
    }

    /** 统一入口：有配方走配方，没有就走启发式 */
    function apply(effectGroup, matchName, cellSize) {
        var explicitWrites = applyRecipe(effectGroup, matchName);
        if (explicitWrites > 0) {
            return { mode: "recipe", writes: explicitWrites };
        }
        var heuristicWrites = applyHeuristics(effectGroup, cellSize);
        return { mode: heuristicWrites > 0 ? "heuristic" : "none", writes: heuristicWrites };
    }

    return {
        isNoPreview: isNoPreview,
        presentationTime: presentationTime,
        heuristicValue: heuristicValue,
        applyRecipe: applyRecipe,
        applyHeuristics: applyHeuristics,
        apply: apply,
        recipes: RECIPES
    };
})();
