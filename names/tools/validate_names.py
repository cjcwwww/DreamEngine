#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
validate_names.py —— 名字表准入校验、覆盖率统计、冲突清单自动生成

自动按表头识别两种 schema：
  A) 第一方表：matchName  cat_en  name_en  cat_zh  name_zh  zh_source  review
  B) 插件表  ：name_en    name_zh cat_en   cat_zh  zh_source sources  review
     （插件表 matchName 由 T0.1 实测后两段式 join 补齐，见设计文档 §5.7b）

review 取值：
  第一方表：ok | review（review=待与本机 displayName 对撞定论）
  插件表  ：ok | conflict（conflict=两个来源译名不一致，或来源为旧版清单）

用法：python3 validate_names.py 表1.tsv [表2.tsv ...]
产物：coverage-<表名>.md  +  conflicts-<表名>.md（仅插件表）
"""
import sys, os, collections

SRC_ENUM = {"helpx", "official", "community", "none"}
H_FIRST = ["matchName", "cat_en", "name_en", "cat_zh", "name_zh", "zh_source", "review"]
H_PLUGIN = ["name_en", "name_zh", "cat_en", "cat_zh", "zh_source", "sources", "review"]


def norm(s):
    return " ".join(str(s).split()).lower()


def validate(path):
    problems, rows, dups = [], [], {}
    with open(path, encoding="utf-8") as f:
        lines = [ln.rstrip("\n").rstrip("\r") for ln in f if ln.strip()]
    header = lines[0].split("\t")
    if header == H_FIRST:
        schema = "firstparty"
    elif header == H_PLUGIN:
        schema = "plugin"
    else:
        return "unknown", ["表头无法识别 schema：%s" % header], []

    for idx, ln in enumerate(lines[1:], start=2):
        parts = ln.split("\t")
        if len(parts) != 7:
            problems.append("L%d 字段数=%d（应为7）：%s" % (idx, len(parts), ln[:60]))
            continue
        if schema == "firstparty":
            mn, cat_en, name_en, cat_zh, name_zh, src, rev = parts
            key = mn
            if not mn.strip():
                problems.append("L%d matchName 为空" % idx)
            if not name_en.strip():
                problems.append("L%d name_en 为空：%s" % (idx, mn))
            if rev not in ("ok", "review"):
                problems.append("L%d review 非法（应为 ok|review）：%r" % (idx, rev))
            if src in ("helpx", "official", "community") and not name_zh.strip():
                problems.append("L%d 声称来源 %s 却无中文名：%s" % (idx, src, name_en))
            if src == "none" and name_zh.strip() and norm(name_zh) != norm(name_en):
                problems.append("L%d zh_source=none 但中文名与英文不一致（疑似机翻）：%s / %s" % (idx, name_en, name_zh))
            if cat_en and not cat_zh:
                problems.append("L%d cat_en 有值但 cat_zh 为空：%s" % (idx, cat_en))
            rows.append(dict(key=key, en=name_en, zh=name_zh, cat=cat_en, src=src, flag=rev, line=idx))
        else:
            name_en, name_zh, cat_en, cat_zh, src, sources, rev = parts
            key = norm(name_en)
            if not name_en.strip():
                problems.append("L%d name_en 为空" % idx)
            # 策略修订：不强求中文。name_zh 允许为空 = 该效果仅英文显示（合法状态）
            if src not in ("official", "community"):
                problems.append("L%d 插件表 zh_source 应为 official|community，实际 %r" % (idx, src))
            if src == "official" and not name_zh.strip():
                problems.append("L%d 声称官方中文却无 name_zh：%s" % (idx, name_en))
            if sources not in ("1", "2"):
                problems.append("L%d sources 应为 1 或 2，实际 %r" % (idx, sources))
            if rev not in ("ok", "conflict"):
                problems.append("L%d review 非法（应为 ok|conflict）：%r" % (idx, rev))
            if sources == "2" and rev == "conflict":
                problems.append("L%d sources=2 却标 conflict：请改为单源或消除分歧" % idx)
            zh_ready = 1 if (src == "official" and name_zh.strip()) else 0
            rows.append(dict(key=key, en=name_en, zh=name_zh, cat=cat_en, src=src,
                             flag=rev, line=idx, sources=sources, zh_ready=zh_ready))

    for r in rows:
        if r["key"] in dups:
            problems.append("L%d 键重复：%s（首见 L%d）" % (r["line"], r["en"], dups[r["key"]]))
        else:
            dups[r["key"]] = r["line"]
    return schema, problems, rows


def write_reports(path, schema, problems, rows, outdir):
    base = os.path.basename(path).replace(".tsv", "")
    cov_path = os.path.join(outdir, "coverage-%s.md" % base)
    cats = collections.Counter(r["cat"] for r in rows)
    srcs = collections.Counter(r["src"] for r in rows)
    flagged = [r for r in rows if r["flag"] != "ok"]
    two = [r for r in rows if r.get("sources") == "2"]

    L = ["# 覆盖率报告 · %s" % base, ""]
    L.append("- schema：%s" % schema)
    L.append("- 条目总数：**%d**" % len(rows))
    L.append("- 校验问题：**%d**（进包准入要求 0）" % len(problems))
    if schema == "plugin":
        ready = sum(1 for r in rows if r.get("zh_ready"))
        cand = sum(1 for r in rows if r["src"] == "community" and r["zh"].strip())
        enonly = sum(1 for r in rows if not r["zh"].strip())
        L.append("- **可直接显示中文**（官方级 / 已验证）：**%d**" % ready)
        L.append("- 社区候选译名（**默认不用于显示**，仅备查）：%d" % cand)
        L.append("- 仅英文（合法状态）：%d" % enonly)
        L.append("- 双源一致：%d" % len(two))
        L.append("")
        L.append("> 显示策略（不强求中文）：插件效果的中文名一律来自第三方汉化补丁，非官方。")
        L.append("> 因此中文模式下插件效果**默认仍显示英文原名**；只有被本机 displayName 对撞验证过的条目才启用中文名。")
    L.append("- %s：**%d**" % ("译名分歧（不阻塞，默认显示英文）" if schema == "plugin" else "待本机对撞确认", len(flagged)))
    L.append("")
    L.append("## 来源分布")
    for k, v in srcs.most_common():
        L.append("- `%s`：%d" % (k or "(空)", v))
    L.append("")
    L.append("## 分类分布")
    for k, v in sorted(cats.items(), key=lambda x: (-x[1], x[0])):
        L.append("- %s：%d" % (k or "(空)", v))
    if problems:
        L.append("")
        L.append("## 校验问题")
        for p in problems:
            L.append("- " + p)
    L.append("")
    with open(cov_path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))

    conf_path = None
    if schema == "plugin" and flagged:
        conf_path = os.path.join(outdir, "conflicts-%s.md" % base)
        C = ["# 译名冲突清单 · %s" % base, "",
             "生成方式：由 validate_names.py 从数据表自动导出，非手工罗列。",
             "",
             "含义：这些条目在两个来源之间译名不一致，或仅见于单一来源。",
             "处置：面板上显示主译名并在 hover 时提示存在分歧；等你本机 T0.1 拿到真实 displayName 后可自动定论。",
             "", "| 英文名 | 当前采用中文名 | 分类 | 来源数 |", "|---|---|---|---|"]
        for r in flagged:
            C.append("| %s | %s | %s | %s |" % (r["en"], r["zh"], r["cat"], r.get("sources", "-")))
        C.append("")
        with open(conf_path, "w", encoding="utf-8") as f:
            f.write("\n".join(C))
    return cov_path, conf_path, len(two), len(flagged)


if __name__ == "__main__":
    paths = sys.argv[1:]
    if not paths:
        print(__doc__)
        sys.exit(1)
    for p in paths:
        schema, problems, rows = validate(p)
        outdir = os.path.dirname(os.path.abspath(p))
        cov, conf, two, flagged = write_reports(p, schema, problems, rows, outdir)
        label = "分歧(不阻塞,默认显示英文)" if schema == "plugin" else "待本机对撞确认"
        print("\n### %s [%s]" % (os.path.basename(p), schema))
        print("  条目 %d ｜ 问题 %d ｜ %s %d%s" % (
            len(rows), len(problems), label, flagged,
            ("｜双源 %d" % two) if schema == "plugin" else ""))
        if conf:
            print("  冲突清单 → %s" % os.path.basename(conf))
        for x in problems[:12]:
            print("  ! " + x)
