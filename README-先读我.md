# DreamEngine · AE 效果可视化面板

DreamEngine 是自用的 After Effects 效果可视化面板：用 CEP 做薄 UI，用 ExtendScript 读写 AE 数据，并以离线预渲染为首选预览来源。当前已完成 M0，并跑通 M1 的首个端到端竖向切片；完整 M1 仍在进行中。

设计与任务拆解先读这两份：

- `docs/2026-11-03-AE效果可视化脚本-design.md`（设计定稿 v2）
- `docs/2026-11-03-AE效果可视化脚本-任务清单.md`（56 个任务的输入/产出/验收）

以下第 1–4 节保留 M0 探针的复跑与回传方法；当前开发状态和 M1 待办见 `进度清单.md`。

---

## 1. 跑之前必须做的两件事

1. **开启脚本写文件权限**（不开的话所有探针白跑）
   `编辑 > 首选项 > 脚本和表达式 > 允许脚本写入文件和访问网络` 打勾
   macOS 菜单位置在 `After Effects > 设置/首选项 > 脚本和表达式`
2. **准备 3 个测试预设**（T0_4 要用，从你自己的预设库里挑）
   - 一个纯效果预设（只改参数、无关键帧）
   - 一个文本动画预设（必须配文本层那种）
   - 一个变换关键帧预设（位置/缩放动画）

探针输出统一落在：`文稿(文档)/DreamEngineProbe/`

---

## 2. 执行顺序

| 顺序 | 探针 | 怎么跑 | 回答哪个未知数 |
|---|---|---|---|
| ① | `probes/T0_1_效果枚举探针.jsx` | 文件 > 脚本 > 运行脚本文件 | `app.effects` 条数、第三方是否全含、`category` 真实形态、matchName 前缀分布 |
| ② | `probes/T0_5_参数读取探针.jsx` | 同上 | 下拉选项名能否读到、min/max/units 可读性（决定老版本降级显示方案） |
| ③ | `probes/T0_2_渲染耗时探针.jsx` | 同上，**耗时较长，别中途 Esc** | 单帧耗时、整网批量耗时、每格每帧秒数与 KB → 唯一能定 L1 内置包规模和动画帧数的数据 |
| ④ | `probes/T0_4_预设应用探针.jsx` | 同上，会弹框让你选 `.ffx`，**换不同预设跑 3 次** | `applyPreset` 在有选中/无选中/文本层/调整层四种场景的真实行为 |
| ⑤ | `probes/T0_6_导入入口探针.jsx` | 同上，会弹多选框和文件夹选择框 | `File.openDialog` 多选返回形态、递归扫 `.ffx` 耗时 |
| ⑥ | `T0_7_aerender命令行说明.md` | 命令行，不在 AE 界面里 | 离线生成器能否走 aerender、并发与许可自查项 |

**M0 的 CEP 探针页面已被 M1 首屏替换。** 当前 `com.dreamengine.panel` 不再提供 T0.3 / T0.6b 页签；这两项的实测结果已经归档，不需要为了当前开发重跑。

- T0.3 CEF 纹理上限 / 图片解码 / 轮播结果：已归档；
- T0.6b `File.path` 结果：已归档；
- T0.8：已完成第一方 + BCC 的本地对撞；Sapphire、Red Giant、RE:Vision、Video Copilot 本轮明确走 L-C，不阻塞 M1。

面板需要开启 `PlayerDebugMode` 并放到 CEP 扩展目录。安装、启动与排查见 `cep/CEP骨架-安装与运行.md`。

---

## 3. 三条硬规矩

