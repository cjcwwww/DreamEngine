// ============================================================
// M1 preview generator
//
// Generates a 2048x2048 contact sheet with 20 real AE effects and writes
// data/manifest.json. Run through the CEP Bridge on a saved project.
// ============================================================

(function generateM1Previews() {
    var repo = new File($.fileName).parent.parent;
    var dataDir = new Folder(repo.fsName + "/cep/com.dreamengine.panel/data");
    var thumbsDir = new Folder(dataDir.fsName + "/thumbs");
    if (!dataDir.exists) dataDir.create();
    if (!thumbsDir.exists) thumbsDir.create();

    var effects = [
        "ADBE Gaussian Blur 2",
        "ADBE Drop Shadow",
        "APC Colorama",
        "ADBE Turbulent Displace",
        "ADBE Tint",
        "ADBE Invert",
        "ADBE Glo2",
        "ADBE Motion Blur",
        "ADBE Ripple",
        "ADBE Wave Warp",
        "ADBE Mosaic",
        "ADBE Find Edges",
        "CC Ball Action",
        "CC Bubbles",
        "CC Particle Systems II",
        "CC Star Burst",
        "CC Toner",
        "CC Radial Fast Blur",
        "CC Lens",
        "CC Twister"
    ];

    app.newProject();

    var scene = app.project.items.addComp("M1_scene", 256, 256, 1, 1, 30);
    var bg = scene.layers.addSolid([0.055, 0.065, 0.075], "background", 256, 256, 1);
    var accent = scene.layers.addSolid([0.18, 0.68, 0.76], "accent", 150, 90, 1);
    accent.property("ADBE Transform Group").property("ADBE Position").setValue([128, 132]);
    var warm = scene.layers.addSolid([0.86, 0.32, 0.18], "warm", 58, 58, 1);
    warm.property("ADBE Transform Group").property("ADBE Position").setValue([72, 76]);

    var text = scene.layers.addText("AE");
    var textDoc = text.property("ADBE Text Properties").property("ADBE Text Document").value;
    textDoc.fontSize = 64;
    textDoc.fillColor = [0.94, 0.94, 0.92];
    text.property("ADBE Text Properties").property("ADBE Text Document").setValue(textDoc);
    text.property("ADBE Transform Group").property("ADBE Position").setValue([128, 145]);

    var cells = [];
    for (var i = 0; i < effects.length; i++) {
        var matchName = effects[i];
        var cell = app.project.items.addComp("M1_cell_" + i, 256, 256, 1, 1, 30);
        var layer = cell.layers.add(scene);
        var fx;
        try {
            fx = layer.property("ADBE Effect Parade").addProperty(matchName);
        } catch (eEffect) {
            throw new Error("Cannot add " + matchName + ": " + eEffect.toString());
        }
        applyRecipe(fx, matchName);
        cells.push(cell);
    }

    var grid = app.project.items.addComp("M1_grid_2048", 2048, 2048, 1, 1, 30);
    for (var c = 0; c < cells.length; c++) {
        var gridLayer = grid.layers.add(cells[c]);
        var col = c % 8;
        var row = Math.floor(c / 8);
        gridLayer.property("ADBE Transform Group").property("ADBE Position")
            .setValue([col * 256 + 128, row * 256 + 128]);
    }

    var rq = app.project.renderQueue.items.add(grid);
    var om = rq.outputModule(1);
    om.applyTemplate("DreamEngine PNG Sequence");
    om.file = new File(thumbsDir.fsName + "/batch_000_[####].png");
    rq.timeSpanStart = grid.frameDuration * 15;
    rq.timeSpanDuration = grid.frameDuration;
    app.project.renderQueue.render();

    var rendered = new File(thumbsDir.fsName + "/batch_000_0015.png");
    var target = new File(thumbsDir.fsName + "/batch_000.png");
    if (target.exists) target.remove();
    if (!rendered.exists) throw new Error("Preview render did not produce batch_000_0015.png");
    rendered.rename("batch_000.png");

    var itemLines = [];
    for (var m = 0; m < effects.length; m++) {
        itemLines.push(
            '{"matchName":' + jsonString(effects[m]) +
            ',"sheet":0,"x":' + ((m % 8) * 256) +
            ',"y":' + (Math.floor(m / 8) * 256) +
            ',"width":256,"height":256,"frames":1}'
        );
    }
    var manifest =
        '{"version":1,"cellSize":256,"columns":8,"width":2048,"height":2048,' +
        '"sheets":[{"src":"thumbs/batch_000.png","width":2048,"height":2048}],' +
        '"items":[' + itemLines.join(",") + "]}";
    var manifestFile = new File(dataDir.fsName + "/manifest.json");
    manifestFile.encoding = "UTF-8";
    manifestFile.open("w");
    manifestFile.write(manifest);
    manifestFile.close();

    return "OK:" + effects.length + " previews -> " + target.fsName;

    function jsonString(value) {
        var out = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        out = out.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
        return '"' + out + '"';
    }

    function applyRecipe(fx, matchName) {
        if (matchName === "ADBE Gaussian Blur 2") {
            setNamed(fx, ["Blurriness"], 10);
        } else if (matchName === "ADBE Motion Blur") {
            setNamed(fx, ["Direction"], 35);
            setNamed(fx, ["Blur Length"], 40);
        } else if (matchName === "ADBE Glo2") {
            setNamed(fx, ["Glow Radius"], 24);
            setNamed(fx, ["Glow Intensity"], 1.5);
        } else if (matchName === "ADBE Mosaic") {
            setNamed(fx, ["Horizontal Blocks"], 12);
            setNamed(fx, ["Vertical Blocks"], 12);
        } else if (matchName === "CC Radial Fast Blur") {
            setNamed(fx, ["Amount"], 35);
        } else if (matchName === "CC Lens") {
            setNamed(fx, ["Size"], 145);
        }
    }

    function setNamed(group, names, value) {
        for (var p = 1; p <= group.numProperties; p++) {
            var prop = group.property(p);
            if (!prop) continue;
            for (var n = 0; n < names.length; n++) {
                if (String(prop.name) === names[n]) {
                    try { prop.setValue(value); } catch (eSet) {}
                    return;
                }
            }
        }
    }
})();
