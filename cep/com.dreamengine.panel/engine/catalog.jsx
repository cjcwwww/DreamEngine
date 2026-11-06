// ============================================================
// catalog.jsx —— 枚举本机效果 + 抽取参数树
//
// 两件事：
//   1. getCatalogJson()：轻量枚举 app.effects（每项 matchName/displayName/category）
//      面板首屏用它，1371 条也只要几十 KB。
//   2. getParamTreeJson(matchName)：真正把效果挂到一个临时层上，遍历属性树。
//      只有这样才能拿到参数名、类型、min/max、单位、能否打关键帧。
//      配方（M2）与预设依赖检查都依赖这份数据。
//
// 参数树「存而不展示」——设计文档 §12 已明确不做参数详情抽屉，
// 它在内部只用于写配方和判断预设依赖。
//
// 语法：ES3 only。
// ============================================================

var AEV_Catalog = (function () {
    var MAX_DEPTH = 3;
    var MAX_PARAMS = 200;

    /** PropertyValueType 的数值 → 可读名。
     *  直接 String(prop.propertyValueType) 拿到的是 6417 这类数字，
     *  写配方时看不出它到底是颜色还是数值，所以这里建一张运行时映射表。
     */
    var TYPE_NAMES = null;

    function typeMap() {
        if (TYPE_NAMES) return TYPE_NAMES;
        var map = {};
        try {
            map[String(PropertyValueType.OneD)] = "OneD";
            map[String(PropertyValueType.TwoD)] = "TwoD";
            map[String(PropertyValueType.TwoD_SPATIAL)] = "TwoD_Spatial";
            map[String(PropertyValueType.ThreeD)] = "ThreeD";
            map[String(PropertyValueType.ThreeD_SPATIAL)] = "ThreeD_Spatial";
            map[String(PropertyValueType.COLOR)] = "Color";
            map[String(PropertyValueType.CUSTOM_VALUE)] = "Custom";
            map[String(PropertyValueType.MARKER)] = "Marker";
            map[String(PropertyValueType.LAYER_INDEX)] = "LayerIndex";
            map[String(PropertyValueType.MASK_INDEX)] = "MaskIndex";
            map[String(PropertyValueType.SHAPE)] = "Shape";
            map[String(PropertyValueType.TEXT_DOCUMENT)] = "TextDocument";
        } catch (e) {}
        TYPE_NAMES = map;
        return map;
    }

    function jsonString(value) {
        var out = String(value === undefined || value === null ? "" : value);
        out = out.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        out = out.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
        return '"' + out + '"';
    }

    function typeName(prop) {
        try {
            var type = prop.propertyValueType;
            if (type === undefined || type === null) return "";
            var named = typeMap()[String(type)];
            if (named) return named;
            return String(type);
        } catch (e) {
            return "";
        }
    }

    /* 会话内缓存：枚举 app.effects 要走 1371 条，是面板刷新发顿的来源之一。
       缓存到 AE 会话结束；用户点「重新扫描」时传 force=true 重建。 */
    var cacheJson = "";
    var cacheItems = null;

    function buildItems() {
        var effects = app.effects;
        var items = [];
        var total = effects.length;
        for (var i = 0; i < total; i++) {
            var effect = effects[i];
            items.push({
                matchName: String(effect.matchName || ""),
                displayName: String(effect.displayName || ""),
                category: String(effect.category || ""),
                version: String(effect.version || "")
            });
        }
        return items;
    }

    function getCatalogJson(force) {
        if (!force && cacheJson) return cacheJson;
        var items = buildItems();
        var aeVersion = String(app.version || "");
        var aeMajor = parseInt(aeVersion, 10) || 0;
        var rows = [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            rows.push(
                '{"matchName":' + jsonString(item.matchName) +
                ',"displayName":' + jsonString(item.displayName) +
                ',"category":' + jsonString(item.category) +
                ',"version":' + jsonString(item.version) + "}"
            );
        }
        cacheItems = items;
        cacheJson = '{"version":1,"aeVersion":' + jsonString(aeVersion) +
            ',"aeMajor":' + aeMajor +
            ',"count":' + items.length + ',"effects":[' + rows.join(",") + "]}";
        return cacheJson;
    }

    /** 本机是否装了某个效果（预设依赖检查用；避免整份 JSON 再解析一遍） */
    function hasEffect(matchName) {
        if (!cacheItems) getCatalogJson(false);
        if (!cacheItems) return false;
        for (var i = 0; i < cacheItems.length; i++) {
            if (cacheItems[i].matchName === matchName) return true;
        }
        return false;
    }

    /** 描述单个属性节点；组节点带 children */
    function describeProperty(prop, depth, budget) {
        if (budget.count >= MAX_PARAMS) return null;
        budget.count++;

        var node = { name: "", type: "", canAnimate: false, spatial: false, children: [] };
        try {
            node.name = String(prop.name || "");
        } catch (e1) {}
        node.type = typeName(prop);

        try {
            node.canAnimate = !!prop.canVaryOverTime;
        } catch (e2) {}
        try {
            node.spatial = !!prop.isSpatial;
        } catch (e3) {}

        try {
            node.hasMin = !!prop.hasMin;
            if (node.hasMin) node.min = prop.minValue;
        } catch (e4) {}
        try {
            node.hasMax = !!prop.hasMax;
            if (node.hasMax) node.max = prop.maxValue;
        } catch (e5) {}
        try {
            if (prop.unitsText) node.units = String(prop.unitsText);
        } catch (e6) {}

        var childCount = 0;
        try {
            childCount = prop.numProperties || 0;
        } catch (e7) {
            childCount = 0;
        }

        if (childCount > 0 && depth < MAX_DEPTH) {
            for (var i = 1; i <= childCount && budget.count < MAX_PARAMS; i++) {
                var child = null;
                try {
                    child = prop.property(i);
                } catch (e8) {
                    continue;
                }
                if (!child) continue;
                var described = describeProperty(child, depth + 1, budget);
                if (described) node.children.push(described);
            }
        }

        return node;
    }

    function toJson(node) {
        if (!node) return "null";
        var parts = [
            '"name":' + jsonString(node.name),
            '"type":' + jsonString(node.type),
            '"canAnimate":' + (node.canAnimate ? "true" : "false"),
            '"spatial":' + (node.spatial ? "true" : "false")
        ];
        if (node.hasMin) parts.push('"hasMin":true,"min":' + Number(node.min));
        if (node.hasMax) parts.push('"hasMax":true,"max":' + Number(node.max));
        if (node.units) parts.push('"units":' + jsonString(node.units));
        if (node.children && node.children.length > 0) {
            var kids = [];
            for (var i = 0; i < node.children.length; i++) {
                kids.push(toJson(node.children[i]));
            }
            parts.push('"children":[' + kids.join(",") + "]");
        }
        return "{" + parts.join(",") + "}";
    }

    /**
     * 抽取单个效果的参数树。
     * 返回 JSON 文本：{"matchName":..,"ok":true,"params":[..]} 或 {"ok":false,"reason":..}
     */
    function getParamTreeJson(matchName) {
        if (!matchName) return '{"ok":false,"reason":"empty_matchName"}';

        var comp = null;
        try {
            var project = app.project;
            comp = project.items.addComp("DE_catalog_probe", 256, 256, 1, 0.1, 30);
            var layer = comp.layers.addSolid([0.5, 0.5, 0.5], "probe", 256, 256, 1);
            var effects = layer.property("ADBE Effect Parade");
            var effect = effects.addProperty(matchName);

            var budget = { count: 0 };
            var roots = [];
            for (var i = 1; i <= effect.numProperties; i++) {
                var prop = null;
                try {
                    prop = effect.property(i);
                } catch (eProp) {
                    continue;
                }
                if (!prop) continue;
                var described = describeProperty(prop, 0, budget);
                if (described) roots.push(described);
            }

            var body = [];
            for (var r = 0; r < roots.length; r++) body.push(toJson(roots[r]));

            return '{"matchName":' + jsonString(matchName) +
                   ',"ok":true,"count":' + budget.count +
                   ',"params":[' + body.join(",") + "]}";
        } catch (e) {
            var message = e && e.message ? String(e.message) : String(e);
            return '{"matchName":' + jsonString(matchName) +
                   ',"ok":false,"reason":' + jsonString(message) + "}";
        } finally {
            try {
                if (comp) comp.remove();
            } catch (eRm) {}
        }
    }

    /** 批量抽取；matchNames 为数组，单个失败不影响其它 */
    function getParamTreesJson(matchNames) {
        var list = [];
        if (!matchNames) return '{"count":0,"items":[]}';
        for (var i = 0; i < matchNames.length; i++) {
            list.push(getParamTreeJson(matchNames[i]));
        }
        return '{"count":' + list.length + ',"items":[' + list.join(",") + "]}";
    }

    return {
        getCatalogJson: getCatalogJson,
        hasEffect: hasEffect,
        getParamTreeJson: getParamTreeJson,
        getParamTreesJson: getParamTreesJson
    };
})();
