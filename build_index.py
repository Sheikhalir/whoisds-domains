#!/usr/bin/env python3
"""Prepares the data the dashboard reads. Run automatically after each download.

Writes:
  data/index.json             list of stored days, domain counts, niche counts
  data/niches/YYYY-MM-DD.json the domains of that day that match a niche,
                              with the matched keyword and any location found

Niches and locations come from niches.json; your own seed keywords come from
seeds.json (edited from the dashboard). If either file changes, every stored
day is sorted again on the next run.

Usage:
  python build_index.py [data] [niches.json] [seeds.json]
  python build_index.py --csv YYYY-MM-DD out.csv     (one day's niche matches as CSV)
"""
import csv
import hashlib
import json
import os
import re
import sys
import zipfile
from datetime import datetime, timezone

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
DATA = "data" if "--csv" in sys.argv else (ARGS[0] if len(ARGS) > 0 else "data")
CONFIG = "niches.json" if "--csv" in sys.argv else (ARGS[1] if len(ARGS) > 1 else "niches.json")
SEEDS = "seeds.json" if "--csv" in sys.argv else (ARGS[2] if len(ARGS) > 2 else "seeds.json")
ZIP_DIR = os.path.join(DATA, "zip")
NICHE_DIR = os.path.join(DATA, "niches")
INDEX = os.path.join(DATA, "index.json")


def norm(words):
    out = [re.sub(r"[^a-z0-9]", "", str(w).lower()) for w in words or []]
    return [w for w in out if w]


def signature(n):
    """Must match seedSig() in index.html - tells the dashboard which seeds are already processed."""
    return ",".join(sorted(n["keywords"])) + "|" + ",".join(sorted(n["exclude"]))


def load_config(path, seeds_path=None):
    raw = open(path, "rb").read()
    cfg = json.loads(raw)
    seeds_raw = b""
    seeds = []
    if seeds_path and os.path.exists(seeds_path):
        seeds_raw = open(seeds_path, "rb").read()
        try:
            seeds = json.loads(seeds_raw or b"{}").get("seeds", [])
        except json.JSONDecodeError as e:
            print(f"WARNING: {seeds_path} is not valid JSON ({e}); ignoring seeds")
    niches, names = [], {}
    for n in cfg["niches"] + [dict(s, group="My seed keywords", seed=True) for s in seeds]:
        if not n.get("id") or not n.get("keywords") or n["id"] in names:
            continue
        niches.append({"id": n["id"], "keywords": norm(n.get("keywords")), "exclude": norm(n.get("exclude")),
                       "fallback": bool(n.get("only_if_no_other")), "seed": bool(n.get("seed"))})
        names[n["id"]] = n.get("name", n["id"])
    # fallback ("other") niches are checked last
    niches.sort(key=lambda n: n["fallback"])
    locations = sorted(((k.lower(), v) for k, v in cfg.get("locations", [])), key=lambda kv: -len(kv[0]))
    cfg_hash = hashlib.sha1(raw + b"\0" + seeds_raw).hexdigest()[:12]
    return niches, locations, cfg_hash, names


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
    niches, locations, cfg_hash, _names = load_config(CONFIG, SEEDS)
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
           "niche_config": cfg_hash,
           "niche_ids": [n["id"] for n in niches],
           "seed_sigs": {n["id"]: signature(n) for n in niches if n["seed"]},
           "days": days}
    with open(INDEX, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    total = sum(d["domains"] for d in days)
    matched = sum(d["matched"] for d in days)
    print(f"index.json: {len(days)} days ({redone} processed), {total:,} domains, {matched:,} in niches")


def export_csv(date, out_path):
    _n, _l, _h, names = load_config(CONFIG, SEEDS)
    with open(os.path.join(NICHE_DIR, date + ".json"), encoding="utf-8") as f:
        rows = json.load(f)["rows"]
    with open(out_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["date", "domain", "extension", "niches", "matched_keywords", "location"])
        for d, ids, kws, loc in sorted(rows, key=lambda r: (names.get(r[1][0], r[1][0]), r[0])):
            w.writerow([date, d, d.rsplit(".", 1)[-1], "; ".join(names.get(i, i) for i in ids), "; ".join(kws), loc])
    print(f"{out_path}: {len(rows)} rows")


if __name__ == "__main__":
    if "--csv" in sys.argv:
        export_csv(ARGS[0], ARGS[1])
    else:
        main()
