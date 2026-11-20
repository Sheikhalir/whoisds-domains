"""Lead checks: "did they launch?" + contact discovery + lead score.

For each domain:
  1. DNS:  A/AAAA (web server?), MX (email set up = strong sign of a real business), NS (parking providers)
  2. HTTP: fetch the homepage (https, then http), follow redirects, read at most 400 KB
  3. Classify the site: no_site | error | parked | coming_soon | placeholder | redirect | live
     and detect the site builder (Wix, Squarespace, GoDaddy, WordPress, GoHighLevel, ...)
  4. Contacts: phone numbers, emails, social links (homepage, then /contact if nothing found)
  5. Score 0-100 with human-readable reasons (see score())

Network access is injected (resolver + fetcher) so tests can run offline: see dev/fake_network.py.
"""
import asyncio
import html as htmllib
import re
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urljoin, urlsplit

PARKING_NS = ("parkingcrew", "sedoparking", "bodis", "above.com", "dan.com", "afternic", "parklogic", "ztomy", "namebrightdns",
              "hugedomains", "undeveloped", "domainparking", "cashparking", "parked")
PARKED_PATTERNS = [
    r"this domain (?:name )?(?:is|may be) (?:for sale|parked|available)", r"buy this domain", r"domain (?:is )?for sale",
    r"parkingcrew", r"sedo\.com", r"sedoparking", r"bodis\.com", r"afternic", r"hugedomains", r"dan\.com", r"undeveloped\.com",
    r"godaddy\.com/domainsearch", r"this domain has been registered", r"future home of something quite cool",
    r"domain parking", r"parked free", r"is parked free", r"related searches", r"this web page is parked",
    r"the domain .{0,40} is registered", r"renew this domain", r"domain has expired",
]
COMING_PATTERNS = [r"coming soon", r"under construction", r"launching soon", r"site is being built", r"stay tuned",
                   r"we'?re building", r"opening soon", r"website is under maintenance", r"check back soon"]
PLACEHOLDER_PATTERNS = [r"welcome to nginx", r"apache2? (?:ubuntu|debian)? ?default page", r"it works!", r"index of /",
                        r"cpanel", r"default web site page", r"hostinger", r"plesk", r"web server's default page",
                        r"this site can.t be reached", r"account suspended", r"site not found", r"no website configured"]
BUILDERS = [
    ("Wix", [r"wix\.com", r"_wixcssimports", r"x-wix-", r"wixstatic"]),
    ("Squarespace", [r"squarespace", r"static1\.squarespace"]),
    ("GoDaddy Builder", [r"img1\.wsimg\.com", r"godaddy website builder", r"websitebuilder\.godaddy"]),
    ("GoHighLevel", [r"leadconnectorhq", r"msgsndr\.com", r"highlevel"]),
    ("Shopify", [r"cdn\.shopify\.com", r"shopify"]),
    ("Webflow", [r"webflow"]),
    ("Weebly", [r"weebly"]),
    ("Duda", [r"dudaone", r"multiscreensite", r"duda\.co"]),
    ("Hostinger Builder", [r"zyrosite", r"hostinger builder", r"userapp\.zyrosite"]),
    ("Framer", [r"framerusercontent", r"framer\.com"]),
    ("Carrd", [r"carrd\.co"]),
    ("Google Sites", [r"sites\.google\.com"]),
    ("WordPress", [r"wp-content", r"wp-includes", r"wordpress"]),
]
CHEAP_BUILDERS = {"Wix", "GoDaddy Builder", "Weebly", "Google Sites", "Carrd", "Hostinger Builder", "Duda"}
MX_PROVIDERS = [("Google", ["google.com", "googlemail.com"]), ("Microsoft 365", ["outlook.com", "protection.outlook"]),
                ("Zoho", ["zoho"]), ("GoDaddy", ["secureserver.net"]), ("Namecheap", ["privateemail.com", "registrar-servers.com", "jellyfish"]),
                ("Titan", ["titan.email"]), ("Proton", ["protonmail"]), ("Yahoo", ["yahoodns"]), ("iCloud", ["icloud.com"]),
                ("ImprovMX", ["improvmx"]), ("Forward Email", ["forwardemail"]), ("Hostinger", ["hostinger"]), ("IONOS", ["ionos", "1and1"])]
SOCIAL = [("facebook", r"https?://(?:www\.|m\.)?facebook\.com/(?!sharer|share|plugins|dialog|tr\b)[A-Za-z0-9_.\-/]+"),
          ("instagram", r"https?://(?:www\.)?instagram\.com/[A-Za-z0-9_.]+"),
          ("linkedin", r"https?://(?:www\.)?linkedin\.com/(?:company|in)/[A-Za-z0-9_\-]+"),
          ("yelp", r"https?://(?:www\.)?yelp\.com/biz/[A-Za-z0-9_\-]+"),
          ("x", r"https?://(?:www\.)?(?:twitter|x)\.com/(?!share|intent)[A-Za-z0-9_]+"),
          ("youtube", r"https?://(?:www\.)?youtube\.com/(?:@|channel/|c/)[A-Za-z0-9_\-]+"),
          ("tiktok", r"https?://(?:www\.)?tiktok\.com/@[A-Za-z0-9_.]+"),
          ("google", r"https?://(?:g\.page|maps\.app\.goo\.gl|goo\.gl/maps)/[A-Za-z0-9_\-]+")]
