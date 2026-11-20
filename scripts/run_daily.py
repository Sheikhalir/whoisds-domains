#!/usr/bin/env python3
"""
DAILY JOB - run by GitHub Actions every few hours (see .github/workflows/daily.yml).

Steps (each is safe to re-run; work already done is skipped):
  1. sync      make sure every day's zip is in Supabase Storage (also migrates old repo data/)
  2. download  fetch new days from whoisds.com (free tier keeps 4 days)
  3. index     sort domains into niches -> Storage niches/DATE.json + index.json, and geo_daily stats
  4. seeds     search every user's seed keywords -> seed_hits (new seeds: all stored days)
  5. leads     queue niche/seed/favorite domains as leads, run due "did they launch?" checks, score, RDAP
  6. gaps      Gap Finder: check exact-match .com ideas for busy niche + city markets
  7. prune     remove old leads / stats / logs

Environment: SUPABASE_URL, SUPABASE_SERVICE_KEY (service role / secret key).
Local cache folder (--data) keeps downloaded zips between runs (GitHub Actions cache).

Examples:
  python scripts/run_daily.py --data .cache
  python scripts/run_daily.py --data /tmp/c --skip-download --fake-network     # offline test (dev/fake_network.py)
"""
import argparse
import asyncio
import json
import logging
import os
import sys
import time
import traceback
from collections import Counter, OrderedDict
from datetime import date, datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import gaps as G  # noqa: E402
import leads as L  # noqa: E402
import rdap as R  # noqa: E402
from classify import Config, classify, label_of, locate, match, read_zip_domains, us_state_of  # noqa: E402
from supa import Supa  # noqa: E402

BUCKET = "daily"
LEAD_COLUMNS = ["domain", "found_date", "tld", "niche_ids", "kws", "loc", "us_state", "source", "has_a", "has_mx", "mx_provider",
                "site_state", "http_status", "final_url", "title", "builder", "phones", "emails", "socials", "registrar",
                "registrant_org", "registrant_state", "registrant_country", "rdap_checked_at", "score", "score_reasons",
                "checks", "stage", "last_checked_at", "next_check_at", "history", "updated_at"]
SEED_MAX_HITS_PER_DAY = 3000


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def now_utc():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.isoformat() if dt else None


