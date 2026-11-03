# names 数据层 · 说明

M0.5（名字数据流水线）的工作目录。产出的是**数据文件**，不是产品代码。

---

## 1. TSV schema（所有名字表统一）

```
matchName  cat_en  name_en  cat_zh  name_zh  zh_source  review
```
制表符分隔，7 列，首行表头。

| 字段 | 取值与规则 |
|---|---|
| `matchName` | **主键**。跨语言、跨 AE 版本不变。绝不使用 displayName 做匹配 |
| `cat_en` / `cat_zh` | 效果菜单分类。`cat_zh` 来自 Adobe 中文官方页 |
| `name_en` / `name_zh` | 效果名双语。面板按语言设置取对应列 |
| `zh_source` | 枚举：`official`（厂商官方中文）/ `helpx`（Adobe 中文官方页）/ `community`（社区汉化译名，**只备查不显示**）/ `none`（无中文来源） |
| `review` | `ok` 或 `review`（待本机 displayName 对撞定论） |

**硬规则（校验脚本强制）**
1. `matchName` 非空且唯一（插件表以归一化后的 `name_en` 为唯一键）
2. `zh_source` ∈ 上表枚举；`review` ∈ `ok|review`
3. 声称 `official/helpx/community` 却 `name_zh` 为空 → 报错（**仅对第一方表强制**）
4. `zh_source=none` 时，`name_zh` **必须等于** `name_en`（宁可不译，绝不机翻）
5. `cat_en` 有值则 `cat_zh` 不能为空（无官方中文分类时同值降级）
6. **插件表允许 `name_zh` 为空**：只含英文名是合法终态，不是数据缺失
7. **插件表的 `community` 译名一律不参与显示**，除非被本机 `displayName` 印证（见 §3 的 `zh_status`）

---

## 2. 校验与覆盖率报告

```
python3 tools/validate_names.py names-firstparty.tsv
```
行为：逐行校验上述 5 条规则 → 打印问题 → 生成 `coverage-<表名>.md`（条目数、来源分布、分类分布、待确认清单）。
**准入判据：问题数为 0 才允许进产品包。**

当前状态：`names-firstparty.tsv` 266 条，问题 0，待确认 6（见 `gaps-firstparty.md`）。

---

## 3. 插件名字表的键设计（重要变更）

第三方插件的 matchName **没有公开权威清单**，网上能拿到的是「英文名 ↔ 中文名」对照（厂商与社区都按显示名组织，不按 matchName）。

所以插件表**不硬套 matchName 主键**，改成两段式：

```
第一段（现在能做的）：name_en → name_zh / cat_zh / 插件包 / 来源 / 置信度
第二段（T0.1 之后）：把插件表按 name_en 与实测的 (matchName, displayName) 对撞
                     → 命中即获得 matchName，写入最终表；未命中标 unmatched
```

对撞时的坑（已进风险清单）：
- 汉化版插件的 `displayName` 本身就是中文 → 用「插件表 name_zh 完全等于 displayName」也能命中，等于**双向对撞**
- 大小写与空格差异 → 归一化（去首尾空格、压缩多空格、大小写不敏感）后再比
- 版本迭代导致的增删名 → 记录 unmatched 清单，人工补

最终产物仍是 `matchName` 主键的统一表，插件侧只是构建过程中多一步 join。

---

## 4. 批次计划与进度

| 批次 | 内容 | 状态 |
|---|---|---|
| B1 | 第一方效果（除过时类）266 条 | ✅ 完成，校验 0 问题，6 条待 T0.1 对撞定论 |
| B1-gap | VR 系列 12 项、Cryptomatte、视频限幅器、Mocha AE 等 matchName 缺失项 | ⏳ 等 T0.1 实测对撞 |
| B2 | **BCC / Boris Continuum**：329 条英文名 + 候选译名入库（排除 Obsolete 类），主源 LookAE 2026.5 v19.5.0 | ✅ 完成，校验 0 问题。132 条译名分歧**不再是待办**——按最终策略，未经验证的社区译名一律不显示 |
| B3 | **Sapphire**：英文名目录（主源 LookAE 2026.5.2，约 292 条） | 降级为可选——中文交叉核对已取消 |
| B4 | Red Giant 系（Trapcode / Magic Bullet / VFX / Universe）英文名目录 | 降级为可选——同上 |
| B5 | Video Copilot、Element 3D、X-Particles、Re:Map、Toolchefs | **取消**——英文名运行时天然可得，无需预置 |

---

## 5. B2 出来的两个硬结论（影响设计）

**一、第三方插件不存在 `official` 级中文名。**
Boris FX 中文站明确写着官方未推出中文版 Sapphire/BCC，中文显示名全部来自第三方汉化补丁。所以插件侧的可达上限就是"社区双源一致"，永远升不到官方级——面板上第三方中文名必须带来源标识，不能与第一方中文名用同一套视觉权重。

**二、社区源之间分歧极大，必须定一个"主源"。**
BCC 329 条里只有 33 条能被第二个来源印证；132 条存在分歧。原因是第二来源（韬客那份）是老版清单的机翻风格译名（如 BCC Rings Wipe 译成"戒指擦"、Median 译成"中间的"、Witness Protection 译成"证人保护"），且不含新版 `BCC+` 系列。
→ 处置规则：**以 LookAE 按具体汉化版本整理的表为主源**，其他表只用于"发现分歧"，不用于覆盖译名。分歧条目在面板 hover 提示，等你本机 T0.1 拿到真实 displayName 自动定论。

**三、最终策略：不强求中文名（本轮由用户拍板）。**
插件效果的中文名本质是汉化产物，属于"品牌名/专有名词"，不该由我代为翻译或转抄。因此：

- 中文模式只对**第一方效果**显示官方中文名；**第三方效果默认显示英文原名**
- 插件表里的社区译名降格为**候选池**：保留数据（将来对撞有用），但不参与显示
- 语言设置回退两态（`中文` / `English`），不再需要第三态
- `join_matchnames.py` 新增 `zh_status` 字段自动判定：`zh_verified`（本机名字与候选一致）/ `zh_replaced`（本机有中文名但与候选不同，以本机为准）/ `en_only`（本机显示英文，候选不启用）/ `no_host_match`
- 效果只含英文名是**正常终态**，覆盖率报告把"仅英文（合法状态）"当正向指标

---

## 6. 工具用法

```
# 准入校验（自动按表头识别 schema，产出覆盖率与冲突清单）
python3 tools/validate_names.py names-firstparty.tsv names-bcc.tsv

# T0.1 出来后：把实测清单与插件表对撞，补 matchName + 复核第一方中文名
python3 tools/join_matchnames.py <T0_1实测.tsv> names-bcc.tsv names-firstparty.tsv
```

`join_matchnames.py` 已用 6 条合成样本自测通过：英文命中、**汉化包中文 displayName 反向命中**、未命中、同名多命中四条路径都跑通，并且成功抓出"钝化蒙版 / 反锐化蒙版"这类第一方译名不一致。自测产物已清理，不留在目录里。


---

内容由 AI 生成