PHONE_RE = re.compile(r"(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})\b")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
BAD_EMAIL = re.compile(r"\.(png|jpe?g|gif|svg|webp)$|example\.|wixpress|sentry|yourdomain|domain\.com$|email\.com$|@2x", re.I)
NEEDS_SITE = {"no_site", "error", "parked", "coming_soon", "placeholder"}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def _has(patterns, text):
    return any(re.search(p, text) for p in patterns)


def registrable(host):
    parts = (host or "").lower().split(":")[0].strip(".").split(".")
    if len(parts) >= 3 and parts[-2] in ("co", "com", "org", "net") and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def mx_provider(hosts):
    joined = " ".join(hosts).lower()
    for name, keys in MX_PROVIDERS:
        if any(k in joined for k in keys):
            return name
    return "Other" if hosts else None


def visible_text(html):
    t = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", html)
    t = re.sub(r"(?s)<[^>]+>", " ", t)
    return re.sub(r"\s+", " ", htmllib.unescape(t)).strip()


def extract_contacts(html):
    phones, emails, socials = [], [], []
    for m in re.finditer(r'href=["\']tel:([^"\']+)', html, re.I):
        digits = re.sub(r"\D", "", m.group(1))
        if 10 <= len(digits) <= 15:
            phones.append("+" + (digits if len(digits) > 10 else "1" + digits))
    text = visible_text(html)
    for m in PHONE_RE.finditer(text):
        phones.append("+1" + "".join(m.groups()))
    for m in re.finditer(r'href=["\']mailto:([^"\'?]+)', html, re.I):
        emails.append(m.group(1).strip().lower())
    for m in EMAIL_RE.finditer(text):
        emails.append(m.group(0).strip(".").lower())
    for name, pat in SOCIAL:
        m = re.search(pat, html, re.I)
        if m:
            socials.append(m.group(0).rstrip("/\"'"))
    uniq = lambda xs: list(dict.fromkeys(xs))
    phones = [p for p in uniq(phones) if not re.search(r"(\d)\1{6,}", p)][:3]
    emails = [e for e in uniq(emails) if not BAD_EMAIL.search(e)][:3]
    return phones, emails, uniq(socials)[:6]


def classify_page(domain, status, final_url, html, headers=None, ns=None):
    """-> (site_state, builder, title)"""
    low = (html or "").lower()
    hdr = " ".join(f"{k}:{v}" for k, v in (headers or {}).items()).lower()
    m = re.search(r"(?is)<title[^>]*>(.*?)</title>", html or "")
    title = re.sub(r"\s+", " ", htmllib.unescape(m.group(1))).strip()[:150] if m else ""
    builder = next((name for name, pats in BUILDERS if _has(pats, low) or _has(pats, hdr)), None)
    if any(p in " ".join(ns or []).lower() for p in PARKING_NS) or _has(PARKED_PATTERNS, low[:60000]):
        return "parked", builder, title
    if final_url and registrable(urlsplit(final_url).hostname) != registrable(domain):
        return "redirect", builder, title
    if status and status >= 400:
        return "error", builder, title
    text = visible_text(html or "")
    if _has(COMING_PATTERNS, (title + " " + text[:3000]).lower()):
        return "coming_soon", builder, title
    if _has(PLACEHOLDER_PATTERNS, (title + " " + text[:2000]).lower()) or len(text) < 200:
        return "placeholder", builder, title
    return "live", builder, title


def score(lead, value_of):
    """0-100 + reasons. value_of: niche id -> 'high'|'medium'|'low'."""
    pts, reasons = 0, []
    tiers = [value_of.get(n, "medium") for n in lead.get("niche_ids") or [] if n != "generic"]
    if lead.get("source") == "seed" and not tiers:
        tiers = ["medium"]
    tier = "high" if "high" in tiers else "medium" if "medium" in tiers else "low"
    v = {"high": 30, "medium": 20, "low": 10}[tier]
    pts += v; reasons.append(f"+{v} {tier}-value niche")
    if lead.get("tld") == "com":
        pts += 10; reasons.append("+10 .com")
    if lead.get("loc"):
        pts += 10; reasons.append("+10 city/state in name")
    state = lead.get("site_state") or "unchecked"
    if lead.get("has_mx"):
        pts += 20; reasons.append("+20 business email set up")
    if state in NEEDS_SITE:
        pts += 20; reasons.append("+20 no real website yet")
    elif state == "live" and lead.get("builder") in CHEAP_BUILDERS:
        pts += 10; reasons.append(f"+10 basic {lead['builder']} site")
    elif state == "redirect":
        pts -= 10; reasons.append("-10 redirects elsewhere")
    if lead.get("phones") or lead.get("emails"):
        pts += 10; reasons.append("+10 contact found")
    if lead.get("registrant_org"):
        pts += 5; reasons.append("+5 owner company visible")
    label = lead["domain"].split(".")[0]
    if len(label) > 25:
        pts -= 5; reasons.append("-5 very long name")
    if re.search(r"\d", label):
        pts -= 5; reasons.append("-5 digits in name")
    if label.count("-") >= 2:
        pts -= 5; reasons.append("-5 many hyphens")
    return max(0, min(100, pts)), reasons


