// ============================================================
// assets.jsx —— 标准素材
//
// 设计文档 §4.4 要求四套固定素材，一次配置长期复用。这里做成按需生成 + 会话内缓存：
//   photo  复合画面（底 + 色块 + 文字 + 高频细线）—— 默认场景，能同时体现
//          模糊、发光、变形、调色、锐化、噪波
//   text   纯文本层 —— 文本类效果专用（文本预设作用在非文本层上会静默失效）
//   solid  纯色 —— 少数只作用于纯色/背景的效果
//   shape  形状层（圆 + 星）—— 形状/描边/蒙版类
//   pattern 高对比黑白图案 —— 两层输入类（置换图/复合模糊/设置遮罩）当第二输入
//
// 为什么默认是 photo 而不是设计文档写的 solid-2d：
//   M1 实测发现纯色层上高斯模糊、锐化、噪波几乎看不出变化，
//   而多层复合素材能让绝大多数效果"看得出名堂"。这是按实测调整，不是偏离。
//
// 缓存策略：同一个 AE 会话内按 kind+size 复用同一个 comp；工程关闭后自动失效。
//
// 语法：ES3 only。
// ============================================================

var AEV_Assets = (function () {
    var VERSION = "photo-v3";
    var cache = {};

    function key(kind, size) {
        return kind + "@" + size;
    }

    /** 素材版本指纹：素材内容一变，所有基于它的缓存都必须失效 */
    function fingerprint() {
        return VERSION;
    }

    function existing(kind, size) {
        var k = key(kind, size);
        var cached = cache[k];
        if (cached && cached.item) {
            // comp 可能已被用户删除，确认还能用
            try {
                if (cached.item.numLayers >= 0) return cached.item;
            } catch (e) {}
        }
        return null;
    }

    function remember(kind, size, comp) {
        cache[key(kind, size)] = { item: comp };
        return comp;
    }

    /** 深色底 + 青色块 + 暖色块 + 文字 + 细线（高频细节） */
    function buildPhoto(size) {
        var scene = app.project.items.addComp("DE_asset_photo_" + size, size, size, 1, 1, 30);

        var bg = scene.layers.addSolid([0.055, 0.065, 0.075], "bg", size, size, 1);
        bg.moveToEnd();

        // 细线：给模糊/锐化/噪波这类效果提供高频内容，纯色块看不出这些效果
        var lineColor = [0.72, 0.76, 0.78];
        for (var i = 0; i < 5; i++) {
            var y = Math.round(size * (0.14 + i * 0.16));
            var line = scene.layers.addSolid(lineColor, "line" + i, size, 2, 1);
            line.property("ADBE Transform Group").property("ADBE Position")
                .setValue([Math.round(size * 0.5), y]);
        }

        var accentW = Math.round(size * 0.59);
        var accentH = Math.round(size * 0.35);
        var accent = scene.layers.addSolid([0.18, 0.68, 0.76], "accent", accentW, accentH, 1);
        accent.property("ADBE Transform Group").property("ADBE Position")
            .setValue([Math.round(size * 0.5), Math.round(size * 0.52)]);

        var warmSide = Math.round(size * 0.23);
        var warm = scene.layers.addSolid([0.86, 0.32, 0.18], "warm", warmSide, warmSide, 1);
        warm.property("ADBE Transform Group").property("ADBE Position")
            .setValue([Math.round(size * 0.28), Math.round(size * 0.3)]);

        var text = scene.layers.addText("AE");
        var textProp = text.property("ADBE Text Properties").property("ADBE Text Document");
        var doc = textProp.value;
        doc.fontSize = Math.round(size * 0.25);
        doc.fillColor = [0.94, 0.94, 0.92];
        textProp.setValue(doc);
        text.property("ADBE Transform Group").property("ADBE Position")
            .setValue([Math.round(size * 0.5), Math.round(size * 0.57)]);

        return scene;
    }

    function buildText(size) {
        var scene = app.project.items.addComp("DE_asset_text_" + size, size, size, 1, 1, 30);
        var bg = scene.layers.addSolid([0.07, 0.08, 0.09], "bg", size, size, 1);
        bg.moveToEnd();

        var title = scene.layers.addText("Dream");
        var titleProp = title.property("ADBE Text Properties").property("ADBE Text Document");
        var titleDoc = titleProp.value;
        titleDoc.fontSize = Math.round(size * 0.3);
        titleDoc.fillColor = [0.93, 0.94, 0.9];
        titleProp.setValue(titleDoc);
        title.property("ADBE Transform Group").property("ADBE Position")
            .setValue([Math.round(size * 0.5), Math.round(size * 0.45)]);

        var sub = scene.layers.addText("Engine");
        var subProp = sub.property("ADBE Text Properties").property("ADBE Text Document");
        var subDoc = subProp.value;
        subDoc.fontSize = Math.round(size * 0.18);
        subDoc.fillColor = [0.18, 0.68, 0.76];
        subProp.setValue(subDoc);
        sub.property("ADBE Transform Group").property("ADBE Position")
            .setValue([Math.round(size * 0.5), Math.round(size * 0.68)]);

        return scene;
    }

    function buildSolid(size) {
        var scene = app.project.items.addComp("DE_asset_solid_" + size, size, size, 1, 1, 30);
        var base = scene.layers.addSolid([0.22, 0.42, 0.5], "base", size, size, 1);
        base.moveToEnd();
        return scene;
    }

    function buildShape(size) {
        var scene = app.project.items.addComp("DE_asset_shape_" + size, size, size, 1, 1, 30);
        var bg = scene.layers.addSolid([0.06, 0.07, 0.08], "bg", size, size, 1);
        bg.moveToEnd();

        // 用纯色层 + 蒙版模拟形状，避免依赖 shape layer API 的版本差异
        var body = scene.layers.addSolid([0.18, 0.68, 0.76], "body", size, size, 1);
        var mask = body.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        var shape = mask.property("ADBE Mask Shape");
        var radius = Math.round(size * 0.32);
        shape.setValue(ellipseAt(size * 0.5, size * 0.5, radius, radius));
        return scene;
    }

    /** 高对比黑白图案：黑底 + 白色竖条 + 白色中心圆。
     *  用途是给「置换图 / 复合模糊 / 设置遮罩」这类需要第二图层的效果当输入源——
     *  它按亮度工作，所以用竖条（水平方向高频）+ 中心圆（径向过渡）两种梯度，
     *  既能看到明显的位移量，也能看到边缘软硬。
     */
    function buildPattern(size) {
        var scene = app.project.items.addComp("DE_asset_pattern_" + size, size, size, 1, 1, 30);
        var bg = scene.layers.addSolid([0, 0, 0], "black", size, size, 1);
        bg.moveToEnd();

        var barW = Math.round(size * 0.08);
        var gap = Math.round(size * 0.14);
        var x = Math.round(size * 0.06);
        var barIndex = 0;
        while (x < size - barW) {
            var bar = scene.layers.addSolid([1, 1, 1], "bar" + barIndex, barW, size, 1);
            bar.property("ADBE Transform Group").property("ADBE Position")
                .setValue([x + Math.round(barW / 2), Math.round(size * 0.5)]);
            x += barW + gap;
            barIndex++;
        }

        // 中心白圆：径向亮暗过渡，让置换/模糊后的边缘更有可读性
        var disc = scene.layers.addSolid([1, 1, 1], "disc", size, size, 1);
        var mask = disc.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        var radius = Math.round(size * 0.2);
        mask.property("ADBE Mask Shape").setValue(ellipseAt(size * 0.5, size * 0.5, radius, radius));

        return scene;
    }

    function ellipseAt(cx, cy, rx, ry) {        var k = 0.5523;
        var shape = new Shape();
        shape.vertices = [
            [cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]
        ];
        shape.inTangents = [
            [k * rx, 0], [0, k * ry], [-k * rx, 0], [0, -k * ry]
        ];
        shape.outTangents = [
            [-k * rx, 0], [0, -k * ry], [k * rx, 0], [0, k * ry]
        ];
        shape.closed = true;
        return shape;
    }

    /**
     * 取（必要时生成）指定类型的标准素材。
     * kind: "photo" | "text" | "solid" | "shape" | "pattern"
     */
    function get(kind, size) {
        var resolvedSize = size || 256;
        var resolvedKind = kind || "photo";
        var cached = existing(resolvedKind, resolvedSize);
        if (cached) return cached;

        var comp;
        if (resolvedKind === "text") comp = buildText(resolvedSize);
        else if (resolvedKind === "solid") comp = buildSolid(resolvedSize);
        else if (resolvedKind === "shape") comp = buildShape(resolvedSize);
        else if (resolvedKind === "pattern") comp = buildPattern(resolvedSize);
        else comp = buildPhoto(resolvedSize);

        return remember(resolvedKind, resolvedSize, comp);
    }

    /**
     * 新建一份独立素材（不进缓存）。
     *
     * 为什么需要：AE 会缓存嵌套合成 comp 的渲染帧。同一个素材 comp 被反复引用时，
     * 后一次渲染可能直接复用上一次的缓存帧 —— 表现为「效果明明加上了，
     * 渲出来的画面却和没加效果一模一样」（实测：singleCell 下带效果与裸素材
     * 逐像素相同）。
     *
     * 逐条渲染插件效果时，每条都用一份独立素材，保证每次都是首次求值。
     */
    function getFresh(kind, size) {
        var resolvedSize = size || 256;
        var resolvedKind = kind || "photo";
        if (resolvedKind === "text") return buildText(resolvedSize);
        if (resolvedKind === "solid") return buildSolid(resolvedSize);
        if (resolvedKind === "shape") return buildShape(resolvedSize);
        if (resolvedKind === "pattern") return buildPattern(resolvedSize);
        return buildPhoto(resolvedSize);
    }

    /** 新工程/换项目后清空缓存 */
    function clear() {
        cache = {};
    }

    return {
        VERSION: VERSION,
        fingerprint: fingerprint,
        get: get,
        getFresh: getFresh,
        clear: clear
    };
})();
