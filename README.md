<h1 align="center">DreamEngine</h1>

<p align="center">
  After Effects 效果、预设、曲线和素材的一体化工作面板
</p>

<p align="center">
  <a href="README.en.md">English</a> · 中文
</p>

<p align="center">
  <a href="https://github.com/yoanx/DreamEngine"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/yoanx/DreamEngine?style=flat-square&amp;logo=github&amp;label=Stars"></a>
  <a href="https://github.com/yoanx/DreamEngine/releases"><img alt="Release" src="https://img.shields.io/github/v/release/yoanx/DreamEngine?include_prereleases&amp;style=flat-square&amp;label=release"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-4c9a52?style=flat-square"></a>
</p>

<p align="center">
  <img alt="Windows" src="https://img.shields.io/badge/platform-Windows-4f6f8f?style=flat-square&amp;logo=windows&amp;logoColor=white">
  <img alt="After Effects 2021+" src="https://img.shields.io/badge/After%20Effects-2021%2B-5f8a74?style=flat-square">
  <img alt="CEP 11" src="https://img.shields.io/badge/CEP-11-6b7f95?style=flat-square">
  <img alt="DreamEngine Hub 0.1.0" src="https://img.shields.io/badge/Hub-0.1.0-6f8f9a?style=flat-square">
  <img alt="DreamEngine Panel 0.2.0" src="https://img.shields.io/badge/Panel-0.2.0-7f9c88?style=flat-square">
</p>

> **Beta 状态**：DreamEngine 面向 Windows，当前在 After Effects 2021 / CEP 11 上完成主要实机验证。更新版本的 AE 尚未完成完整验收。

## 下载与安装

当前版本：**DreamEngine Hub 0.1.0 / CEP 面板 0.2.0**

