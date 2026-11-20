# Domain Radar

A private dashboard that turns the free daily **newly registered domains** list from
[whoisds.com](https://www.whoisds.com/newly-registered-domains) into:

- **Niche Finder**: every new domain sorted into 37 service niches (roofing, plumbing, tree service, HVAC, lawyers, dentists…), with a city or state detected in the name, plus **your own seed keywords** searched every day.
- **Leads**: "did they launch?" checks (website live, parked or coming soon, email set up), phone, email and socials found on their site, owner info from RDAP, a **0–100 lead score**, and a small **CRM** (status, follow-up date, notes).
- **Gap Finder**: exact-match `.com` names that are still free in busy niche + city markets.
- **Research**: **Momentum** (which niches are growing) and **Geography** (US state map and top cities).
- **Admin**: login portal, user approval and invites, roles, access expiry, temporary passwords, disable or delete, a usage analytics overview, an activity log, job health, and settings.

Everything runs on free tiers: **GitHub Pages** (dashboard) + **GitHub Actions** (daily job) + **Supabase** (login, database, private file storage).
Only approved, logged-in users can read any data. That's enforced by the database's row-level security, not just by the page.

```
 whoisds.com ──► GitHub Actions: scripts/run_daily.py (every 3 h)
                   │  download → sort into niches → seeds → lead checks → RDAP → gap finder
                   ▼
              Supabase (private)
                ├─ Storage "daily": zip/DATE.zip, niches/DATE.json, index.json
                ├─ Postgres: profiles, invites, activity, seeds, seed_hits, user_leads,
                │            leads, gaps, geo_daily, job_runs   (row-level security)
                └─ Auth: email + password
                   ▲
 Browser ──► GitHub Pages: index.html + assets/  (supabase-js, logs in, reads via RLS)
```

## Documentation

| Read this | If you want to |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | set it up from scratch, or move it to another GitHub/Supabase account |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | learn every feature of the dashboard |
| [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) | manage users, access and analytics |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | understand how it works (data flow, security, scoring, job steps) |
| [docs/DATABASE.md](docs/DATABASE.md) | look up tables, functions and security rules |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | change or extend it, and run the local test environment |
| [AGENTS.md](AGENTS.md) | read the rules for AI coding assistants working on this repo |
| [CHANGELOG.md](CHANGELOG.md) | see what changed between versions |

## Files

```
index.html                 dashboard page (loads assets/js/main.js)
assets/app.css             all styles (light + dark)
assets/js/config.js        ← your Supabase URL + anon/publishable key
assets/js/*.js             main (login routing, shell) · auth-ui · api · core · niche · leads · research · daily · admin
niches.json                built-in niches, keywords, locations, lead settings
scripts/run_daily.py       the daily job (GitHub Actions)
scripts/*.py               classify · supa · leads · rdap · gaps · whoisds_downloader
supabase/schema.sql        database setup: run once in Supabase SQL Editor (safe to re-run)
.github/workflows/daily.yml  schedule for the daily job
dev/                       local test environment + test suites (no Supabase needed)
docs/                      documentation
```
