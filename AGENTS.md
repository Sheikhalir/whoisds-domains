# Notes for AI coding assistants (and new developers)

Read `README.md` → `docs/ARCHITECTURE.md` → `docs/DATABASE.md` first. This file lists the rules that are easy to break.

## What this is
Static dashboard (GitHub Pages, `index.html` + `assets/js/*.js` ES modules, no build) + a Python job on GitHub Actions
(`scripts/run_daily.py`) + Supabase (Auth, Postgres with RLS, private Storage bucket `daily`). Setup steps: `docs/SETUP.md`.

## Hard rules
1. **Every table has RLS.** New tables: enable RLS, add policies, `revoke all … from anon`, and revoke writes from `authenticated` for shared data.
   Users write only through functions. Add role tests to `dev/test_database.py`.
2. **Never put the service role / secret key in the dashboard.** `assets/js/config.js` holds only the URL + anon/publishable key.
   The job reads `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` from GitHub Secrets.
3. **Admin functions** are `security definer`, `set search_path = public`, and start with `perform public.admin_guard();`.
   Keep the owner protection, the no-self-demotion rule and the "≥1 active admin" rule.
4. **Matching rules exist in three places**: `scripts/classify.py`, `assets/js/core.js` (`labelOf`, `matchSeed`, `seedSig`, `makeLocator`),
   and `seed_sig()` in `schema.sql`. Change them together.
5. `supabase/schema.sql` must stay **idempotent** (`create … if not exists`, `create or replace`, `drop policy if exists`). Users re-run it to update.
6. The job must stay **re-runnable**: per-day progress flags in `index.json` (`seeds`, `leads`). A crash mid-run must be completed by the next run.
7. Don't render untrusted text with `innerHTML`. Use `el()` from `core.js` (domain names, page titles and emails come from the internet).
8. Keep it on free tiers. Watch DB size (leads), Storage size, and Actions run time (`timeout-minutes: 90`).

## Where things are
| Need | File |
|---|---|
| login / routing / tabs | `assets/js/main.js`, `assets/js/auth-ui.js` |
| Supabase calls, lists, seeds | `assets/js/api.js` |
| helpers, charts, dialogs | `assets/js/core.js` |
| tabs | `assets/js/niche.js`, `leads.js`, `research.js`, `daily.js`, `admin.js` |
| niches, keywords, lead settings | `niches.json` |
| job | `scripts/run_daily.py` (+ `classify.py`, `leads.py`, `rdap.py`, `gaps.py`, `supa.py`, `whoisds_downloader.py`) |
| database | `supabase/schema.sql` |
| schedule | `.github/workflows/daily.yml` |

## Testing (do this before you finish)
```bash
./dev/run_local.sh test      # Postgres + mock Supabase + sample data + job, then the 3 suites
```
- `dev/test_database.py`: RLS and functions per role
- `dev/test_leads.py`: job logic
- `dev/e2e_test.py`: browser flows (Playwright; set SUPABASE_JS / JSZIP_JS to local copies)
If you add a feature, add a check to the matching suite. See `docs/DEVELOPMENT.md` for setup.

## Style
Plain-English UI copy (users are non-technical). Small, readable functions. No new dependencies unless needed
(Python: httpx + dnspython; browser: supabase-js + JSZip from CDN, pinned versions in `index.html`).
