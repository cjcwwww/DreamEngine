#!/usr/bin/env python3

import csv
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FIRST_PARTY = ROOT / "names" / "names-firstparty.tsv"
BCC = ROOT / "names" / "joined-names-bcc.tsv"
OUTPUT = ROOT / "cep" / "com.dreamengine.panel" / "data" / "names.json"


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


if __name__ == "__main__":
    main()