class Job:
    def __init__(self, args):
        self.args = args
        self.sb = Supa(os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY"))
        self.cfg = Config(args.config)
        self.data = args.data
        self.zip_dir = os.path.join(self.data, "zip")
        self.niche_dir = os.path.join(self.data, "niches")
        os.makedirs(self.zip_dir, exist_ok=True)
        os.makedirs(self.niche_dir, exist_ok=True)
        self.summary = {}
        self._domains = OrderedDict()     # small LRU: date -> list of domains
        self.niche_rows = {}              # date -> niche rows (only days loaded this run)
        self.remote_sizes = {}            # date -> bytes in storage
        self.new_days = []

    # ---------- helpers ----------
    def zip_path(self, d):
        return os.path.join(self.zip_dir, d + ".zip")

    def ensure_zip(self, d):
        p = self.zip_path(d)
        if not os.path.exists(p):
            data = self.sb.download(BUCKET, f"zip/{d}.zip")
            if not data:
                return None
            with open(p, "wb") as f:
                f.write(data)
        return p

    def domains(self, d):
        if d in self._domains:
            self._domains.move_to_end(d)
            return self._domains[d]
        p = self.ensure_zip(d)
        lst = read_zip_domains(p) if p else []
        self._domains[d] = lst
        while len(self._domains) > 12:
            self._domains.popitem(last=False)
        return lst

    def load_niche_rows(self, d):
        if d in self.niche_rows:
            return self.niche_rows[d]
        p = os.path.join(self.niche_dir, d + ".json")
        rows = None
        if os.path.exists(p):
            try:
                obj = json.load(open(p))
                if obj.get("config") == self.cfg.hash:
                    rows = obj["rows"]
            except Exception:
                rows = None
        if rows is None:
            raw = self.sb.download(BUCKET, f"niches/{d}.json")
            if raw:
                obj = json.loads(raw)
                rows = obj.get("rows", [])
                json.dump(obj, open(p, "w"), separators=(",", ":"))
        self.niche_rows[d] = rows or []
        return self.niche_rows[d]

    # ---------- 1. sync ----------
    def step_sync(self):
        remote = {}
        for o in self.sb.list(BUCKET, "zip"):
            if o["name"].endswith(".zip"):
                remote[o["name"][:-4]] = int((o.get("metadata") or {}).get("size") or 0)
        local = {f[:-4] for f in os.listdir(self.zip_dir) if f.endswith(".zip")}
        up = 0
        for d in sorted(local - set(remote)):
            data = open(self.zip_path(d), "rb").read()
            self.sb.upload(BUCKET, f"zip/{d}.zip", data, "application/zip")
            remote[d] = len(data)
            up += 1
        self.remote_sizes = remote
        self.summary["days_stored"] = len(remote)
        self.summary["uploaded_from_cache"] = up
        log(f"sync: {len(remote)} days in storage ({up} uploaded from local cache)")

    # ---------- 2. download ----------
    def step_download(self):
        if self.args.skip_download:
            log("download: skipped")
            return
        import whoisds_downloader as W
        got = []
        for d in W.available_dates():
            ds = d.isoformat()
            if ds in self.remote_sizes:
                continue
            status = W.download_day(d, self.zip_dir, os.path.join(self.data, "txt"), False)
            if status == "downloaded" and os.path.exists(self.zip_path(ds)):
                data = open(self.zip_path(ds), "rb").read()
                self.sb.upload(BUCKET, f"zip/{ds}.zip", data, "application/zip")
                self.remote_sizes[ds] = len(data)
                got.append(ds)
        self.summary["downloaded"] = got
        log(f"download: {len(got)} new day(s) {got}")

    # ---------- 3. index ----------
    def step_index(self):
        raw = self.sb.download(BUCKET, "index.json")
        old = json.loads(raw) if raw else {}
        cached = {d["date"]: d for d in old.get("days", [])}
        same_cfg = old.get("niche_config") == self.cfg.hash
        days, redo = [], []
        for d in sorted(self.remote_sizes):
            prev = cached.get(d)
            if prev and same_cfg and prev.get("bytes") == self.remote_sizes[d] and "niches" in prev:
                days.append(prev)
            else:
                redo.append(d)
        prev_flags = {d: {"seeds": cached[d].get("seeds")} for d in redo if d in cached}
        self.new_days = [d for d in redo if d not in cached]
        for d in redo:
            doms = self.domains(d)
            rows = [r for r in (classify(x, self.cfg) for x in doms) if r]
            counts, geo = Counter(), Counter()
            for _dom, ids, _kws, loc in rows:
                for i in ids:
                    counts[i] += 1
                    if loc:
                        geo[(i, loc)] += 1
            obj = {"date": d, "config": self.cfg.hash, "rows": rows}
            body = json.dumps(obj, separators=(",", ":"))
            open(os.path.join(self.niche_dir, d + ".json"), "w").write(body)
            self.sb.upload(BUCKET, f"niches/{d}.json", body.encode(), "application/json")
            self.niche_rows[d] = rows
            self.sb.delete("geo_daily", {"date": f"eq.{d}"})
            self.sb.upsert("geo_daily", [{"date": d, "niche_id": i, "loc": loc, "us_state": us_state_of(loc), "n": n}
                                         for (i, loc), n in geo.items()])
            entry = {"date": d, "domains": len(doms), "bytes": self.remote_sizes[d], "matched": len(rows), "niches": dict(counts)}
            entry.update({k: v for k, v in prev_flags.get(d, {}).items() if v})   # seeds stay done; leads re-queue after re-sorting
            days.append(entry)
            log(f"index: {d} -> {len(doms):,} domains, {len(rows):,} in niches")
        days.sort(key=lambda x: x["date"])
        self.index = {"updated": now_utc().strftime("%Y-%m-%dT%H:%M:%SZ"), "niche_config": self.cfg.hash, "days": days}
        self.day = {x["date"]: x for x in days}
        self.save_index()
        self.summary["days_processed"] = len(redo)
        self.summary["new_days"] = self.new_days
        log(f"index: {len(days)} days, {len(redo)} processed, new: {self.new_days}")

    def save_index(self):
        self.sb.upload(BUCKET, "index.json", json.dumps(self.index).encode(), "application/json")

    # ---------- 4. seeds ----------
    def step_seeds(self):
        seeds = self.sb.rpc("job_active_seeds") or []
        full = [s for s in seeds if s.get("processed_sig") != s.get("sig")]
        inc = [s for s in seeds if s.get("processed_sig") == s.get("sig")]
        all_days = sorted(self.remote_sizes)
        pending = {d for d in all_days if not self.day.get(d, {}).get("seeds")}   # days not yet searched for existing seeds
        plan = {}
        for d in all_days:
            todo = list(full) + (inc if d in pending else [])
            if todo:
                plan[d] = todo
        for s in full:
            self.sb.delete("seed_hits", {"seed_id": f"eq.{s['id']}"})
        self.seed_new_hits = []
        total = 0
        for d, todo in plan.items():
            doms = self.domains(d)
            batch = []
            for s in todo:
                kws, ex, n = s["keywords"], s.get("exclude") or [], 0
                for dom in doms:
                    lab = label_of(dom)
                    kw = match(kws, ex, lab)
                    if kw:
                        batch.append({"seed_id": s["id"], "date": d, "domain": dom, "kw": kw, "loc": locate(lab, self.cfg) or None})
                        n += 1
                        if n >= SEED_MAX_HITS_PER_DAY:
                            break
            self.sb.upsert("seed_hits", batch, on_conflict="seed_id,date,domain")
            total += len(batch)
            if d in pending:
                self.seed_new_hits += batch
        for s in full:
            self.sb.update("seeds", {"id": f"eq.{s['id']}"}, {"processed_sig": s["sig"], "processed_at": iso(now_utc())})
        for d in all_days:
            if d in self.day:
                self.day[d]["seeds"] = True
        self.save_index()
        self.summary["seeds"] = {"active": len(seeds), "reprocessed": len(full), "hits_written": total}
        log(f"seeds: {len(seeds)} active, {len(full)} (re)processed over all days, {total:,} hits written")

    # ---------- 5. leads ----------
    def base_lead(self, domain, found, ids, kws, loc, source):
        tld = domain.rsplit(".", 1)[-1]
        return {"domain": domain, "found_date": found, "tld": tld, "niche_ids": ids, "kws": kws, "loc": loc or None,
                "us_state": us_state_of(loc), "source": source, "next_check_at": iso(now_utc())}

    def step_leads(self):
        lc = self.cfg.leads
        tlds = set(lc["tlds"])
        horizon = (date.today() - timedelta(days=30)).isoformat()
        cand = {}
        lead_days = [d for d in sorted(self.day) if not self.day[d].get("leads") and d >= horizon]
        for d in lead_days:
            for dom, ids, kws, loc in self.load_niche_rows(d):
                if dom.rsplit(".", 1)[-1] in tlds and [i for i in ids if i != "generic"]:
                    cand[dom] = self.base_lead(dom, d, ids, kws, loc, "niche")
        for h in getattr(self, "seed_new_hits", []):
            dom = h["domain"]
            if dom not in cand and dom.rsplit(".", 1)[-1] in tlds and h["date"] >= horizon:
                cand[dom] = self.base_lead(dom, h["date"], ["seed"], [h["kw"]], h["loc"], "seed")
        tracked = self.sb.rpc("job_tracked_domains") or []
        tracked_set = {t["domain"] for t in tracked}
        for t in tracked:
            if t["domain"] not in cand:
                cand[t["domain"]] = self.base_lead(t["domain"], t.get("found_date") or date.today().isoformat(),
                                                   t.get("niche_ids") or [], t.get("kws") or [], t.get("loc"), "favorite")
        added = self.sb.upsert("leads", list(cand.values()), ignore_duplicates=True)
        for d in self.day:
            self.day[d]["leads"] = True
        self.save_index()
        # tracked leads whose regular checks had finished get checked again
        tl = sorted(tracked_set)
        for i in range(0, len(tl), 80):
            chunk = ",".join(f'"{x}"' for x in tl[i:i + 80])
            self.sb.update("leads", {"domain": f"in.({chunk})", "next_check_at": "is.null"}, {"next_check_at": iso(now_utc())})
        log(f"leads: queued {added:,} candidates from {len(lead_days)} day(s) ({len(tracked_set)} tracked by users)")

        due = self.sb.select("leads", {"select": "*", "next_check_at": "lte." + iso(now_utc()), "order": "next_check_at.asc",
                                       "limit": self.args.max_checks or lc["max_checks_per_run"]})
        log(f"leads: {len(due):,} checks due")
        checked = asyncio.run(self._check_all(due, tracked_set)) if due else []
        self.sb.upsert("leads", [{k: r.get(k) for k in LEAD_COLUMNS} for r in checked])
        states = Counter(r["site_state"] for r in checked)
        rd = asyncio.run(self._rdap(tracked_set))
        self.summary["leads"] = {"queued": added, "checked": len(checked), "states": dict(states), "rdap": rd,
                                 "hot": sum(1 for r in checked if r["score"] >= 70)}
        log(f"leads: checked {len(checked):,} {dict(states)}; rdap {rd}")

    async def _check_all(self, due, tracked_set):
        resolve, fetch, client = self.network()
        chk = L.Checker(resolve, fetch, concurrency=self.args.concurrency)
        now = now_utc()
        lc = self.cfg.leads

        async def one(lead):
            try:
                res = await asyncio.wait_for(chk.check(lead["domain"]), timeout=60)
            except Exception as e:
                res = {"site_state": "error", "has_a": None, "has_mx": None}
                log(f"  check failed {lead['domain']}: {e}")
            prev_state, prev_mx = lead.get("site_state"), lead.get("has_mx")
            lead.update(res)
            lead["checks"] = (lead.get("checks") or 0) + 1
            lead["stage"] = lead["checks"]
            lead["last_checked_at"] = iso(now)
            hist = lead.get("history") or []
            if prev_state != lead["site_state"] or prev_mx != lead.get("has_mx") or not hist:
                hist = (hist + [{"at": now.date().isoformat(), "state": lead["site_state"], "mx": bool(lead.get("has_mx"))}])[-8:]
            lead["history"] = hist
            nxt = L.schedule_next(lead, lc["check_days"], lc["tracked_recheck_days"], lead["domain"] in tracked_set, now)
            lead["next_check_at"] = iso(nxt)
            lead["score"], lead["score_reasons"] = L.score(lead, self.cfg.value)
            lead["updated_at"] = iso(now)
            for k in ("phones", "emails", "socials", "niche_ids", "kws", "score_reasons"):
                lead[k] = lead.get(k) or []
            return lead

        try:
            return await asyncio.gather(*(one(dict(x)) for x in due))
        finally:
            if client is not None:
                await client.aclose()

    async def _rdap(self, tracked_set):
        n = self.cfg.leads["rdap_per_run"]
        if not n:
            return 0
        rows = self.sb.select("leads", {"select": "*", "rdap_checked_at": "is.null", "checks": "gt.0", "score": "gte.50",
                                        "order": "score.desc", "limit": n})
        if not rows:
            return 0
        get, client = self.rdap_get()
        rd = R.Rdap(get, cache_dir=self.data)
        now = iso(now_utc())

        async def one(lead):
            info = await rd.lookup(lead["domain"])
            lead["rdap_checked_at"] = now
            if info:
                for k in ("registrar", "registrant_org", "registrant_state", "registrant_country"):
                    lead[k] = info.get(k)
            lead["score"], lead["score_reasons"] = L.score(lead, self.cfg.value)
            return lead
        try:
            out = await asyncio.gather(*(one(dict(r)) for r in rows))
        finally:
            if client is not None:
                await client.aclose()
        self.sb.upsert("leads", [{k: r.get(k) for k in LEAD_COLUMNS} for r in out])
        return len(out)

    # ---------- 6. gaps ----------
    def step_gaps(self):
        days = sorted(self.remote_sizes)[-30:]
        rows = []
        for d in days:
            rows += self.load_niche_rows(d)
        registered = {r[0] for r in rows}
        pairs = G.demand_pairs(rows, self.cfg)
        cands = G.candidates(pairs, self.cfg, registered)
        existing = {g["domain"]: g for g in self.sb.select("gaps", {"select": "domain,status,checked_at"})}
        week_ago = (now_utc() - timedelta(days=7)).isoformat()
        to_check = [c for c in cands if c["status"] == "unknown" and
                    (c["domain"] not in existing or existing[c["domain"]]["status"] == "unknown" or existing[c["domain"]]["checked_at"] < week_ago)]
        to_check = to_check[: self.cfg.leads["gap_checks_per_run"]]
        checked = asyncio.run(self._gap_check([c["domain"] for c in to_check])) if to_check else {}
        now = iso(now_utc())
        out = []
        for c in cands:
            if c["domain"] in checked:
                c["status"], c["checked_at"] = checked[c["domain"]], now
            elif c["status"] == "taken":
                c["checked_at"] = now
            elif c["domain"] in existing:
                c["status"], c["checked_at"] = existing[c["domain"]]["status"], existing[c["domain"]]["checked_at"]
            else:
                c["checked_at"] = now
            out.append(c)
        self.sb.upsert("gaps", out)
        st = Counter(c["status"] for c in out)
        self.summary["gaps"] = {"pairs": len(pairs), "ideas": len(out), "checked": len(checked), "status": dict(st)}
        log(f"gaps: {len(pairs)} busy niche+city pairs, {len(out)} ideas, checked {len(checked)} -> {dict(st)}")

    async def _gap_check(self, domains):
        resolve, _fetch, client = self.network()
        get, rclient = self.rdap_get()
        rd = R.Rdap(get, cache_dir=self.data)
        sem = asyncio.Semaphore(8)

        async def one(d):
            async with sem:
                if await resolve(d, "NS"):
                    return d, "taken"
                return d, await rd.availability(d)
        try:
            return dict(await asyncio.gather(*(one(d) for d in domains)))
        finally:
            for c in (client, rclient):
                if c is not None:
                    await c.aclose()

    # ---------- 7. prune ----------
    def step_prune(self):
        res = self.sb.rpc("job_prune", p_lead_days=int(self.cfg.leads.get("keep_days", 120)))
        self.summary["pruned"] = res
        log(f"prune: {res}")

    # ---------- network (real or fake) ----------
    def network(self):
        if self.args.fake_network:
            import fake_network
            return fake_network.resolve, fake_network.fetch, None
        return L.real_network()

    def rdap_get(self):
        if self.args.fake_network:
            import fake_network
            return fake_network.rdap_get, None
        return R.real_get()

    def run(self):
        run = self.sb.insert("job_runs", {"status": "running"})
        run_id = run["id"] if run else None
        t0 = time.time()
        steps = [("sync", self.step_sync), ("download", self.step_download), ("index", self.step_index), ("seeds", self.step_seeds),
                 ("leads", self.step_leads), ("gaps", self.step_gaps), ("prune", self.step_prune)]
        only = set(self.args.only.split(",")) if self.args.only else None
        try:
            for name, fn in steps:
                if only and name not in only and name not in ("sync", "index"):
                    continue
                fn()
            self.summary["seconds"] = round(time.time() - t0)
            if run_id:
                self.sb.update("job_runs", {"id": f"eq.{run_id}"}, {"status": "ok", "finished_at": iso(now_utc()), "summary": self.summary})
            log("done", json.dumps(self.summary)[:2000])
            return 0
        except Exception as e:
            traceback.print_exc()
            self.summary["seconds"] = round(time.time() - t0)
            if run_id:
                try:
                    self.sb.update("job_runs", {"id": f"eq.{run_id}"}, {"status": "error", "finished_at": iso(now_utc()),
                                                                       "summary": self.summary, "error": f"{type(e).__name__}: {e}"[:2000]})
                except Exception:
                    pass
            return 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=".cache", help="local cache folder")
    ap.add_argument("--config", default=os.path.join(HERE, "..", "niches.json"))
    ap.add_argument("--skip-download", action="store_true")
    ap.add_argument("--fake-network", action="store_true", help="offline test: use dev/fake_network.py for DNS/HTTP/RDAP")
    ap.add_argument("--max-checks", type=int, default=0)
    ap.add_argument("--concurrency", type=int, default=40)
    ap.add_argument("--only", default="", help="comma list of steps (sync and index always run)")
    args = ap.parse_args()
    if args.fake_network:
        sys.path.insert(0, os.path.join(HERE, "..", "dev"))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    sys.exit(Job(args).run())


if __name__ == "__main__":
    main()
