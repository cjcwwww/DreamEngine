/* ============================================================
 * i18n.js —— 界面文案字典（中 / 英）
 *
 * 为什么单列一个文件：文案散在 index.html 与四五个脚本里，一旦要加语言
 * 就得满仓库找字符串。集中到一张表之后：
 *   · 静态文案在 HTML 上标 data-i18n="key"，applyI18n() 统一替换
 *   · 动态文案在 JS 里用 L("key") 取当前语言
 *
 * 约定：
 *   · 每一项是 [中文, English] 两元数组，顺序固定
 *   · 带占位符的用 {0} {1}，替换走 L("key", [a, b])
 *   · 不要在这里放 HTML 标签 —— 全部按纯文本写入（textContent）
 *
 * 语法：ES5（与其它面板脚本一致）。
 * ============================================================ */

var AEV_I18N = {
  /* ---------- 顶栏 / 视图切换 ---------- */
  "tab.effects": ["效果", "Effects"],
  "tab.presets": ["预设", "Presets"],
  "tab.curve": ["曲线", "Curves"],
  "app.title": ["DreamEngine", "DreamEngine"],
  "tab.aria": ["主视图切换", "Main views"],
  "lang.zhTitle": ["中文", "Chinese"],
  "lang.enTitle": ["English", "English"],

  /* ---------- 效果墙 ---------- */
  "search.effects": ["搜索效果、分类或 matchName", "Search effects, categories or matchName"],
  "filter.plugin": ["插件筛选", "Plugin filter"],
  "filter.all": ["全部来源", "All sources"],
  "filter.builtin": ["内置", "Built-in"],
  "filter.other": ["其它插件", "Other plugins"],
  "sort.group": ["排序", "Sort"],
  "sort.name": ["按名称", "By name"],
  "sort.category": ["按分类", "By category"],
  "toggle.showAll": ["全部已安装", "Show all installed"],
  "sidebar.title": ["分类", "Categories"],
  "sidebar.all": ["全部", "All"],
  "empty.effects": ["没有匹配的效果", "No matching effects"],
  "card.addHint": ["（双击或点 + 添加到 AE 选中图层）", " (double-click or click + to add to the selected layer)"],
  "card.addButton": ["添加到选中层", "Add to selected layer"],

  /* ---------- 预设视图 ---------- */
  "preset.title": ["预设库", "Preset library"],
  "preset.search": ["搜索预设", "Search presets"],
  "preset.add": ["添加预设", "Add preset"],
  "preset.addTitle": ["选择 .ffx 文件加入预设库", "Pick a .ffx file to add to the library"],
  "preset.background": ["预览背景", "Preview background"],
  "preset.uploadBg": ["上传背景", "Upload background"],
  "preset.uploadBgTitle": ["上传自己的图片当预览背景", "Upload your own image as the preview background"],
  "preset.generate": ["生成预览", "Generate previews"],
  "preset.generateTitle": [
    "按当前背景为库内预设生成缩略图；静态预设出 1 帧，含关键帧的覆盖首末关键帧",
    "Render thumbnails for library presets with the current background; static presets get 1 frame, animated ones cover the keyframe range"
  ],
  "preset.hint": [
    "点卡片应用到当前合成 · 可把 .ffx 拖进页面 · 含第三方插件的预设：保存工程后双击安装包里的「生成插件预设预览.bat」",
    "Click a card to apply it to the current comp · Drop .ffx files here · Presets with third-party plugins: save the project and run “生成插件预设预览.bat” from the package"
  ],
  "preset.empty": ["预设库还是空的", "The preset library is empty"],
  "preset.emptyNote": ["把 .ffx 拖进这个页面，或点上面的「添加预设」",
    "Drop .ffx files here, or use “Add preset” above"],

  /* ---------- 曲线视图 ---------- */
  "curve.aria": ["曲线编辑", "Curve editor"],
  "curve.modeTitle": ["图表：值 / 速度 / 路径", "Graph: value / speed / path"],
  "curve.modeValue": ["值", "V"],
  "curve.modeValueTitle": ["值曲线（可编辑）", "Value curve (editable)"],
  "curve.modeSpeed": ["速", "S"],
  "curve.modeSpeedTitle": ["速度曲线（只读）", "Speed curve (read-only)"],
  "curve.modePath": ["路", "P"],
  "curve.modePathTitle": ["空间路径（只读）", "Spatial path (read-only)"],
  "curve.apply": ["应用", "Apply"],
  "curve.applying": ["应用中…", "Applying…"],
  "curve.overwrite": ["覆盖", "Overwrite"],
  "curve.discard": ["放弃", "Discard"],
  "curve.conflictAria": ["并发冲突", "Concurrent change"],

  /* ---------- 底栏 ---------- */
  "status.ready": ["准备扫描", "Ready"],
  "status.size": ["尺寸", "Size"],
  "queue.label": ["队列", "Queue"],
  "queue.toggle": ["查看生成队列", "Open the render queue"],

  /* ---------- 队列抽屉 ---------- */
  "queue.title": ["生成队列", "Render queue"],
  "queue.close": ["关闭队列", "Close the queue"],
  "queue.retry": ["重试失败", "Retry failed"],

  /* ---------- 设置抽屉 ---------- */
  "settings.title": ["设置", "Settings"],
  "settings.close": ["关闭设置", "Close settings"],
  "settings.library": ["库", "Library"],
  "settings.entries": ["条目", "Entries"],
  "settings.loading": ["正在读取效果库", "Loading library…"],
  "settings.appearance": ["外观", "Appearance"],
  "settings.language": ["界面语言", "Language"],
  "settings.langGroup": ["语言", "Language"],
  "settings.maintenance": ["预览维护", "Preview maintenance"],
  "settings.genMissing": ["生成缺失预览", "Generate missing previews"],
  "settings.genMissingNote": ["渲染当前 AE 环境里还没出图的内置效果",
    "Render built-in effects that have no preview yet"],
  "settings.rescan": ["重新扫描 AE 效果", "Rescan AE effects"],
  "settings.rescanNote": ["刚装了新插件时用，强制重读效果清单",
    "Force a re-read of the effect list after installing new plugins"],
  "settings.retry": ["重试失败", "Retry failed"],
  "settings.retryNote": ["把生成失败的条目重新排队", "Re-queue entries that failed to render"],
  "settings.openQueue": ["查看生成队列", "View render queue"],
  "settings.openQueueNote": ["待渲染 / 渲染中 / 失败的逐条状态",
    "Per-item status: pending / rendering / failed"],
  "settings.notes": ["使用说明", "Notes"],
  "settings.note1": [
    "在 AE 里选中图层后，双击效果卡片即可把该效果加到选中层。单击不会改动工程。悬停预览可播放动态效果，静止效果不播放。",
    "Select a layer in AE, then double-click an effect card to add it. A single click does not touch the project. Hover a card to play animated previews; static effects stay still."
  ],
  "settings.note2": [
    "第三方插件的预览不能靠面板按钮实时生成（会让 AE 崩溃），需关闭 AE 后用离线脚本逐条渲染；插件参数一律保持默认。",
    "Previews for third-party plugins cannot be rendered from the panel (it crashes AE). Close AE and run the offline script instead; plugin parameters always stay at their defaults."
  ],

  /* ---------- 状态栏 / 运行消息 ---------- */
  "msg.scanning": ["正在读取效果清单…", "Reading the effect list…"],
  "msg.scanned": ["{0} 个效果 · {1} 个分类", "{0} effects · {1} categories"],
  "msg.noCatalog": ["读取失败：{0}", "Read failed: {0}"],
  "msg.extUnknown": ["扩展路径未知，请先点「重新扫描」", "Extension path unknown — run “Rescan AE effects” first"],
  "msg.noComp": ["AE 里没有打开的合成", "No composition open in AE"],
  "msg.noLayer": ["请先在 AE 里选中一个图层，再双击效果",
    "Select a layer in AE first, then double-click an effect"],
  "msg.addFailed": ["添加失败：{0}", "Add failed: {0}"],
  "msg.applied": ["已应用曲线", "Curve applied"],
  "msg.queued": ["正在排队 {0} 个效果…", "Queueing {0} effects…"],
  "msg.generating": ["正在生成：{0} 个已完成，本批最多 {1} 个…",
    "Rendering: {0} done, up to {1} this batch…"],
  "msg.genDone": ["预览生成完成，新增 {0} 个", "Previews generated: {0} new"],
  "msg.genFailed": ["生成失败：{0}", "Render failed: {0}"],
  "msg.genStopped": ["生成中止：批次为空", "Render stopped: empty batch"],
  "msg.requeued": ["已重新排队 {0} 个", "Re-queued {0} item(s)"],
  "msg.nothingToDo": ["当前没有需要生成的效果", "Nothing needs rendering"],
  "msg.unknown": ["未知原因", "unknown"],

  /* ---------- 动态消息（library.js 里以 L(key, args) 取） ---------- */
  "msg.readFail": ["读取失败：{0}", "Read failed: {0}"],
  "msg.noExtDir": ["无法取得扩展目录", "Could not resolve the extension folder"],
  "msg.emptyCatalog": ["AE catalog 返回空值", "AE catalog returned nothing"],
  "msg.genAllDone": ["内置预览已齐；{0} 个插件效果请用离线脚本生成",
    "Built-in previews are complete; {0} plugin effects need the offline script"],
  "msg.queuedStale": ["正在排队 {0} 个效果（其中 {1} 个是刷新过期预览）…",
    "Queueing {0} effects ({1} of them stale)…"],
  "msg.queuedPlugins": ["（另有 {0} 个插件效果需离线脚本生成）",
    " ({0} plugin effects need the offline script)"],
  "msg.abortGuard": ["已中止：批次过多（防死循环）", "Stopped: too many batches (loop guard)"],
  "msg.batchFailed": ["整批渲染失败（{0}），改为逐条重试以隔离问题条目…",
    "Batch render failed ({0}); retrying one by one to isolate the culprit…"],
  "msg.manifestFailed": ["索引写入失败：{0}", "Failed to write the index: {0}"],
  "msg.tailFailed": ["；失败 {0} 个（{1} 等），可点「重试失败」",
    "; {0} failed ({1} …) — use “Retry failed”"],
  "msg.tailRest": ["，另有 {0} 个留待下次", ", {0} left for next time"],
  "msg.genPartial": ["生成完成（部分失败）：新增 {0} 个", "Done with failures: {0} new"],
  "msg.retryEach": ["逐条重试 {0}/{1}…", "Retrying one by one {0}/{1}…"],

  /* ---------- 队列状态 ---------- */
  "queue.pending": ["待渲染", "pending"],
  "queue.rendering": ["渲染中", "rendering"],
  "queue.failed": ["失败", "failed"],
  "queue.cached": ["已完成", "done"],
  "queue.summary": ["待渲染 {0} · 渲染中 {1} · 失败 {2} · 共 {3}",
    "{0} pending · {1} rendering · {2} failed · {3} total"],

  /* ---------- 预览背景（内置几套） ---------- */
  "bg.photo": ["标准（色块＋文字＋细线）", "Standard (blocks + text + lines)"],
  "bg.text": ["文字（Dream / Engine）", "Text (Dream / Engine)"],
  "bg.solid": ["纯色", "Solid"],
  "bg.shape": ["形状（圆形）", "Shapes (circles)"],
  "bg.pattern": ["高对比条纹", "High-contrast stripes"],
  "bg.custom": ["自定义 · {0}", "Custom · {0}"],

  /* ---------- 预设视图的提示 ---------- */
  "preset.pluginNote": [" · 含插件 {0} 条：保存工程后双击「生成插件预设预览.bat」",
    " · {0} with plugins: save the project, then run “生成插件预设预览.bat”"],
  "preset.previewResult": ["预设预览：成功 {0} · 跳过 {1} · 失败 {2}",
    "Preset previews: {0} ok · {1} skipped · {2} failed"],
  "preset.noFfx": ["没有 .ffx 文件（预设库只接受 .ffx）", "No .ffx files (the library only takes .ffx)"],
  "preset.adding": ["正在加入 {0} 个预设…", "Adding {0} presets…"],
  "preset.added": ["已加入 {0} 个预设（{1} 个失败）", "Added {0} presets ({1} failed)"],
  "preset.pickFailed": ["选择预设失败：{0}", "Could not add the preset: {0}"],
  "preset.applyHint": ["（点一下应用到当前合成）", " (click to apply to the current comp)"],
  "preset.fallbackCategory": ["预设", "Presets"],
  "preset.summary": ["共 {0} 个预设 · 已生成 {1} 张预览{2} · 点卡片应用到当前合成",
    "{0} presets · {1} with previews{2} · click a card to apply"],
  "preset.summaryShown": ["（显示 {0}）", " ({0} shown)"],
  "preset.applied": ["已应用「{0}」（图层类型 {1}，新增效果 {2}）",
    "Applied “{0}” (layer {1}, {2} effect(s) added)"],
  "preset.notApplied": ["预设没有生效：{0}", "The preset had no effect: {0}"],
  "preset.missingPlugins": ["缺少 {0} 个插件效果：{1} 等",
    "Missing {0} plugin effect(s): {1} …"],
  "preset.dropNoPath": ["拖入的文件拿不到路径，请点「添加预设」",
    "Could not read the dropped paths — use “Add preset”"]
};

