#!/usr/bin/env python3
"""Create realistic-looking fake WhoisDS daily zips for local testing.

    python dev/make_sample_data.py --out /tmp/dr_cache/zip --days 10

Each day has ~60-70k random names; about 7% look like service businesses
("dallas-roofing-pros.com", "chimneysweepflorida247.site", ...).
"""
import argparse
import datetime as dt
import os
import random
import zipfile

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--days", type=int, default=10)
ap.add_argument("--seed", type=int, default=7)
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
random.seed(a.seed)
filler = "shop best my get cloud smart green go app hub ai bet store news crypto meta nova blue sun star alpha zen pixel lux".split()
svc = ["roofing", "roofers", "plumbing", "plumber", "hvac", "heatingandcooling", "treeservice", "treeremoval", "arborist", "lawncare", "landscaping",
       "pestcontrol", "cleaning", "maids", "painters", "remodeling", "handyman", "concrete", "fencing", "movers", "junkremoval", "locksmith",
       "poolservice", "autorepair", "towing", "dentist", "lawyer", "realty", "salon", "barber", "fitness", "pizza", "pressurewashing",
       "guttercleaning", "electrician", "garagedoor", "waterdamage", "daycare", "homecare", "seoagency", "chimneysweep", "stucco"]
mods = ["pros", "experts", "llc", "co", "services", "247", "near", "best", "pro", "team", "guys", ""]
cities = ["dallas", "houston", "austin", "miami", "tampa", "orlando", "atlanta", "phoenix", "denver", "chicago", "seattle", "nyc", "brooklyn",
          "london", "toronto", "texas", "florida", "ohio", "katy", "charlotte"] + [""] * 6
tlds = ["com"] * 45 + ["net"] * 5 + ["org"] * 3 + ["xyz"] * 8 + ["online"] * 4 + ["shop"] * 4 + ["co"] * 2 + ["us"] * 2 + ["top"] * 4 + ["site"] * 3 + ["info"] * 2
end = dt.date.today() - dt.timedelta(days=2)
for i in range(a.days):
    d = end - dt.timedelta(days=a.days - 1 - i)
    n, out = random.randint(60000, 72000), []
    for _ in range(n):
        if random.random() < 0.07:
            c, s, m = random.choice(cities), random.choice(svc), random.choice(mods)
            parts = [c, s, m] if random.random() < .6 else [s, c, m]
            out.append(("-" if random.random() < .25 else "").join(p for p in parts if p) + "." + random.choice(tlds))
        else:
            out.append(f"{random.choice(filler)}{random.choice(filler)}{random.randint(1, 99999)}.{random.choice(tlds)}")
    with zipfile.ZipFile(os.path.join(a.out, f"{d}.zip"), "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("domain-names.txt", "\n".join(out) + "\n")
    print(d, n)
