# 插件包收录策略表（喂给 plugins-map.json 与前缀推断规则）

状态：BCC 已完成入库（329 条）。本表是剩余 9 个包的**取数策略**，不是数据本身。
标注约定：`待确认` = 我没有可靠来源，不会写成事实；这些点要么靠 T0.1 实测解决，要么后续单独查证。

| 插件包 | 效果名规律（英文名层面） | matchName 前缀线索 | 官方是否有中文名 | 可用来源 | 预计条目 | 下一步 |
|---|---|---|---|---|---|---|
| **BorisFX Sapphire** | 全部以 `S_` 开头（如 S_Glow、S_LensFlare、S_WarpBubble） | `S_` + CamelCase | ❌ 无（Boris FX 中文站明确靠第三方汉化补丁） | 主源 LookAE `sapphire-en-zh`（2026.5.2，约 292 条，10 分类）；第二源 B 站中英对照表（`s_辉光=s_glow` 形式，能给出 matchName 小写线索）；第三源 百度文库/人人文库 2011 旧表 | ~292 | **B3**：抓主源整表入库，用第二源做分歧标注；旧表只用于发现"版本改名"，不用于覆盖 |
| **Boris BCC** | 以 `BCC ` 开头，新版子集为 `BCC+` | 待确认（`BCC_` 形式需实测） | ❌ 无 | ✅ 已入库：LookAE 2026.5 v19.5.0 主源；韬客旧版表作分歧探测 | 329（已完） | 完成，等 T0.1 对撞补 matchName |
| **Red Giant Trapcode Suite** | 效果名≈产品名（Particular / Form / Mir / 3D Stroke / Shine / Starglow / Sound Keys / Lux / Tao / Echospace / Horizon / Geo / Grow Bounds，共 13 款） | 待确认 | ⚠️ 部分：Maxon 中文页有**产品级**中文叫法，效果级中文名基本来自社区 | 厂商中文页 + 中文资源站两处一致才算双源（图层云 / 龋齿一号 / Maxon 中文页） | ~15-30 | **B4a**：先确认 AE 里效果级 displayName 是否等于产品名（可能带 "Trapcode " 前缀）——这条决定整包结构 |
| **Red Giant Magic Bullet** | 产品名（Looks / Colorista V / Cosmo II / Mojo II / Film / Denoiser III / Renoiser / Parametric Curve） | 待确认 | ⚠️ 产品级有社区译名（调色师 / 润肤磨皮 / 电影质感 / 降噪 / 噪波颗粒 / 参数曲线） | 同上，需两站交叉 | ~8-15 | **B4b**：并入 B4a 的口径确认 |
| **Red Giant VFX Suite** | 产品名（Real Lens Flares / Supercomp / Primatte Keyer / Bang / King Pin Tracker / Lens Distortion Matcher / Spot Clone Tracker / Optical Glow / Chromatic Displacement / Knoll Light Factory / Shadow / Reflection） | 待确认 | ⚠️ 社区译名较丰富（抠像 / 镜头失真匹配 / 色差扭曲 / 智能辉光 / 图钉跟踪 / 物体移除替换克隆跟踪 / 超强特效合成 / 3D 枪口闪光） | 中文资源站多个页面措辞接近一致，可做双源交叉 | ~12-20 | **B4c** |
| **Red Giant Universe** | 有明确分类组（RG Blurs and Glows / RG Color / RG Distortions / RG Generators / RG Motion Graphics / RG Stylize / RG Text / RG Transitions / RG Utilities）+ 具名效果（Chromatic Aberration / VHS / Glitch / Holomatrix II / Electrify / Analog / Texturize Motion / Glow / Quantum / Glimmer / Retrograde / Finisher / Multitone / Reframe / Array Gun / Progresso / Logo Motion / Line / HUD Components / Spectralicious / Fractal Background / Soft Gradient Background / Turbulence Noise / Gradient Ramp） | 待确认 | ⚠️ 少量社区译名（故障 / 色差 / 光晕 等，覆盖面低） | Adobe 官方第三方插件列表页（含完整英文效果名，可作主源英文名）；中文侧多为单源 | ~25-60（待核） | **B4d**：英文名来源可靠，中文名预计大量落 `zh_source=none` → 直接显示英文 |
| **Video Copilot**（Saber / Element 3D / 其他免费包） | 产品名本身（Saber、Element 3D 等），Saber 在 AE 里以形状/图层生成器形态出现，参数化子效果多 | 待确认 | ❌ 基本无官方中文，社区译名不统一（"光剑"是产品描述不是效果名） | 社区教程为主，质量低 | 少（每包 1-3 个主效果） | **B5a**：预计大量走 L-C 兜底，投入产出比低，建议只收产品级 1-2 条 |
| **Signage X-Particles** | 效果名以 `xp` 开头（如 xpEmitter、xpModificator、xpSystem） | `xp` 系列（待实测确认） | ❌ 无官方中文 | 官方英文文档可用；中文基本是教程描述 | 数十条 | **B5b**：英文名可整理，中文名统一落 `none` |
| **Re:Map** | 厂商与效果命名规律**我不确定**，不做猜测 | 待确认 | 待确认 | 待查证 | 待确认 | **B5c**：先查厂商与版本，再决定是否值得入库 |
| **Toolchefs** | 产品线为 Kodex / Effekt / Anima / Trigger 等，前缀线索疑为 `TC `（待确认） | 待确认 | ❌ 无官方中文 | 官方英文页可用 | 待确认 | **B5d**：同 Re:Map，先核实再入库 |

---

## 三条从策略表直接得出的判断

1. **十个包里有 7 个"官方中文名不存在"**。中文显示名全部来自汉化补丁，那么由我转抄或代译就没有正当性——**插件效果名属于专有名词/品牌名，本就不该翻译**。最终策略（设计文档 §5.4 规则 7）：插件效果**默认只含英文名**，社区译名降为候选池、不参与显示；只有 T0.1 对撞出你机器上真实的中文 displayName 才启用。语言设置因此维持两态，不需要第三态。

2. **真正能做成双源的只有 Sapphire / BCC / VFX Suite**（中文社区确实整理了对照表），但在新策略下这件事从"必须"降级为"锦上添花"。

3. **取数范围因此大幅收缩**：B3/B4 只剩"英文效果名目录"这半个问题，而英文名运行时 `app.effects` 本来就有 → 等于**不必预先抓取**；**B5 四个包直接取消**。M0.5 的完工定义改为：第一方双语表 + 已入库的英文名候选池 + 两个自动化工具 —— **这三样本轮已全部完成**。

---

## 附：主源/次源使用纪律

- 主源：按具体汉化版本整理、且给出成体系的分类分组的对照表
- 次源：**只用来发现分歧，不用来覆盖主源译名**
- 旧版清单（不含新版 `BCC+` / `S_` 新增项的那类）：只用于识别"版本改名/下架"，不参与译名裁决
- 机翻特征明显的来源（例：Rings Wipe→"戒指擦"、Median→"中间的"、Witness Protection→"证人保护"、Light Wrap→"光包"）：标记为不可作主源

---

内容由 AI 生成