1. **探针跑完不要按 Ctrl+Z 撤销清理。** 设计文档 §6.4 记过 `copyToComp` 的 undo 崩溃警告，探针创建的临时合成一律用「关闭项目且不保存」处理，或手动删除名称前缀为 `T0_` 的合成。
2. **每个 AE 版本各跑一遍。** 至少覆盖你的主力版本 + CC2022（或 CC2023）。输出文件名相同会互相覆盖，换版本跑之前先把 `DreamEngineProbe` 文件夹改名备份，例如 `DreamEngineProbe_CC2022`。
3. **T0_2 第一次跑别改参数。** 默认参数是 5 个效果单帧 + 4×4 整网 6 帧，故意做小。等你看到耗时基数后，再按脚本顶部常量放大到目标规模复测。

---

## 4. 回传清单（如果你还想让 AI 参与分析）

打包整个 `DreamEngineProbe` 目录回传即可，重点是：

```
T0_1_效果枚举.txt
T0_2_渲染耗时.txt
T0_4_预设应用_<预设名>.txt   （3 份）
T0_5_参数读取.txt
T0_6_导入探针.txt
T0_3_CEF探针.txt             （由 CEP 壳写入）
T0_6b_拖拽.txt               （由 CEP 壳写入）
探针日志.txt                 （汇总行，一眼看全）
T0_7 的三条命令输出全文
```

拿到这些数据后的动作是：回填设计文档里所有"需实测"占位，把 **网格尺寸 / 每网效果数 / 动画帧数 / L1 效果总数 / 批渲节奏** 定死（任务清单 T0.9）。

---

## 5. 想彻底本地自研（不再经过 AI）

技术上完全可行，这个项目对本地工具链的要求很低：

- **写 .jsx**：任何文本编辑器都行；建议 VS Code 装 ExtendScript 语法插件。注意 ExtendScript 是 **ES3**，没有 `let/const`、箭头函数、`Promise`，也不要用 `JSON.parse`（本包探针一律手工拼字符串输出，就是为了避开这一点）
- **做 CEP 面板**：需要 CEP 调试开关（`PlayerDebugMode`）、`CSXS/manifest.xml` 里声明多 HostVersion，打包用 ZXPSignCmd；参考 Adobe-CEP/Samples 里的 After Effects 示例
- **离线批量**：`aerender` 命令行，见 `T0_7`
- **运行位置**：脚本放 `Scripts` 目录（Windows 在 `Support Files`，macOS 在应用包内）；面板放 CEP 扩展目录

本地继续按任务清单推进时，目录约定照设计文档 §3 执行，别偏离已定的分层（**AE 数据读写全部留在 .jsx，CEP 侧不出现 AE 对象**）——这条是整份设计对冲 CEP 2028/2029 退场的唯一保险，改了就失去意义。

## 5.1 当前执行状态（2026-11-03）

- M0 在 AE 2021 / CEP 11.1 已完成并归档到 `probe-results/AE2021/`。
- 定版渲染参数见 `config/render_params.jsxinc`。
- 面板已改名为 DreamEngine，CEP Bundle / Extension ID 使用 `com.dreamengine.panel`。
- 探针目录、AE 输出模板和当前代码路径均已统一为 DreamEngine 命名。
- M1 首屏已打通：20 个真实预览、本机 1371 个效果、566 个唯一名字、双语、搜索、来源筛选、缺图占位和重新扫描。
- M1 尚未完整完成：`store.jsx`、完整参数树、engine 化的 `names` / `recipe` / `previewgen`、运行时生成队列、CC2022/2023 实机验收。
- 详细进度与待办以 `进度清单.md` 为准。

---

## 6. 包内文件

```
DreamEngine/
├ README-先读我.md
├ T0_7_aerender命令行说明.md
├ config/render_params.jsxinc    M0 定版参数
├ cep/com.dreamengine.panel/     DreamEngine M1 面板
├ docs/                          设计、任务、探针指南、M1 报告
├ names/                         名字数据与构建/校验工具
├ probe-results/AE2021/          M0 原始实测与结论
├ probes/                        AE 侧探针
└ tools/                         预览生成和静态测试
```

---

内容由 AI 生成
