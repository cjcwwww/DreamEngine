/* ============================================================
 * T0_8 全量 dump 探针
 *
 * 动机：T0_1 只输出前 60 条样本，不足以喂 join_matchnames.py 做对撞。
 *       T0.8 需要「全部」实测 (matchName, displayName, category)。
 *
 * 输出：Documents/DreamEngineProbe/T0_1_full.tsv
 *       UTF-8，表头 matchName<TAB>displayName<TAB>category
 *       （join_matchnames.py load_detected() 的约定格式）
 *
 * 语法：ES3。写盘显式指定 UTF-8（ExtendScript 默认 ANSI，中文会乱码）。
 * 只读枚举，不创建任何项目对象。
 * ============================================================ */

(function () {
  var outDir = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
  if (!outDir.exists) outDir.create();

  var lines = [];
  lines.push("matchName\tdisplayName\tcategory");

  var eff = app.effects;
  var total = eff.length;
  for (var i = 0; i < total; i++) {
    var e = eff[i];
    var mn = e.matchName;
    var dn = e.displayName;
    var cat = e.category;
    // tab/换行会破坏 TSV 结构，替换为空格
    mn = String(mn).replace(/[\t\r\n]/g, " ");
    dn = String(dn).replace(/[\t\r\n]/g, " ");
    cat = String(cat).replace(/[\t\r\n]/g, " ");
    lines.push(mn + "\t" + dn + "\t" + cat);
  }

  var f = new File(outDir.fsName + "/T0_1_full.tsv");
  f.encoding = "UTF-8";
  var okWrite = f.open("w");
  if (okWrite) {
    f.write(lines.join("\r\n"));
    f.close();
  }

  // 追加汇总行到探针日志（与既有探针同约定）
  var log = new File(outDir.fsName + "/探针日志.txt");
  if (log.open("a")) {
    log.writeln("T0_8全量dump | AE " + app.version +
      " | 条数=" + total + " | 输出=T0_1_full.tsv | 写盘=" + (okWrite ? "OK" : "FAIL"));
    log.close();
  }

  alert("T0_8 全量 dump 完成\n条数=" + total +
        "\n输出=" + f.fsName +
        "\n（本探针只读，不建任何对象，可直接继续）");
})();
