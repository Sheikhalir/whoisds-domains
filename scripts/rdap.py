"""RDAP: the modern, free, JSON replacement for WHOIS.

lookup(domain)       -> registrar, registration date, registrant org/state/country (when not privacy-redacted)
availability(domain) -> 'available' (registry says not found) | 'taken' | 'unknown'

The registry server for each TLD comes from IANA's bootstrap file (data.iana.org/rdap/dns.json).
"""
import asyncio
import json
import os
import time

BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json"
REDACTED = ("redacted", "privacy", "withheld", "not disclosed", "data protected", "contact privacy", "domains by proxy",
            "whoisguard", "perfect privacy", "proxy", "gdpr")


def _vcard(entity):
    out = {}
    for item in (entity.get("vcardArray") or [None, []])[1]:
        if len(item) < 4:
            continue
        key, val = item[0], item[3]
        if key in ("fn", "org") and isinstance(val, str):
            out[key] = val.strip()
        if key == "adr":
            label = (item[1] or {}).get("label") if isinstance(item[1], dict) else None
            if isinstance(val, list) and len(val) >= 7:
                out["region"] = (val[4] or "").strip() if isinstance(val[4], str) else ""
                out["country"] = (val[6] or "").strip() if isinstance(val[6], str) else ""
            elif label:
                out["label"] = label
    return out


def _clean(v):
    if not v:
        return None
    return None if any(r in v.lower() for r in REDACTED) else v[:120]


def parse(data):
    out = {"registrar": None, "registered": None, "registrant_org": None, "registrant_state": None, "registrant_country": None}
    for ev in data.get("events") or []:
        if ev.get("eventAction") == "registration":
            out["registered"] = (ev.get("eventDate") or "")[:10] or None
    stack = list(data.get("entities") or [])
    while stack:
        e = stack.pop()
        stack += e.get("entities") or []
        roles = e.get("roles") or []
        vc = _vcard(e)
        if "registrar" in roles and not out["registrar"]:
            out["registrar"] = _clean(vc.get("fn") or vc.get("org"))
        if "registrant" in roles:
            out["registrant_org"] = _clean(vc.get("org") or vc.get("fn"))
            out["registrant_state"] = _clean(vc.get("region"))
            out["registrant_country"] = _clean(vc.get("country"))
    return out


class Rdap:
    """get(url) -> (status, json_or_None) (async). Injected so tests run offline."""

    def __init__(self, get, cache_dir=".", per_host_delay=0.25, concurrency=4):
        self.get, self.cache_dir, self.delay = get, cache_dir, per_host_delay
        self.sem = asyncio.Semaphore(concurrency)
        self.bases = None
        self._last = {}

    async def _bootstrap(self):
        if self.bases is not None:
            return
        path = os.path.join(self.cache_dir, "rdap_bootstrap.json")
        data = None
        if os.path.exists(path) and time.time() - os.path.getmtime(path) < 7 * 86400:
            data = json.load(open(path))
        else:
            try:
                st, data = await self.get(BOOTSTRAP_URL)
                if st == 200 and data:
                    os.makedirs(self.cache_dir, exist_ok=True)
                    json.dump(data, open(path, "w"))
            except Exception:
                data = None
        self.bases = {}
        for tlds, urls in (data or {}).get("services", []):
            url = next((u for u in urls if u.startswith("https")), urls[0] if urls else None)
            for t in tlds:
                self.bases[t.lower()] = url if url.endswith("/") else url + "/"
        self.bases.setdefault("com", "https://rdap.verisign.com/com/v1/")
        self.bases.setdefault("net", "https://rdap.verisign.com/net/v1/")

    async def _query(self, domain):
        await self._bootstrap()
        base = self.bases.get(domain.rsplit(".", 1)[-1].lower())
        if not base:
            return None, None
        async with self.sem:
            wait = self.delay - (time.time() - self._last.get(base, 0))
            if wait > 0:
                await asyncio.sleep(wait)
            self._last[base] = time.time()
            try:
                return await self.get(base + "domain/" + domain)
            except Exception:
                return None, None

    async def lookup(self, domain):
        st, data = await self._query(domain)
        return parse(data) if st == 200 and data else None

    async def availability(self, domain):
        st, _ = await self._query(domain)
        return "available" if st == 404 else "taken" if st == 200 else "unknown"


def real_get():
    import httpx
    client = httpx.AsyncClient(timeout=15, follow_redirects=True, headers={"Accept": "application/rdap+json, application/json"})

    async def get(url):
        r = await client.get(url)
        try:
            return r.status_code, r.json()
        except ValueError:
            return r.status_code, None
    return get, client
