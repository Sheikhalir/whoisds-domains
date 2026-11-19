#!/usr/bin/env python3
"""Prepares the data the dashboard reads. Run automatically after each download.

Writes:
  data/index.json             list of stored days, domain counts, niche counts
  data/niches/YYYY-MM-DD.json the domains of that day that match a niche,
                              with the matched keyword and any location found

Niches and locations come from niches.json. If you edit that file, every
stored day is sorted again on the next run.
"""
import hashlib
import json
import os
import re
import sys
import zipfile
from datetime import datetime, timezone

DATA = sys.argv[1] if len(sys.argv) > 1 else "data"
CONFIG = sys.argv[2] if len(sys.argv) > 2 else "niches.json"
ZIP_DIR = os.path.join(DATA, "zip")
NICHE_DIR = os.path.join(DATA, "niches")
INDEX = os.path.join(DATA, "index.json")


def load_config(path):
    raw = open(path, "rb").read()
    cfg = json.loads(raw)
    niches = []
    for n in cfg["niches"]:
        niches.append({
            "id": n["id"],
            "keywords": [k.lower().replace("-", "") for k in n.get("keywords", []) if k],
            "exclude": [e.lower().replace("-", "") for e in n.get("exclude", []) if e],
            "fallback": bool(n.get("only_if_no_other")),
        })
    locations = sorted(((k.lower(), v) for k, v in cfg.get("locations", [])), key=lambda kv: -len(kv[0]))
    return niches, locations, hashlib.sha1(raw).hexdigest()[:12]


def label_of(domain):
    """'Dallas-Roofing-Pros.com' -> 'dallasroofingpros'"""
    return domain.lower().split(".")[0].replace("-", "")


def match_niche(niche, label):
    text = label
    for ex in niche["exclude"]:
        text = text.replace(ex, "|")
    for kw in niche["keywords"]:
        if kw in text:
            return kw
    return None


_ANY = None


def classify(domain, niches, locations):
    global _ANY
    if _ANY is None:  # one combined pattern: quickly skips the ~90% of domains that match nothing
        _ANY = re.compile("|".join(sorted({re.escape(k) for n in niches for k in n["keywords"]}, key=len, reverse=True)))
    label = label_of(domain)
    if not _ANY.search(label):
        return None
    ids, kws = [], []
    for n in niches:
        if n["fallback"]:
            continue
        kw = match_niche(n, label)
        if kw:
            ids.append(n["id"]); kws.append(kw)
    if not ids:
        for n in niches:
            if n["fallback"]:
                kw = match_niche(n, label)
                if kw:
                    ids.append(n["id"]); kws.append(kw)
    if not ids:
        return None
    loc = next((name for key, name in locations if key in label), "")
    return [domain, ids, kws, loc]


def read_domains(path):
    with zipfile.ZipFile(path) as zf:
        out = []
        for name in zf.namelist():
            if name.endswith("/"):
                continue
            for line in zf.read(name).decode("utf-8", "replace").splitlines():
                line = line.strip()
                if line:
                    out.append(line)
        return out


def main():
    niches, locations, cfg_hash = load_config(CONFIG)
    os.makedirs(NICHE_DIR, exist_ok=True)

    cached, old_hash = {}, None
    if os.path.exists(INDEX):
        try:
            with open(INDEX, encoding="utf-8") as f:
                old = json.load(f)
            old_hash = old.get("niche_config")
            cached = {d["date"]: d for d in old.get("days", [])}
        except Exception:
            pass

    days, redone = [], 0
    names = sorted(n for n in os.listdir(ZIP_DIR) if n.endswith(".zip")) if os.path.isdir(ZIP_DIR) else []
    for name in names:
        date = name[:-4]
        path = os.path.join(ZIP_DIR, name)
        size = os.path.getsize(path)
        niche_file = os.path.join(NICHE_DIR, date + ".json")
        prev = cached.get(date)
        if prev and prev.get("bytes") == size and old_hash == cfg_hash and "niches" in prev and os.path.exists(niche_file):
            days.append(prev)
            continue
        try:
            domains = read_domains(path)
        except zipfile.BadZipFile:
            print(f"skipping bad zip: {name}")
            continue
        rows = [r for r in (classify(d, niches, locations) for d in domains) if r]
        counts = {}
        for r in rows:
            for i in r[1]:
                counts[i] = counts.get(i, 0) + 1
        with open(niche_file, "w", encoding="utf-8") as f:
            json.dump({"date": date, "rows": rows}, f, separators=(",", ":"))
        days.append({"date": date, "domains": len(domains), "bytes": size,
                     "matched": len(rows), "niches": counts})
        redone += 1

    # remove niche files whose zip is gone
    keep = {d["date"] + ".json" for d in days}
    for f in os.listdir(NICHE_DIR):
        if f.endswith(".json") and f not in keep:
            os.remove(os.path.join(NICHE_DIR, f))

    out = {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "niche_config": cfg_hash, "days": days}
    with open(INDEX, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    total = sum(d["domains"] for d in days)
    matched = sum(d["matched"] for d in days)
    print(f"index.json: {len(days)} days ({redone} processed), {total:,} domains, {matched:,} in niches")


if __name__ == "__main__":
    main()
