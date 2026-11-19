#!/usr/bin/env python3
"""Builds data/index.json - the list of stored days that the dashboard reads.

Run automatically by the GitHub workflow after each download.
Counts are cached, so only new zip files are opened.
"""
import json
import os
import sys
import zipfile
from datetime import datetime, timezone

DATA = sys.argv[1] if len(sys.argv) > 1 else "data"
ZIP_DIR = os.path.join(DATA, "zip")
INDEX = os.path.join(DATA, "index.json")


def count_domains(path):
    with zipfile.ZipFile(path) as zf:
        return sum(
            1
            for name in zf.namelist() if not name.endswith("/")
            for line in zf.read(name).splitlines() if line.strip()
        )


def main():
    cached = {}
    if os.path.exists(INDEX):
        try:
            with open(INDEX, encoding="utf-8") as f:
                cached = {d["date"]: d for d in json.load(f).get("days", [])}
        except Exception:
            cached = {}

    days = []
    for name in sorted(os.listdir(ZIP_DIR)) if os.path.isdir(ZIP_DIR) else []:
        if not name.endswith(".zip"):
            continue
        date = name[:-4]
        path = os.path.join(ZIP_DIR, name)
        size = os.path.getsize(path)
        old = cached.get(date)
        if old and old.get("bytes") == size:
            days.append(old)
            continue
        try:
            days.append({"date": date, "domains": count_domains(path), "bytes": size})
        except zipfile.BadZipFile:
            print(f"skipping bad zip: {name}")

    out = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "days": days,
    }
    with open(INDEX, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    print(f"index.json: {len(days)} days, {sum(d['domains'] for d in days):,} domains")


if __name__ == "__main__":
    main()
