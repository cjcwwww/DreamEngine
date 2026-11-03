#!/usr/bin/env python3

import csv
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FIRST_PARTY = ROOT / "names" / "names-firstparty.tsv"
BCC = ROOT / "names" / "joined-names-bcc.tsv"
OUTPUT = ROOT / "cep" / "com.dreamengine.panel" / "data" / "names.json"
TSV_OUTPUT = ROOT / "cep" / "com.dreamengine.panel" / "data" / "names.tsv"


def read_tsv(path):
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle, delimiter="\t"))


def main():
    by_match_name = {}

    for row in read_tsv(FIRST_PARTY):
        match_name = row["matchName"].strip()
        if not match_name:
            continue
        by_match_name[match_name] = {
            "matchName": match_name,
            "nameEn": row["name_en"].strip(),
            "nameZh": row["name_zh"].strip() or None,
            "categoryEn": row["cat_en"].strip(),
            "categoryZh": row["cat_zh"].strip(),
            "pluginHint": "内置",
            "nameZhSource": row["zh_source"].strip(),
            "review": row["review"].strip(),
        }

    for row in read_tsv(BCC):
        match_name = row["matchName"].strip()
        if not match_name or row["join_status"] != "matched_en":
            continue
        verified = row["zh_status"] in {"zh_verified", "zh_replaced"}
        by_match_name[match_name] = {
            "matchName": match_name,
            "nameEn": row["name_en"].strip(),
            "nameZh": row["name_zh"].strip() if verified else None,
            "categoryEn": row["cat_en"].strip(),
            "categoryZh": row["cat_zh"].strip(),
            "pluginHint": "BCC",
            "nameZhSource": row["zh_source"].strip(),
            "review": row["review"].strip(),
        }

    items = sorted(
        by_match_name.values(),
        key=lambda item: (
            item["pluginHint"],
            item["categoryEn"],
            item["nameEn"].lower(),
        ),
    )
    payload = {
        "version": 1,
        "generatedFrom": [
            "names/names-firstparty.tsv",
            "names/joined-names-bcc.tsv",
        ],
        "count": len(items),
        "items": items,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {OUTPUT} ({len(items)} items)")

    # 与 names.json 同源再产一份 TSV：ExtendScript 侧没有 JSON.parse，
    # engine/names.jsx 直接读这份文件做三层解析。
    write_tsv(items, TSV_OUTPUT)


TSV_COLUMNS = [
    "matchName",
    "nameEn",
    "nameZh",
    "categoryEn",
    "categoryZh",
    "pluginHint",
    "nameZhSource",
]


def write_tsv(items, path):
    lines = ["\t".join(TSV_COLUMNS)]
    for item in items:
        cells = []
        for column in TSV_COLUMNS:
            value = item.get(column)
            cells.append("" if value is None else str(value).replace("\t", " "))
        lines.append("\t".join(cells))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {path} ({len(items)} rows)")


if __name__ == "__main__":
    main()
