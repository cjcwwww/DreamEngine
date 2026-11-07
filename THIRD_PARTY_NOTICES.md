# 第三方归属与许可记录

本文件记录 DreamEngine 直接参考过的第三方项目。凡在本仓库中出现「来源参考」的
功能，都在这里标注上游仓库、提交号与被参考的模块，以便追溯与合规审查。

---

## 1. XLFlow（曲线页特征参考）

| 项 | 内容 |
|---|---|
| 仓库 | `https://github.com/xiaolinnnnnnn/XLFlow` |
| 作者 | xiaolinnnnnnn |
| 参考提交 | `c9e4a00b0e5279560df771fcc8807cac41199e66` |
| 参考模块 | `js/curve_editor.js`（画布交互与曲线图编辑）、`jsx/core.jsx`（AE 侧读写与选区处理） |
| 许可声明 | 上游 README 声明为 **MIT License** |

### 重要说明：上游没有实际的 LICENSE 文件

在参考提交 `c9e4a00b0e5279560df771fcc8807cac41199e66` 中，仓库只有 README 里的一句
MIT 声明，**no actual `LICENSE` file** 存在于仓库根目录，也没有随源码分发许可证全文。

因此本项目的处理方式是：

1. **不复制上游的 JS 源代码**（图标除外，见下节）。DreamEngine 的
   `engine/curve_graph.js`、`engine/curvelib.jsx` 与 `js/curve.js` 都是按本项目既有的
   `curve_math.js` 换算模型重写的，没有逐行搬运上游实现；参考的是**交互思路与功能清单**
   （读取当前曲线、曲线反向、关键帧交换、冻结帧、网格磁吸、撤销历史、
   归一化多关键帧曲线图，以及面板的分栏布局）。
2. **不引入上游的运行时依赖**：不使用 XLFlow 的云端预设、账号注册、上传下载、
   在线状态、整页设置系统、自定义背景或品牌素材。
3. 本记录保留上游仓库地址与提交号，若上游后续补上正式许可证文件，
   应重新核对其条款并更新本文件。

### 图标资源（复制自上游）

2026-11-07 起，曲线页工具栏直接使用上游 `resources/svg/` 里的图标（24×24 描边风格，
描边色 `#FFFFFF`）。这些是**图形资源而非代码**，按上游 README 声明的 MIT 条款使用：

| 本仓库路径 | 上游文件 |
|---|---|
| `cep/com.dreamengine.panel/svg/read-curve.svg` | `read-curve.svg` |
| `cep/com.dreamengine.panel/svg/reverse-curve.svg` | `reverse-curve.svg` |
| `cep/com.dreamengine.panel/svg/reverse-time.svg` | `reverse-time.svg` |
| `cep/com.dreamengine.panel/svg/left-still.svg` | `left-still.svg` |
| `cep/com.dreamengine.panel/svg/right-still.svg` | `right-still.svg` |
| `cep/com.dreamengine.panel/svg/magnet.svg` | `magnet.svg` |
| `cep/com.dreamengine.panel/svg/reset.svg` | `reset.svg` |
| `cep/com.dreamengine.panel/svg/apply.svg` | `apply.svg` |
| `cep/com.dreamengine.panel/svg/favorite.svg` | `favorite.svg` |
| `cep/com.dreamengine.panel/svg/arrow-left.svg` / `arrow-right.svg` | 同名文件 |

上游没有的四个图标（`mode-two` / `mode-multi` / `undo` / `redo`）是按同样规格自绘的，
放在同一目录，不属于上游资源。

### 本项目中对应实现的位置

| 文件 | 内容 |
|---|---|
| `cep/com.dreamengine.panel/engine/curve_graph.js` | 浏览器与 ExtendScript 共用的纯图模型（ES3） |
| `cep/com.dreamengine.panel/engine/curvelib.jsx` | AE 侧选区解析、图回读、托管关键帧与安全写回 |
| `cep/com.dreamengine.panel/js/curve.js` | 画布绘制与多点交互 |
| `cep/com.dreamengine.panel/js/curve_toolbar.js` | 工具栏、分页横滚与本地撤销历史 |
| `cep/com.dreamengine.panel/js/curve_split.js` | 编辑器与预设区之间的分隔条 |
| `cep/com.dreamengine.panel/svg/` | 工具栏图标（见上） |

设计依据见 `docs/superpowers/specs/2026-11-07-xlflow-curve-features-design.md`。

---

## 2. 其他第三方组件

| 组件 | 用途 | 许可 |
|---|---|---|
| Electron / electron-builder | DreamEngine Hub 的运行时与打包 | MIT |
| Adobe CEP / ExtendScript | AE 面板宿主 | Adobe 许可（不随本仓库分发） |

字体不随仓库分发：面板与 Hub 使用系统已安装的思源黑体（Noto Sans SC），
缺失时回退微软雅黑。
