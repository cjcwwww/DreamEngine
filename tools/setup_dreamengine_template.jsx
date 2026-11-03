// One-time AE setup: create the DreamEngine PNG output module template.
// Run from After Effects: File > Scripts > Run Script File...

(function setupDreamEngineTemplate() {
    var outputDir = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!outputDir.exists) outputDir.create();
    var resultFile = new File(outputDir.fsName + "/template_setup.txt");
    var result = "";

    if (!app.project) {
        result = "ERROR|NO_OPEN_PROJECT";
        writeResult(result);
        alert(result);
        return result;
    }

    var comp = app.project.items.addComp("DreamEngine_template_setup", 16, 16, 1, 1, 30);
    var rq = app.project.renderQueue.items.add(comp);
    var om = rq.outputModule(1);
    var templates = om.templates;

    if (hasTemplate(templates, "DreamEngine PNG Sequence")) {
        result = "OK|ALREADY_EXISTS";
    } else {
        var sourceTemplate = findPngTemplate(templates);
        if (!sourceTemplate) {
            result = "ERROR|NO_PNG_TEMPLATE";
        } else {
            om.applyTemplate(sourceTemplate);
            om = rq.outputModule(1);
            om.saveAsTemplate("DreamEngine PNG Sequence");
            result = "OK|CREATED_FROM|" + sourceTemplate;
        }
    }

    rq.remove();
    comp.remove();
    writeResult(result);
    alert(result);
    return result;

    function hasTemplate(items, name) {
        for (var i = 0; i < items.length; i++) {
            if (String(items[i]) === name) return true;
        }
        return false;
    }

    function findPngTemplate(items) {
        for (var i = 0; i < items.length; i++) {
            var name = String(items[i]);
            if (name.toLowerCase().indexOf("png") >= 0) return name;
        }
        return null;
    }

    function writeResult(text) {
        resultFile.encoding = "UTF-8";
        resultFile.open("w");
        resultFile.write(text + "\r\n");
        resultFile.close();
    }
})();
