# T0.7 aerender 离线生成可行性（命令行说明，不靠脚本）

M0 里唯一不能在 AE 界面内完成的一项。目的是决定**离线批量生成缩略图走 `aerender` 子进程，还是退回 AE 内分批队列**。

## 一、找到可执行文件

- Windows：`<安装目录>\Support Files\aerender.exe`（典型路径 `C:\Program Files\Adobe\Adobe After Effects <版本>\Support Files\aerender.exe`）
- macOS：`/Applications/Adobe After Effects <版本>/aerender`

## 二、跑三条命令，把每条的完整输出回传

打开命令行（Windows cmd / macOS 终端），依次执行（路径按你的实际安装位置替换）：

1. **看帮助与参数支持范围**

```
aerender -help
```

2. **确认能否加载第三方插件与脚本**（先准备一个含第三方效果的合成名 `<comp>` 和一个已有项目 `<project.aep>`）

```
aerender -project "<project.aep>" -comp "<comp>" -closeProject
```

观察输出里插件是否被正常加载、是否有 GPU / 许可相关提示。

3. **确认能否跑指定的 jsx 脚本**（这是本项目离线生成器的关键假设）

```
aerender -r "<某个探针jsx>"
```

如果 `-r` 不被支持或脚本没执行（看 `~/Documents/AEViewerProbe/探针日志.txt` 有无新增行），说明离线生成器**不能**靠 aerender 跑业务脚本，只能退化为：
`aerender -project xxx.aep -comp xxx -25`（只渲染已保存好的预览合成）
也就是"在 AE 内把预览合成批量建好存盘 → aerender 只负责渲染"的两段式。**这是完全可行的替代方案，不算失败。**

## 三、并发数与许可（必须自查，不要凭网上说法）

设计文档里对并发进程数不下结论，原因是要以 Adobe 许可条款为准。请你自查两处：

- Adobe 通用许可条款中关于 **Render Only** 的现行规定（官方页面，注意版本时效）
- 自己账号的订阅类型是否允许在单机上多开渲染实例

确认后再决定离线生成器允许同时起几个 aerender 进程。

## 四、结论怎么填

把下面三行结论写进回传内容（或直接把命令行输出全文贴给 AI）：

```
aerender 是否支持 -r 执行脚本：是 / 否
aerender 是否成功加载第三方插件：是 / 否 / 有报错（贴原文）
许可允许的并发数：____（引用官方条款原文）
建议离线生成形态：单进程 -r / 两段式（AE 建合成 + aerender 渲染）
```

---

内容由 AI 生成