/** 取文案。lang: "zh" | "en"；args 可选，替换 {0} {1}… */
function AEV_t(key, lang, args) {
  var row = AEV_I18N[key];
  var text = row ? (lang === "en" ? row[1] : row[0]) : key;
  if (args && args.length) {
    for (var i = 0; i < args.length; i++) {
      text = text.replace("{" + i + "}", String(args[i]));
    }
  }
  return text;
}

/**
 * 把页面上所有静态文案换成指定语言。
 *
 * 四种挂载方式：
 *   data-i18n      → textContent
 *   data-i18n-title→ title
 *   data-i18n-aria → aria-label
 *   data-i18n-ph   → placeholder
 *
 * 只用 textContent，不碰 innerHTML：文案来自我们自己的表，但没必要开这个口子。
 */
function AEV_applyI18n(lang) {
  var i;
  var nodes;

  nodes = document.querySelectorAll("[data-i18n]");
  for (i = 0; i < nodes.length; i++) {
    nodes[i].textContent = AEV_t(nodes[i].getAttribute("data-i18n"), lang);
  }

  nodes = document.querySelectorAll("[data-i18n-title]");
  for (i = 0; i < nodes.length; i++) {
    nodes[i].setAttribute("title", AEV_t(nodes[i].getAttribute("data-i18n-title"), lang));
  }

  nodes = document.querySelectorAll("[data-i18n-aria]");
  for (i = 0; i < nodes.length; i++) {
    nodes[i].setAttribute("aria-label", AEV_t(nodes[i].getAttribute("data-i18n-aria"), lang));
  }

  nodes = document.querySelectorAll("[data-i18n-ph]");
  for (i = 0; i < nodes.length; i++) {
    nodes[i].setAttribute("placeholder", AEV_t(nodes[i].getAttribute("data-i18n-ph"), lang));
  }

  try {
    document.documentElement.setAttribute("lang", lang === "en" ? "en" : "zh-CN");
  } catch (e) {}
}
