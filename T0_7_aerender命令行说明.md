# T0.7 aerender 离线生成可行性（命令行说明，不靠脚本）

M0 里唯一不能在 AE 界面内完成的一项。目的是决定**离线批量生成缩略图走 `aerender` 子进程，还是退回 AE 内分批队列**。

## 实测结论（AE 2021 / 18.4.1x4）

**aerender 18.4.1 不支持 `-r`。** `aerender -help` 的完整参数表中没有 `-r`，
因此离线生成不能依赖 aerender 执行 `.jsx` 业务脚本。可执行形态改为两段式：

1. 在 AE 内运行脚本，建立预览合成并保存 `.aep`。
2. 用 `aerender -project ... -comp ...` 只负责渲染已保存的合成。

`aerender -help` 原始输出保存在 `probe-results/AE2021/T0_7_aerender-help.txt`。

补充实测：`AfterFX.exe -r <probe.jsx>` 在本机启动后立即退出，未生成探针输出，
也不作为可靠自动化入口。

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

3. **不要执行 `aerender -r`。** AE 2021 已实测不支持该参数。
   后续验证只检查 `aerender -project ... -comp ...` 能否加载项目、第三方效果和插件。

## 三、并发数与许可（必须自查，不要凭网上说法）

设计文档里对并发进程数不下结论，原因是要以 Adobe 许可条款为准。请你自查两处：

- Adobe 通用许可条款中关于 **Render Only** 的现行规定（官方页面，注意版本时效）
- 自己账号的订阅类型是否允许在单机上多开渲染实例

确认后再决定离线生成器允许同时起几个 aerender 进程。

## 四、结论怎么填

把下面三行结论写进回传内容（或直接把命令行输出全文贴给 AI）：

```
aerender 是否支持 -r 执行脚本：否（AE 2021 / 18.4.1x4 实测）
aerender 是否成功加载第三方插件：是 / 否 / 有报错（贴原文）
许可允许的并发数：____（引用官方条款原文）
建议离线生成形态：两段式（AE 建合成 + aerender 渲染）
```

---

内容由 AI 生成