从 [GitHub Releases](https://github.com/yoanx/DreamEngine/releases/tag/v0.1.0-beta.2) 下载：

- `DreamEngine-Hub-Setup-0.1.0.exe`
- `SHA256SUMS.txt`

安装步骤：

1. 在 After Effects 中保存工程并退出。
2. 运行安装器，选择安装目录并完成安装。
3. 启动 After Effects，打开 `窗口 > 扩展 > DreamEngine`。

安装器未签名，Windows SmartScreen 可能显示“未知发布者”。升级会替换程序文件和内置预览资源，但不会删除用户预设、分类、收藏或已生成的预览。

## 最短上手

### 在 AE 面板中使用

| 页面 | 操作 |
| --- | --- |
| 效果 | 搜索或筛选效果；双击添加到当前选中图层；悬停播放动态预览 |
| 预设 | 单击应用 `.ffx` 预设；使用左侧分类与收藏筛选 |
| 曲线 | 调整 Bezier 曲线；应用到选中关键帧；保存为自定义预设 |
| 素材 | 选择一个根目录；单击预览；双击导入并放到当前合成时间位置 |

### 在 DreamEngine Hub 中使用

Hub 是不依赖 AE 主进程的独立管理程序，主要用于：

- 添加、重命名、收藏、分类和长按删除 `.ffx` 预设。
- 为第三方插件预设生成离线预览图与动态帧序列。
- 对单条预设清空旧预览，或强制单独重渲。
- 添加自定义预览背景。
- 查看面板安装状态、AE 版本、目录和渲染日志。

预设分类和预设收藏由 AE 面板与 Hub 共用。

## 功能说明

### DreamEngine Hub

**预设库**

- 支持文件选择或拖入 `.ffx`。
- 左侧分类支持新建、重命名和删除。
- 收藏是独立筛选，可与分类组合使用。
- 动态预设悬停播放；静态预览以右上角橙色圆点标识。
- 右键菜单提供：重命名、收藏、取消渲染、单独渲染、删除预设、移动到分类。
- “取消渲染”会删除该预设的索引与帧文件，使其回到待渲染状态，并重新参与下一次批量渲染。
- 长按卡片或使用右键菜单可删除预设库中的 `.ffx`。

**离线预览渲染**

- 插件预设通过独立的 AE 实例渲染，避免破坏正在使用的 AE 会话。
- 默认每个专用 AE 实例连续处理最多 40 条，减少重复启动。
- 渲染前必须保存并关闭 AE；任务完成后可按原状重新打开 AE。
- 支持内置与自定义预览背景。
- “单独渲染”只处理所选预设，并强制绕过已有预览和失败黑名单。

**设置与诊断**

- 查看 Hub、面板和内置预览版本。
- 查看已安装的 AE 版本与运行状态。
- 打开扩展、预设库和日志目录。

### AE 面板

**效果**

- 按名称或分类排序，按插件来源筛选。
- 动态预览悬停播放，静态效果保持静止。
- 双击效果或点击卡片上的添加按钮，将效果加入当前选中图层。
- 收藏效果，并与分类条件组合筛选。

**预设**

- 浏览已导入预设及预览。
- 单击应用预设；长按可删除库内预设。
- 分类和收藏与 Hub 双向共用。
- 动态预设悬停播放；静态预设显示橙色圆点。

**曲线**

- 支持值曲线、速度曲线和空间路径图。
- 拖动控制点调整缓动，应用到当前属性的选中关键帧。
- 保存自定义曲线预设；长按删除，包括内置预设。
- 写入前检查关键帧是否发生变化，避免覆盖并发修改。

**素材**

- 只登记一个素材根目录，不复制、不移动、不修改源文件。
- 自动分类视频、图片、音频和 `.aep` 工程。
- 视频单击后播放，视频预览最多截取 2 秒。
- 音频显示频谱，并支持单击播放/停止。
- 双击视频、图片或音频，导入项目并添加到当前合成的时间指示器位置。
- `.aep` 只导入工程，不解析内容或作为素材层加入合成。
- 素材收藏可与分类组合筛选。

## 环境要求

- Windows 10 或 Windows 11
- After Effects 2021（18.0）或更高版本
- 推荐安装 `ffmpeg`，用于音频频谱和部分视频缩略图/预览缓存

未安装 `ffmpeg` 时，核心 AE 工作流仍可使用，但部分素材预览可能显示为空。

## 实机截图

**After Effects 面板**

![DreamEngine 效果面板](assets/screenshots/ae-panel.png)

**DreamEngine Hub**

![DreamEngine Hub](assets/screenshots/hub.png)

## 用户数据

DreamEngine 不上传工程、素材或预设。

| 路径 | 内容 |
| --- | --- |
| `文档/DreamEngine/presets/` | 用户 `.ffx` 预设 |
| `文档/DreamEngine/backgrounds/` | 自定义预览背景 |
| `文档/DreamEngine/preset_categories.json` | 预设分类与预设收藏 |
| `文档/DreamEngine/materials/` | 素材索引、频谱与视频预览缓存 |
| `文档/DreamEngineProbe/` | Hub 渲染状态与日志 |
| `%APPDATA%/Adobe/CEP/extensions/com.dreamengine.panel/` | 已安装面板及内置预览索引 |

效果收藏、素材收藏、曲线预设和部分面板设置仍保存在 CEP 面板的本地 `localStorage` 中。

卸载或升级前，如需保留预设与缓存，请备份 `文档/DreamEngine/`。

## 常见问题

**AE 菜单里没有 DreamEngine**

1. 确认安装器和 AE 使用同一个 Windows 用户。
2. 完全退出并重新启动 AE。
3. 在 Hub 的“设置”页确认面板安装状态和扩展目录。

**插件预设无法渲染**

- 保存并关闭所有 AE 实例后，再从 Hub 开始渲染。
- 检查 Hub 的渲染日志和 `文档/DreamEngineProbe/`。
- 确认本机安装了预设依赖的第三方插件。

**素材没有预览**

- 安装 `ffmpeg`，或在 `文档/DreamEngine/materials/ffmpeg.txt` 中填写 `ffmpeg.exe` 的绝对路径。
- 回到素材页点击“刷新”。

## 反馈与贡献

- 使用 [Bug 模板](https://github.com/yoanx/DreamEngine/issues/new?template=bug_report.yml) 报告可复现问题。
- 使用 [功能建议模板](https://github.com/yoanx/DreamEngine/issues/new?template=feature_request.yml) 提议新工作流。
- 提交问题时请附上 DreamEngine、Windows、After Effects 和 CEP 版本，以及 `文档/DreamEngineProbe/` 中的相关日志。
- 提交代码前请阅读 PR 模板，并确保公开仓库不包含内部工具、探针、开发笔记、工程素材或密钥。

## 仓库结构

```text
cep/com.dreamengine.panel/   After Effects CEP 面板
hub/                         Electron 管理程序
dist/L1/                     内置效果预览资源
assets/screenshots/          README 截图
```

开发探针、内部测试工具和进度笔记不进入公开仓库。

## 许可证

本项目采用 [MIT License](LICENSE)。允许使用、复制、修改、合并、发布、分发、再许可和销售，但需保留版权与许可声明。

## 当前限制

- 安装包尚未代码签名。
- 主要在 AE 2021 / CEP 11 上完成验收。
- 第三方插件预览依赖本机插件和授权环境。
- 素材库目前只支持一个根目录；磁盘变化后需要手动刷新。
- `.aep` 不解析内部合成，也不会自动打开。
- Hub 与 AE 面板不会在另一端操作后自动轮询刷新分类列表；切回对应页面时会重新读取。
