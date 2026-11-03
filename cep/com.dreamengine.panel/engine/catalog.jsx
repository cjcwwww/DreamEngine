// ============================================================
// catalog.jsx - enumerate effects installed in the active AE.
// ES3 / ExtendScript only.
// ============================================================

var AEV_Catalog = (function () {
    function jsonString(value) {
        var out = String(value === undefined || value === null ? "" : value);
        out = out.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        out = out.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
        return '"' + out + '"';
    }

    function getCatalogJson() {
        var effects = app.effects;
        var rows = [];
        var total = effects.length;
        for (var i = 0; i < total; i++) {
            var effect = effects[i];
            rows.push(
                '{"matchName":' + jsonString(effect.matchName) +
                ',"displayName":' + jsonString(effect.displayName) +
                ',"category":' + jsonString(effect.category) + "}"
            );
        }
        return '{"version":1,"count":' + total + ',"effects":[' + rows.join(",") + "]}";
    }

    return {
        getCatalogJson: getCatalogJson
    };
})();
