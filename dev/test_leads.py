#!/usr/bin/env python3
"""Unit tests for scripts/leads.py, rdap.py, gaps.py, classify.py (offline).

    python dev/test_leads.py
"""
import asyncio
import os
import sys
import threading
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "..", "scripts"), HERE]
import classify as C  # noqa: E402
import gaps as G  # noqa: E402
import leads as L  # noqa: E402
import rdap as R  # noqa: E402

fails = 0


def check(name, ok, info=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"   -> {info}"))
    fails += 0 if ok else 1


# ---- page classification ----
cp = L.classify_page
check("GoDaddy parked page", cp("x.com", 200, "https://x.com/", "<title>x.com</title><body>Future home of something quite cool. Coming soon</body>")[0] == "parked")
check("Sedo for-sale page", cp("x.com", 200, "https://x.com/", "<body>This domain is for sale! Buy this domain at sedo.com</body>")[0] == "parked")
check("parking nameserver", cp("x.com", 200, "https://x.com/", "<body>hello</body>", ns=["ns1.bodis.com"])[0] == "parked")
check("coming soon", cp("x.com", 200, "https://x.com/", "<title>Coming Soon</title><body>" + "Our new site is launching soon. " * 20 + "</body>")[0] == "coming_soon")
check("nginx default page", cp("x.com", 200, "https://x.com/", "<title>Welcome to nginx!</title><body><h1>Welcome to nginx!</h1></body>")[0] == "placeholder")
check("nearly empty page = placeholder", cp("x.com", 200, "https://x.com/", "<html><body><div id=root></div></body></html>")[0] == "placeholder")
check("redirect to another brand", cp("x.com", 200, "https://www.otherbrand.com/home", "<body>" + "words " * 100 + "</body>")[0] == "redirect")
check("www + path is not a redirect", cp("x.com", 200, "https://www.x.com/home", "<body>" + "Roof repair and replacement. " * 20 + "</body>")[0] == "live")
check("HTTP 500 = error", cp("x.com", 500, "https://x.com/", "<body>Internal Server Error</body>")[0] == "error")
st, b, t = cp("x.com", 200, "https://x.com/", "<title>Dallas Roofing | Home</title><link href='https://static.wixstatic.com/a.css'><body>" + "We fix roofs. " * 30 + "</body>")
check("Wix site detected + title", (st, b, t) == ("live", "Wix", "Dallas Roofing | Home"), (st, b, t))
check("GoHighLevel detected", cp("x.com", 200, "https://x.com/", "<script src='https://link.msgsndr.com/js/form.js'></script><body>" + "service " * 60 + "</body>")[1] == "GoHighLevel")
check("WordPress detected", cp("x.com", 200, "https://x.com/", "<link href='/wp-content/themes/a.css'><body>" + "service " * 60 + "</body>")[1] == "WordPress")

# ---- contacts ----
ph, em, so = L.extract_contacts(
    "<a href='tel:(214) 555-0182'>Call</a> Call us 214.555.0199 or +1 (972) 555 0100. <a href='mailto:Info@DallasRoof.com?subject=hi'>email</a> "
    "<img src='logo@2x.png'> sales@dallasroof.com <a href='https://www.facebook.com/dallasroof/'>fb</a> <a href='https://www.facebook.com/sharer/sharer.php?u=x'>share</a>"
    " <a href='https://instagram.com/dallas_roof'>ig</a> 0000000000")
check("phones (tel: + text, deduped)", ph == ["+12145550182", "+12145550199", "+19725550100"], ph)
check("emails (mailto + text, junk skipped)", em == ["info@dallasroof.com", "sales@dallasroof.com"], em)
check("socials (share links skipped)", so == ["https://www.facebook.com/dallasroof", "https://instagram.com/dallas_roof"], so)

# ---- mx provider ----
check("MX providers", (L.mx_provider(["aspmx.l.google.com"]), L.mx_provider(["x-com.mail.protection.outlook.com"]), L.mx_provider(["mx.zoho.com"]),
                       L.mx_provider(["mailstore1.secureserver.net"]), L.mx_provider([])) == ("Google", "Microsoft 365", "Zoho", "GoDaddy", None))

# ---- score ----
val = {"roofing": "high", "food": "low"}
s1, r1 = L.score({"domain": "dallasroofing.com", "niche_ids": ["roofing"], "tld": "com", "loc": "Dallas, TX", "has_mx": True, "site_state": "parked"}, val)
check("hot lead: high niche + .com + city + email + no site = 90", s1 == 90, (s1, r1))
s2, _ = L.score({"domain": "best-pizza-4-u.xyz", "niche_ids": ["food"], "tld": "xyz", "site_state": "live", "builder": None}, val)
check("weak lead scores low", s2 == 0, s2)
s3, r3 = L.score({"domain": "acmeroof.com", "niche_ids": ["roofing"], "tld": "com", "has_mx": True, "site_state": "live", "builder": "Wix",
                  "phones": ["+1"], "registrant_org": "Acme LLC"}, val)