class Checker:
    """resolve(name, rtype) -> list[str] (async); fetch(url) -> (status, final_url, headers, html) (async, may raise)."""

    def __init__(self, resolve, fetch, concurrency=40):
        self.resolve, self.fetch = resolve, fetch
        self.sem = asyncio.Semaphore(concurrency)

    async def check(self, domain):
        async with self.sem:
            out = {"has_a": False, "has_mx": False, "mx_provider": None, "site_state": "no_site", "http_status": None,
                   "final_url": None, "title": None, "builder": None, "phones": [], "emails": [], "socials": []}
            a, mx, ns = await asyncio.gather(self.resolve(domain, "A"), self.resolve(domain, "MX"), self.resolve(domain, "NS"))
            if not a:
                a = await self.resolve(domain, "AAAA")
            mx_hosts = [h for h in mx if h and h != "."]
            out["has_a"], out["has_mx"], out["mx_provider"] = bool(a), bool(mx_hosts), mx_provider(mx_hosts)
            if any(p in " ".join(ns).lower() for p in PARKING_NS):
                out["site_state"] = "parked"
                return out
            if not a:
                return out
            page = None
            for url in (f"https://{domain}/", f"http://{domain}/"):
                try:
                    page = await self.fetch(url)
                    if page:
                        break
                except Exception:
                    continue
            if not page:
                out["site_state"] = "error"
                return out
            status, final_url, headers, html = page
            out["http_status"], out["final_url"] = status, final_url
            out["site_state"], out["builder"], out["title"] = classify_page(domain, status, final_url, html, headers, ns)
            if out["site_state"] in ("live", "coming_soon", "placeholder"):
                out["phones"], out["emails"], out["socials"] = extract_contacts(html)
                if out["site_state"] == "live" and not (out["phones"] or out["emails"]):
                    for path in ("/contact", "/contact-us"):
                        try:
                            p2 = await self.fetch(urljoin(final_url or f"https://{domain}/", path))
                        except Exception:
                            p2 = None
                        if p2 and p2[0] and p2[0] < 400:
                            ph, em, so = extract_contacts(p2[3])
                            out["phones"], out["emails"] = ph, em
                            out["socials"] = list(dict.fromkeys(out["socials"] + so))[:6]
                            if ph or em:
                                break
            return out


def schedule_next(lead, check_days, tracked_days, tracked, now):
    """Checks happen check_days after the registration day (default 0, 7, 14, 30); tracked leads every tracked_days."""
    found = lead["found_date"] if isinstance(lead["found_date"], date) else date.fromisoformat(str(lead["found_date"])[:10])
    n = lead.get("checks") or 0
    if tracked:
        return now + timedelta(days=tracked_days)
    if n >= len(check_days):
        return None
    due = datetime(found.year, found.month, found.day, tzinfo=timezone.utc) + timedelta(days=check_days[n])
    return max(due, now + timedelta(hours=20))


# ---------------- real network (used in GitHub Actions) ----------------
def real_network(dns_timeout=4.0, http_timeout=9.0, max_bytes=400_000):
    import dns.asyncresolver
    import httpx

    res = dns.asyncresolver.Resolver(configure=False)
    res.nameservers = ["1.1.1.1", "8.8.8.8", "9.9.9.9"]
    res.timeout, res.lifetime = dns_timeout / 2, dns_timeout

    async def resolve(name, rtype):
        try:
            ans = await res.resolve(name, rtype)
        except Exception:
            return []
        if rtype == "MX":
            return [str(r.exchange).rstrip(".").lower() for r in ans]
        if rtype == "NS":
            return [str(r.target).rstrip(".").lower() for r in ans]
        return [r.to_text() for r in ans]

    limits = httpx.Limits(max_connections=60, max_keepalive_connections=0)
    client = httpx.AsyncClient(follow_redirects=True, timeout=http_timeout, limits=limits, verify=False,
                               headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "en-US,en;q=0.8"})

    async def fetch(url):
        async with client.stream("GET", url) as r:
            body = b""
            async for chunk in r.aiter_bytes():
                body += chunk
                if len(body) > max_bytes:
                    break
            ctype = r.headers.get("content-type", "")
            html = body.decode(r.encoding or "utf-8", "replace") if ("html" in ctype or not ctype or body[:200].lstrip().startswith(b"<")) else ""
            return r.status_code, str(r.url), dict(r.headers), html

    return resolve, fetch, client
