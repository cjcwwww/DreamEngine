# 第一方名字表 · 缺口与待确认清单

生成时间：2026-11-03
配套：`names-firstparty.tsv`（266 条，校验 0 问题）
两侧数据源：docsforadobe 第一方 matchName 表（含 matchName + 英文名 + 分类）、Adobe helpx 中文「效果列表」（2026-05-13 更新，含中文分类 + 中文效果名）

---

## 1. 中文页有、matchName 表里没有的（需要 T0.1 实测补 matchName）

这类是**真实缺口**，不是遗漏：docsforadobe 那份表本身标注为 WIP，且落后于 AE 当前版本。

| 中文分类 | 中文效果名 | 备注 |
|---|---|---|
| 3D 通道 | Cryptomatte | 较新，matchName 表未收录 |
| 颜色校正 | 视频限幅器 | 对应 Video Limiter，matchName 不猜 |
| 杂色和颗粒 | 中间值（旧版） | 中文页单列，matchName 表未列 |
| Boris FX Mocha | Mocha AE | **整类缺失**（随 AE 附带的 Mocha） |
| 沉浸式视频 | VR 模糊 / VR 色差 / VR 颜色渐变 / VR 转换器 / VR 降噪 / VR 数字故障 / VR 分形杂色 / VR 发光 / VR 平面到球面 / VR 旋转球面 / VR 锐化 / VR 球面到平面 | **整类 12 项缺失** |

**处置方式**：不猜 matchName。等 T0.1 在你机器上实测出全量 `matchName + displayName`，用"中文名完全等于 displayName"反向匹配即可自动补上一大半，补不上的进 L-C 兜底。

---

## 2. matchName 表有、中文页没有的

| 分类 | 英文名 | 处置 |
|---|---|---|
| Synthetic Aperture | SA Color Finesse 3 | 中文页已无此类。按规则降级：`zh_source=none`，中文位显示英文名，**不机翻** |

---

## 3. 有意不入库（不是缺口）

- **过时 / Obsolete 两个类别**（docsforadobe 的 `Obsolete` 与 `_Obsolete`，中文页的「过时」9 项 + 旧版条目）
  理由：预览墙 L1 不给旧版效果做图，名字表也就用不上。若 T0.1 实测发现你机器上的项目还在用某个旧版效果，再单独入库即可。

---

## 4. 待人工确认（review=6 条）

这几条的中文译名我有依据但不敢说是你那个版本的确切译法，标了 `review`：

| matchName | 英文名 | 我填的中文 | 存疑原因 |
|---|---|---|---|
| ADBE Unsharp Mask2 | Unsharp Mask | 钝化蒙版 | 历史译名出现过「反锐化掩蔽」 |
| APC Colorama | Colorama | 色光 | 中文页该项与前后项对齐时最易错位 |
| APC Vegas | Vegas | 勾画 | 专有名词不翻译，社区也用过「维加斯」 |
| CC Mr. Smoothie | CC Mr. Smoothie | CC 像素溶解 | 该效果中文名与英文名几乎无字面关联 |
| CC WarpoMatic | CC WarpoMatic | CC 溶解 | 同上，字面无关，靠位置对齐 |
| SYNTHAP CF Color Finesse 2 | SA Color Finesse 3 | （无中文，降级为英文名） | 中文页无此类 |

**这 6 条不需要你肉眼核对**：T0.1 输出的 `displayName` 就是本机中文界面真实译名，脚本做一次对撞即可自动定论——`review` 标记的存在就是为了这一步。

---

## 5. 分类中英映射（面板"分类 · 归属"那一栏要用）

3D Channel→3D 通道 ｜ Audio→音频 ｜ Blur & Sharpen→模糊和锐化 ｜ Channel→声道 ｜
CINEMA 4D→CINEMA 4D ｜ Color Correction→颜色校正 ｜ Distort→扭曲 ｜
Expression Controls→表达式控制 ｜ Generate→生成 ｜ Keying→抠像 ｜ Matte→遮罩 ｜
Noise & Grain→杂色和颗粒 ｜ Perspective→透视 ｜ Simulation→模拟 ｜ Stylize→风格化 ｜
Text→文本 ｜ Time→时间 ｜ Transition→过渡 ｜ Utility→实用工具 ｜
（中文页另有：Boris FX Mocha、沉浸式视频、过时）

---

内容由 AI 生成
