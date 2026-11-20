"""Gap Finder: exact-match .com names that are still free in busy niche + city markets.

Demand = how many new domains were registered in a niche + city over the last 30 days.
For the busiest pairs it builds simple name ideas and checks if the .com is still unregistered:
    {city}{term}.com   {term}{city}.com   {city}{term}pros.com   {city}{term}co.com
e.g. roofing + Dallas -> dallasroofing.com, roofingdallas.com, dallasroofingpros.com, dallasroofingco.com
"""
from collections import Counter

from classify import us_state_of

PATTERNS = [("{c}{t}", "city + term"), ("{t}{c}", "term + city"), ("{c}{t}pros", "city + term + pros"), ("{c}{t}co", "city + term + co")]


def demand_pairs(rows, cfg, min_demand=3):
    """rows: niche rows [domain, ids, kws, loc] for the last 30 days -> Counter{(niche_id, loc): n} (cities only)"""
    c = Counter()
    for _d, ids, _k, loc in rows:
        if not loc or "," not in loc:
            continue          # only cities (states are too broad for exact-match names)
        for nid in ids:
            if nid in cfg.gap_terms:
                c[(nid, loc)] += 1
    return Counter({k: v for k, v in c.items() if v >= min_demand})


def candidates(pairs, cfg, registered, top=120):
    """-> list of gap rows (status unknown) for the top demand pairs, skipping names already seen registered"""
    out, seen = [], set()
    for (nid, loc), n in pairs.most_common(top):
        city = cfg.loc_key.get(loc)
        if not city:
            continue
        for term in cfg.gap_terms[nid][:2]:
            for pat, label in PATTERNS:
                dom = pat.format(c=city, t=term) + ".com"
                if dom in seen or len(dom) > 40:
                    continue
                seen.add(dom)
                row = {"domain": dom, "niche_id": nid, "location": loc, "us_state": us_state_of(loc), "term": term,
                       "pattern": label, "demand": n}
                row["status"] = "taken" if dom in registered else "unknown"
                out.append(row)
    return out
