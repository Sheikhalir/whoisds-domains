# Development guide

No build step: edit files, commit, and GitHub Pages serves them about 1 minute later. The job changes take effect on the next run
(pushing to `scripts/**` or `niches.json` also starts a run).

## Local test environment (no Supabase account, no internet)

`dev/` recreates Supabase locally so the **real** `schema.sql`, the **real** job and the **real** dashboard can be tested:

| File | What |
|---|---|
| `dev/supabase_shim.sql` | Supabase's built-in roles, `auth.users`, `auth.uid()`, storage tables, pgcrypto: just enough for `schema.sql` |
| `dev/mock_supabase.py` | HTTP stand-in for Supabase Auth / PostgREST / Storage backed by real PostgreSQL. **Each request runs as the caller's role with JWT claims, so RLS is enforced for real.** Also serves the dashboard and generates `assets/js/config.js`. |
| `dev/fake_network.py` | offline DNS / websites / RDAP with stable per-domain behaviour |
| `dev/make_sample_data.py` | realistic fake WhoisDS zips |
| `dev/run_local.sh` | starts it all: Postgres → schema → mock → sample data → daily job |
| `dev/test_database.py` | 56 security + function checks (anon / pending / user / expired / disabled / admin / service role) |
| `dev/test_leads.py` | 32 checks: page classification, contacts, scoring, schedule, matching, gaps, RDAP parsing, real HTTP fetcher |
| `dev/e2e_test.py` | 23 browser checks (Playwright): invites, approvals, leads, pipeline, follow-ups, CSV, Gap Finder, research, temp password, disable, invite-only, analytics, mobile + dark |

```bash
pip install "psycopg[binary]" PyJWT httpx dnspython playwright && playwright install chromium
npm i @supabase/supabase-js@2 jszip@3.10.1           # local copies for the browser test (CDN is blocked offline)
export SUPABASE_JS=$PWD/node_modules/@supabase/supabase-js/dist/umd/supabase.js JSZIP_JS=$PWD/node_modules/jszip/dist/jszip.min.js
./dev/run_local.sh          # then open http://localhost:8800  (owner@test.com / pass1234)
./dev/run_local.sh test     # everything + all three test suites
```
Needs PostgreSQL 14+ server binaries (`PG_BIN` to override). Variables: `PGDIR`, `PGPORT`, `MOCK_PORT`, `CACHE`, `DAYS`, `MAX_CHECKS`.

The mock implements only what this project uses (see the docstring). If you use a new supabase-js feature, check that the mock supports it.

## Common changes

**Add or tune a niche.** Edit `niches.json`: `id`, `name`, `group`, `keywords`, `exclude`, `value` (high/medium/low → lead score),
`gap_terms` (Gap Finder name ideas). Run `python dev/test_leads.py`. On push, the job re-sorts every stored day (the config hash changes).

**Change the lead score.** `scripts/leads.py → score()`. Update the table in `docs/ARCHITECTURE.md` and `docs/USER_GUIDE.md`, and the tests
in `dev/test_leads.py`. Existing leads get the new score at their next check. To rescore everything now, set
`update leads set next_check_at = now()` in the SQL Editor (they're re-checked gradually, `max_checks_per_run` per run).

**Change what counts as a lead.** `niches.json → leads.tlds`, `check_days`, `tracked_recheck_days`, `max_checks_per_run`, `rdap_per_run`,
`gap_checks_per_run`, `keep_days`.

**Add a dashboard tab.** Create `assets/js/mytab.js` exporting `mount(host, ctx) → { show(opts), redraw() }`, then add it to `TABS` in
`assets/js/main.js`. Read data with `rpc()` / `storageFile()` from `api.js`. Log usage with `logEvent("view", {tab})` (done by the shell).

**Add a database function.** Put it in `schema.sql`. Use `security invoker` when RLS should apply, or `security definer` + `admin_guard()` /
`is_active_user()` checks. The `revoke … from public, anon` block at the end handles permissions. Add tests to `dev/test_database.py`.

**Run the downloader on your own PC** (if WhoisDS blocks GitHub): `python scripts/whoisds_downloader.py -o mydata --no-extract`, then put
the zips in `data/zip/` in the repo. The next job run uploads them and removes the folder.

## Conventions

- JS: ES modules, no framework, no build. DOM is built with `el(tag, attrs, ...children)` from `core.js`. Never use `innerHTML` with data.
- Text the user sees is plain English. Errors go through `errText()` (maps database error codes like `ADMIN_ONLY` to sentences).
- Database error codes are raised as `CODE: explanation` (e.g. `OWNER_PROTECTED: …`).
- Python: standard library + `httpx` + `dnspython` only (`scripts/requirements.txt`).
- The matching rules exist in three places (Python, JS, SQL `seed_sig`). Change them together.