check("basic Wix site = upgrade lead", s3 == 85 and "+10 basic Wix site" in r3, (s3, r3))

# ---- schedule ----
now = datetime(2026, 11, 20, 12, tzinfo=timezone.utc)
n0 = L.schedule_next({"found_date": "2026-11-19", "checks": 1}, [0, 7, 14, 30], 14, False, now)
check("2nd check 7 days after registration", n0.date() == date(2026, 11, 26), n0)
check("checks stop after the last stage", L.schedule_next({"found_date": "2026-10-01", "checks": 4}, [0, 7, 14, 30], 14, False, now) is None)
check("tracked leads recheck every 14 days", L.schedule_next({"found_date": "2026-10-01", "checks": 9}, [0, 7, 14, 30], 14, True, now).date() == date(2026, 12, 4))
check("overdue check is not repeated immediately", L.schedule_next({"found_date": "2026-10-01", "checks": 1}, [0, 7, 14, 30], 14, False, now) >= now + timedelta(hours=20))

# ---- classify / locations ----
cfg = C.Config(os.path.join(HERE, "..", "niches.json"))
check("classify roofing + Dallas", C.classify("dallas-roofing-pros.com", cfg) == ["dallas-roofing-pros.com", ["roofing"], ["roofing"], "Dallas, TX"],
      C.classify("dallas-roofing-pros.com", cfg))
check("street is not Tree Service", C.classify("mainstreetbakery.com", cfg)[1] == ["food"], C.classify("mainstreetbakery.com", cfg))
check("generic only when nothing else", C.classify("acme-services.com", cfg)[1] == ["generic"] and "generic" not in C.classify("roofingservices.com", cfg)[1])
check("us_state_of", (C.us_state_of("Dallas, TX"), C.us_state_of("Texas"), C.us_state_of("London, UK"), C.us_state_of("Arlington, TX/VA")) == ("TX", "TX", None, "TX"))
check("signature matches SQL seed_sig format", C.signature(["flue", "chimney"], ["x"]) == "chimney,flue|x")

# ---- gaps ----
rows = [["a%d.com" % i, ["roofing"], ["roofing"], "Dallas, TX"] for i in range(5)] + [["b.com", ["roofing"], ["roofing"], "Texas"]]
pairs = G.demand_pairs(rows, cfg)
check("demand counts cities only", dict(pairs) == {("roofing", "Dallas, TX"): 5}, dict(pairs))
ideas = G.candidates(pairs, cfg, registered={"dallasroofing.com"})
names = [i["domain"] for i in ideas]
check("gap ideas", names[:4] == ["dallasroofing.com", "roofingdallas.com", "dallasroofingpros.com", "dallasroofingco.com"] and ideas[0]["status"] == "taken"
      and ideas[1]["us_state"] == "TX", names)

# ---- rdap parse ----
sample = {"events": [{"eventAction": "registration", "eventDate": "2026-11-18T03:04:05Z"}],
          "entities": [{"roles": ["registrar"], "vcardArray": ["vcard", [["fn", {}, "text", "GoDaddy.com, LLC"]]],
                        "entities": [{"roles": ["abuse"], "vcardArray": ["vcard", [["fn", {}, "text", "Abuse"]]]}]},
                       {"roles": ["registrant"], "vcardArray": ["vcard", [["org", {}, "text", "Domains By Proxy, LLC"], ["adr", {}, "text", ["", "", "", "", "Arizona", "", "US"]]]]}]}
p = R.parse(sample)
check("rdap: registrar + date, privacy org dropped", p == {"registrar": "GoDaddy.com, LLC", "registered": "2026-11-18", "registrant_org": None,
                                                         "registrant_state": "Arizona", "registrant_country": "US"}, p)


# ---- real HTTP fetcher against a local server (redirects, size limit, encoding) ----
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_GET(self):
        if self.path == "/go":
            self.send_response(301); self.send_header("Location", "/final"); self.send_header("Content-Length", "0"); self.end_headers(); return
        body = ("<title>Final page ✓</title>" + "x" * 900_000).encode() if self.path == "/final" else b"<title>ok</title>"
        self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)


srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]


async def real_fetch_test():
    os.environ["NO_PROXY"] = os.environ.get("NO_PROXY", "") + ",127.0.0.1,localhost"
    resolve, fetch, client = L.real_network()
    try:
        st, final, headers, html = await fetch(f"http://127.0.0.1:{port}/go")
        return st, final, len(html), "Final page ✓" in html
    finally:
        await client.aclose()

st, final, n, has_title = asyncio.run(real_fetch_test())
check("real fetcher follows redirects, keeps UTF-8, stops at ~400 KB", st == 200 and final.endswith("/final") and n < 500_000 and has_title, (st, final, n, has_title))

print("\n" + ("ALL PASSED" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
