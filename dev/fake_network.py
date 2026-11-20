"""Offline stand-in for DNS / websites / RDAP, used by `run_daily.py --fake-network` in tests.

Every domain is put in a stable "bucket" (from a hash of its name) so the same domain
always behaves the same way: no website, parked, coming soon, placeholder, Wix site with a
phone, WordPress site with an email on /contact, redirect, or broken server.
"""
import hashlib

BUCKETS = ["no_site", "no_site", "parked_ns", "parked_page", "coming_soon", "placeholder", "wix_phone",
           "wp_contact", "live_custom", "redirect", "error", "no_site_mx"]
TAKEN_GAPS = {"dallasroofing.com", "roofingdallas.com", "miamiplumbing.com"}


def bucket(domain):
    h = int(hashlib.md5(domain.encode()).hexdigest(), 16)
    return BUCKETS[h % len(BUCKETS)], h


async def resolve(name, rtype):
    name = name.lower()
    if name in TAKEN_GAPS:
        return ["ns1.registrar-servers.com"] if rtype == "NS" else ["1.2.3.4"] if rtype == "A" else []
    b, h = bucket(name)
    if h % 5 == 0 and name.endswith(".com") and len(name) < 30 and name.count("-") == 0 and not any(c.isdigit() for c in name):
        return []          # this name is unregistered (matches rdap_get's 404 below)
    has_mx = h % 3 != 0 or b == "no_site_mx"
    if rtype == "MX":
        return (["aspmx.l.google.com"] if h % 2 else ["mx1.privateemail.com"]) if has_mx else []
    if rtype == "NS":
        return ["ns1.parkingcrew.net"] if b == "parked_ns" else ["ns1.domaincontrol.com"]
    if rtype in ("A", "AAAA"):
        return [] if b in ("no_site", "no_site_mx") or rtype == "AAAA" else ["1.2.3.4"]
    return []


PAGES = {
    "parked_page": "<html><head><title>example.com</title></head><body>This domain may be for sale! Related searches</body></html>",
    "coming_soon": "<html><head><title>Coming Soon</title></head><body><h1>Coming soon</h1><p>We're launching our new website.</p></body></html>",
    "placeholder": "<html><head><title>Welcome to nginx!</title></head><body><h1>Welcome to nginx!</h1></body></html>",
    "wix_phone": ("<html><head><title>{name} | Roofing & Repairs</title><script src='https://static.parastorage.com/x.js'></script>"
                  "<link href='https://static.wixstatic.com/a.css'></head><body>" + "Family owned business serving the area. " * 12 +
                  "<a href='tel:+1-214-555-0182'>Call (214) 555-0182</a> <a href='https://www.facebook.com/{fb}'>Facebook</a></body></html>"),
    "wp_contact": ("<html><head><title>{name} - Home</title><link rel='stylesheet' href='/wp-content/themes/x/style.css'></head><body>"
                   + "Quality service you can trust, call us today for a free estimate. " * 10 + "</body></html>"),
    "live_custom": ("<html><head><title>{name}</title></head><body>" + "Professional services with 20 years of experience. " * 15 +
                    "Email us at info@{domain} or call 305.555.0147</body></html>"),
}


async def fetch(url):
    from urllib.parse import urlsplit
    host = urlsplit(url).hostname
    path = urlsplit(url).path
    b, h = bucket(host)
    if b == "error":
        raise ConnectionError("connection refused")
    if b == "redirect":
        return 200, "https://www.someotherbrand.com/", {}, "<html><title>Other brand</title><body>" + "x " * 300 + "</body></html>"
    name = host.split(".")[0].title()
    if b == "wp_contact" and path.startswith("/contact"):
        return 200, url, {}, f"<html><body><a href='mailto:office@{host}'>office@{host}</a></body></html>"
    html = PAGES.get(b, PAGES["live_custom"]).format(name=name, domain=host, fb=host.split(".")[0])
    return 200, url, {"server": "nginx"}, html


async def rdap_get(url):
    if url.endswith("dns.json"):
        return 200, {"services": [[["com", "net"], ["https://rdap.verisign.com/com/v1/"]], [["org"], ["https://rdap.publicinterestregistry.org/rdap/"]]]}
    dom = url.rsplit("/", 1)[-1]
    b, h = bucket(dom)
    if dom in TAKEN_GAPS:
        return 200, {"ldhName": dom}
    if h % 5 == 0:   # some names are unregistered
        return 404, None
    org = "Smith Roofing LLC" if h % 3 == 0 else "REDACTED FOR PRIVACY"
    return 200, {"ldhName": dom, "events": [{"eventAction": "registration", "eventDate": "2026-11-15T10:00:00Z"}],
                 "entities": [{"roles": ["registrar"], "vcardArray": ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "NameCheap, Inc."]]]},
                              {"roles": ["registrant"], "vcardArray": ["vcard", [["version", {}, "text", "4.0"], ["org", {}, "text", org],
                                                                                  ["adr", {}, "text", ["", "", "", "", "TX", "", "US"]]]]}]}
