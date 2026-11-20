"""Niche + location matching for domain names. Shared by the daily job.

The dashboard has a JavaScript copy of the same rules (assets/js/core.js:
labelOf / matchSeed / seedSig / locate). If you change matching here, change it there too.
"""
import hashlib
import json
import re
import zipfile

US_STATES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO", "connecticut": "CT",
    "delaware": "DE", "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
    "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI",
    "minnesota": "MN", "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH",
    "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", "tennessee": "TN",
    "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV", "wisconsin": "WI",
    "wyoming": "WY", "southern california": "CA", "northern california": "CA",
}
US_CODES = set(US_STATES.values()) | {"DC"}


def norm(words):
    out = [re.sub(r"[^a-z0-9]", "", str(w).lower()) for w in words or []]
    return [w for w in out if w]


def signature(keywords, exclude):
    """Same as seed_sig() in schema.sql and seedSig() in the dashboard."""
    return ",".join(sorted(keywords)) + "|" + ",".join(sorted(exclude or []))


def us_state_of(loc):
    """'Dallas, TX' -> 'TX', 'Texas' -> 'TX', 'London, UK' -> None"""
    if not loc:
        return None
    if "," in loc:
        code = loc.rsplit(",", 1)[1].strip().split("/")[0].strip()
        return code if code in US_CODES else None
    return US_STATES.get(loc.strip().lower())


class Config:
    def __init__(self, path="niches.json"):
        raw = open(path, "rb").read()
        self.raw = json.loads(raw)
        self.hash = hashlib.sha1(raw).hexdigest()[:12]
        self.niches = []
        self.names = {}
        self.value = {}
        self.gap_terms = {}
        for n in self.raw["niches"]:
            if not n.get("id") or not n.get("keywords"):
                continue
            self.niches.append({"id": n["id"], "keywords": norm(n["keywords"]), "exclude": norm(n.get("exclude")),
                                "fallback": bool(n.get("only_if_no_other"))})
            self.names[n["id"]] = n.get("name", n["id"])
            self.value[n["id"]] = n.get("value", "medium")
            if n.get("gap_terms"):
                self.gap_terms[n["id"]] = norm(n["gap_terms"])
        self.niches.sort(key=lambda n: n["fallback"])  # fallback ("other") niches last
        self.locations = sorted(((k.lower(), v) for k, v in self.raw.get("locations", [])), key=lambda kv: -len(kv[0]))
        # canonical key per display name (first listed), used for gap-finder name ideas
        self.loc_key = {}
        for k, v in self.raw.get("locations", []):
            self.loc_key.setdefault(v, k.lower())
        self.leads = {"tlds": ["com", "net", "org", "co", "us"], "check_days": [0, 7, 14, 30], "tracked_recheck_days": 14,
                      "max_checks_per_run": 4000, "rdap_per_run": 300, "gap_checks_per_run": 150, "keep_days": 120}
        self.leads.update(self.raw.get("leads") or {})
        allkw = sorted({re.escape(k) for n in self.niches for k in n["keywords"]}, key=len, reverse=True)
        self._any = re.compile("|".join(allkw)) if allkw else None


def label_of(domain):
    """'Dallas-Roofing-Pros.com' -> 'dallasroofingpros'"""
    return domain.lower().split(".")[0].replace("-", "")


def match(keywords, exclude, label):
    text = label
    for ex in exclude:
        text = text.replace(ex, "|")
    for kw in keywords:
        if kw in text:
            return kw
    return None


def locate(label, cfg):
    return next((name for key, name in cfg.locations if key in label), "")


def classify(domain, cfg):
    """-> [domain, [niche ids], [matched keywords], location] or None"""
    label = label_of(domain)
    if cfg._any is None or not cfg._any.search(label):
        return None
    ids, kws = [], []
    for n in cfg.niches:
        if n["fallback"] and ids:
            break
        kw = match(n["keywords"], n["exclude"], label)
        if kw:
            ids.append(n["id"]); kws.append(kw)
    if not ids:
        return None
    return [domain, ids, kws, locate(label, cfg)]


def read_zip_domains(path_or_bytes):
    import io
    src = io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, (bytes, bytearray)) else path_or_bytes
    out = []
    with zipfile.ZipFile(src) as zf:
        for name in zf.namelist():
            if name.endswith("/"):
                continue
            for line in zf.read(name).decode("utf-8", "replace").splitlines():
                line = line.strip().lower()
                if line:
                    out.append(line)
    return list(dict.fromkeys(out))   # same domain listed twice -> once
