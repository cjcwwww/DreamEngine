#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
join_matchnames.py —— 插件名字表 ↔ 本机实测效果清单 的两段式对撞（设计文档 §5.7b）

输入：
  1) T0_1_效果枚举.tsv ：由 T0.1 探针输出的实测结果，三列 matchName / displayName / category
     （探针原始输出是 .txt，先跑 to_stable 里的 convert_t01() 转成 tsv；见文末说明）
  2) 一个或多个插件表（schema B：name_en name_zh cat_en cat_zh zh_source sources review）

输出：
  joined-<表名>.tsv  多两列：matchName, join_status（matched_en / matched_zh / unmatched）
  unmatched-<表名>.md 未命中清单（需要人工补或走 L-C 兜底）
  同时对第一方表做一次复核：本机 displayName 与表内 name_zh 不一致的条目列为 mismatch

归一化规则（防大小写/空格/全半角导致的假阴性）：
  去首尾空格 → 连续空格压成 1 → 小写 → 全角括号转半角 → 去掉常见前后缀 "BCC "/"BCC+" 保留
"""
import sys, os, re, collections


def norm(s):
    s = str(s).strip()
    s = s.replace("（", "(").replace("）", ")").replace("　", " ")
    s = re.sub(r"\s+", " ", s)
    return s.lower()


def load_detected(path):
    """读实测清单：matchName \t displayName \t category"""
    rows = []
    with open(path, encoding="utf-8") as f:
        lines = [ln.rstrip("\n").rstrip("\r") for ln in f if ln.strip()]
    start = 1 if lines and lines[0].split("\t")[0].strip().lower() == "matchname" else 0
    for ln in lines[start:]:
        p = ln.split("\t")
        if len(p) < 2:
            continue
        rows.append({"mn": p[0].strip(), "disp": p[1].strip(),
                     "cat": p[2].strip() if len(p) > 2 else "", "nd": norm(p[1])})
    return rows


def join_plugin_table(table, detected, outdir):
    by_en = {}
    by_zh = {}
    for d in detected:
        by_en.setdefault(d["nd"], []).append(d)
        # 汉化包场景：displayName 本身就是中文，用中文列再建一次索引
        if re.search(r"[\u4e00-\u9fff]", d["disp"]):
            by_zh.setdefault(norm(d["disp"]), []).append(d)

    with open(table, encoding="utf-8") as f:
        lines = [ln.rstrip("\n").rstrip("\r") for ln in f if ln.strip()]
    header = lines[0].split("\t")
    assert header[0] == "name_en", "非插件表 schema：%s" % header

    out_rows, unmatched, ambiguous = [], [], []
    multi = 0
    for ln in lines[1:]:
        p = ln.split("\t")
        name_en, name_zh = p[0], p[1]
        hits = by_en.get(norm(name_en)) or by_zh.get(norm(name_zh)) or []
        hit = hits[0] if hits else None
        # 显示策略落地：中文列只有被本机 displayName 印证后才算 verified
        if hit is None:
            zh_status = "no_host_match"
        elif not name_zh.strip():
            zh_status = "en_only"
        elif norm(hit["disp"]) == norm(name_zh):
            zh_status = "zh_verified"
        elif re.search(r"[\u4e00-\u9fff]", hit["disp"]):
            zh_status = "zh_replaced"   # 本机有中文名但与候选不同 → 以本机为准
        else:
            zh_status = "en_only"       # 本机显示英文原名 → 候选译名不启用
        if len(hits) == 1:
            status = "matched_en" if norm(name_en) in by_en else "matched_zh"
            out_rows.append(p + ([hit["mn"], status, zh_status] if hit else ["", "unmatched", zh_status]))
        elif len(hits) > 1:
            multi += 1
            mns = "|".join(h["mn"] for h in hits)
            out_rows.append(p + [mns, "ambiguous", zh_status])
            ambiguous.append((name_en, name_zh, mns))
        else:
            out_rows.append(p + ["", "unmatched", zh_status])
            unmatched.append((name_en, name_zh, p[2]))

    base = os.path.basename(table).replace(".tsv", "")
    jp = os.path.join(outdir, "joined-%s.tsv" % base)
    with open(jp, "w", encoding="utf-8") as f:
        f.write("\t".join(header + ["matchName", "join_status", "zh_status"]) + "\n")
        for r in out_rows:
            f.write("\t".join(r) + "\n")

    up = os.path.join(outdir, "unmatched-%s.md" % base)
    st = collections.Counter(r[-2] for r in out_rows)
    zst = collections.Counter(r[-1] for r in out_rows)
    with open(up, "w", encoding="utf-8") as f:
        f.write("# 对撞结果 · %s\n\n" % base)
        f.write("- 实测效果条数：%d\n" % len(detected))
        for k in ("matched_en", "matched_zh", "ambiguous", "unmatched"):
            f.write("- %s：%d\n" % (k, st.get(k, 0)))
        f.write("\n### 中文显示就绪度（不强求中文后的真实状态）\n\n")
        for k in ("zh_verified", "zh_replaced", "en_only", "no_host_match"):
            f.write("- %s：%d\n" % (k, zst.get(k, 0)))
        f.write("- 说明：只有 `zh_verified` / `zh_replaced` 两条允许在中文模式显示中文名；"
                "`en_only` 与 `no_host_match` 一律显示英文原名\n")
        f.write("\n## 未命中（走 L-C 兜底或人工补）\n\n")
        for en, zh, cat in unmatched:
            f.write("- %s ｜ %s ｜ %s\n" % (en, zh, cat))
        if ambiguous:
            f.write("\n## 同名多命中（需人工挑 matchName）\n\n")
            for en, zh, mns in ambiguous:
                f.write("- %s ｜ %s ｜ 候选：%s\n" % (en, zh, mns))
        f.write("\n")
    return jp, up, {"j": st, "z": zst}


def recheck_firstparty(table, detected, outdir):
    """第一方复核：表内 name_zh 与本机 displayName 是否一致"""
    with open(table, encoding="utf-8") as f:
        lines = [ln.rstrip("\n").rstrip("\r") for ln in f if ln.strip()]
    disp = {d["mn"]: d["disp"] for d in detected}
    missing, mismatch = [], []
    for ln in lines[1:]:
        p = ln.split("\t")
        if len(p) != 7:
            continue
        mn, name_en, name_zh = p[0], p[2], p[4]
        if mn not in disp:
            missing.append((mn, name_en))
        elif norm(disp[mn]) != norm(name_zh):
            mismatch.append((mn, name_en, name_zh, disp[mn]))
    rp = os.path.join(outdir, "recheck-firstparty.md")
    with open(rp, "w", encoding="utf-8") as f:
        f.write("# 第一方名字表本机复核\n\n")
        f.write("- 本机实测中找不到的 matchName：%d（多为版本差异或旧版移除）\n" % len(missing))
        f.write("- 中文名与本机 displayName 不一致：%d（以本机为准覆盖，并标 review）\n\n" % len(mismatch))
        if mismatch:
            f.write("| matchName | 英文名 | 表内中文 | 本机实际中文 |\n|---|---|---|---|\n")
            for mn, en, zh, real in mismatch:
                f.write("| %s | %s | %s | %s |\n" % (mn, en, zh, real))
        if missing:
            f.write("\n## 本机没有的条目\n\n")
            for mn, en in missing:
                f.write("- %s ｜ %s\n" % (mn, en))
        f.write("\n")
    return rp, len(missing), len(mismatch)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    detected_path = sys.argv[1]
    tables = sys.argv[2:]
    detected = load_detected(detected_path)
    print("实测效果条数：%d" % len(detected))
    for t in tables:
        outdir = os.path.dirname(os.path.abspath(t))
        with open(t, encoding="utf-8") as f:
            head = f.readline().rstrip("\n").split("\t")
        if head[0] == "name_en":
            jp, up, st = join_plugin_table(t, detected, outdir)
            print("%s → matched_en %d / matched_zh %d / ambiguous %d / unmatched %d ｜ 中文就绪 %d"
                  % (os.path.basename(t), st["j"].get("matched_en", 0), st["j"].get("matched_zh", 0),
                     st["j"].get("ambiguous", 0), st["j"].get("unmatched", 0),
                     st["z"].get("zh_verified", 0) + st["z"].get("zh_replaced", 0)))
            print("   joined → %s\n   清单   → %s" % (os.path.basename(jp), os.path.basename(up)))
        else:
            rp, miss, mm = recheck_firstparty(t, detected, outdir)
            print("%s → 本机缺失 %d ／ 中文不一致 %d（详见 %s）"
                  % (os.path.basename(t), miss, mm, os.path.basename(rp)))
