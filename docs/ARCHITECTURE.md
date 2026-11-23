# Architecture

## Components

| Part | Where it runs | What it does |
|---|---|---|
| Dashboard (`index.html`, `assets/`) | GitHub Pages (static, public code) | Login portal + app. Talks to Supabase with **supabase-js** using the *anon/publishable* key. No build step: plain ES modules. |
| Daily job (`scripts/run_daily.py`) | GitHub Actions, every 3 h (`.github/workflows/daily.yml`) | Downloads WhoisDS, sorts domains, runs seeds, lead checks, RDAP, Gap Finder, and writes to Supabase with the **service role** key. |
| Supabase Auth | Supabase | Email + password accounts. A trigger on `auth.users` creates the `profiles` row (admin / invited / pending / refused). |
| Supabase Postgres | Supabase | Users, analytics, per-user lists and seeds, shared leads / gaps / geo stats, job history. **Row-level security on every table.** |
| Supabase Storage, bucket `daily` (private) | Supabase | `zip/YYYY-MM-DD.zip` (original WhoisDS file), `niches/YYYY-MM-DD.json` (niche matches), `index.json` (day list + counts). |

## Security model

- The page and its JavaScript are public; **the data is not**. Every read goes through Supabase with the user's login token.
- `public.is_active_user()`: logged in, `status = 'active'`, not expired. `public.is_admin()`: active + `role = 'admin'`.
- RLS policies (see `supabase/schema.sql` and [DATABASE.md](DATABASE.md)):
  - shared data (`leads`, `gaps`, `geo_daily`, storage bucket `daily`): readable only when `is_active_user()`.
  - per-user data (`seeds`, `seed_hits`, `user_leads`): only the owner's own rows, and only while active.
  - `profiles`: own row, or all rows for admins. **No direct writes**: users change data only through functions that check permissions.
  - `activity`, `job_runs`, `invites`, `app_settings`: admins only.
- `anon` has no table access at all. The only function it may call is `get_public_settings()` (login page title / invite-only flag).
- Admin functions are `SECURITY DEFINER` and start with `admin_guard()`. They protect the owner, prevent self-demotion, and require ≥1 active admin.
- The service role key lives only in GitHub Secrets. Job-only functions (`job_*`) are revoked from `authenticated`.
- Sign-up control is in the `handle_new_user` trigger: owner → admin; invited → active (+ role/expiry from the invite);
  otherwise pending, or `raise exception` when `allow_requests = false` (Supabase returns "Database error saving new user").

## Daily job steps (`scripts/run_daily.py`)

Each step is idempotent. Progress flags per day are stored in `index.json` (`seeds`, `leads`), so a failed run is completed by the next one.

1. **sync**: list `zip/` in Storage. Upload any zip that is only in the local cache (the Actions cache, or the old repo `data/zip`: one-time migration).
2. **download**: `whoisds_downloader.available_dates()` + `download_day()`. The free tier has 4 days; the download URL is base64(`YYYY-MM-DD.zip`). New zips are uploaded.
3. **index**: for new days, or all days if `niches.json` changed (its sha1 → `niche_config`): `classify()` every domain →
   `niches/DATE.json` (rows `[domain, [niche ids], [keywords], location]`), day counts in `index.json`, and per niche+location counts in `geo_daily`.
4. **seeds**: `job_active_seeds()`. Seeds whose `processed_sig ≠ sig` are searched over **all** days (old hits deleted first). Others only over
   days not yet seed-processed. Results go to `seed_hits`, and `processed_sig` is set. Max 3,000 hits per seed per day.
5. **leads**:
   - Queue candidates (insert-ignore): niche rows on lead TLDs (`niches.json → leads.tlds`, not "generic"-only) from the last 30 days,
     seed hits on new days, and domains users track (`job_tracked_domains()`: ★ or a CRM status).
   - Check up to `max_checks_per_run` leads with `next_check_at <= now` (async, 40 at a time): DNS A/AAAA/MX/NS → HTTP GET (https then http,
     redirects followed, ≤ 400 KB) → `classify_page` (parked / coming_soon / placeholder / redirect / error / live + builder + title) →
     contacts (tel:/mailto:/text regex/socials, then `/contact` if none) → `score()`.
   - Schedule: `check_days` after registration (default 0, 7, 14, 30). Tracked leads every `tracked_recheck_days` (14). `history` keeps state changes.
   - **RDAP** for up to `rdap_per_run` checked leads with score ≥ 50 and no RDAP yet (IANA bootstrap → registry RDAP server; privacy-redacted values dropped).
6. **gaps**: demand = niche+city counts in the last 30 days of niche rows (cities only, ≥ 3). For the top 120 pairs × 2 `gap_terms` × 4 patterns:
   names already seen registered → taken. Others are checked (NS record → taken, else RDAP: 404 = available). Up to `gap_checks_per_run`, rechecked after 7 days.
7. **prune**: `job_prune()` removes untracked leads older than `keep_days`, geo stats > 400 days, activity > 365 days, job runs > 180 days.

The job writes a `job_runs` row (`running` → `ok` / `error` + `summary`), which the Admin → Data & jobs page shows.

## Matching rules (shared by Python and JavaScript)

- label = part before the first dot, lowercased, hyphens removed (`Dallas-Roofing.com` → `dallasroofing`).
- A niche matches if any keyword is a substring after removing every `exclude` word (`street` is removed before testing `tree`).
- Niches flagged `only_if_no_other` ("generic") apply only when nothing else matched.
- Location = first `locations` key (longest first) found in the label.
- Seed signature = `sorted(keywords).join(",") + "|" + sorted(exclude).join(",")`, which tells whether the job has processed the current seed keywords.
- Python: `scripts/classify.py`. JavaScript: `assets/js/core.js` (`labelOf`, `matchSeed`, `seedSig`, `makeLocator`). SQL: `seed_sig()`. **Keep these in sync.**

## Lead score (`scripts/leads.py → score`)

| Points | Reason |
|---|---|
| +30 / +20 / +10 | best niche value among the lead's niches: `high` / `medium` / `low` (`niches.json → value`). A seed-only match counts as medium. |
| +10 | `.com` |
| +10 | city or state in the name |
| +20 | MX records (email set up) |
| +20 | no real website yet: no_site, error, parked, coming_soon, placeholder |
| +10 | live site on a basic builder (Wix, GoDaddy Builder, Weebly, Google Sites, Carrd, Hostinger Builder, Duda) |
| −10 | redirects to another domain |
| +10 | phone or email found |
| +5 | registrant company visible (RDAP) |
| −5 each | label > 25 chars · digits · 2+ hyphens |

Clamped to 0–100; `score_reasons` stores the text shown in the dashboard. Hot = 70+.

## Dashboard modules (`assets/js/`)

| File | Role |
|---|---|
| `main.js` | Boot: config check → `onAuthStateChange` → `route()` (login / pending / blocked / forced password change / app). App shell: header, tabs (lazy `import()` per tab), user menu. Builds `ctx` (profile, cfg = niches.json, index, days, meta, locate, goto). |
| `auth-ui.js` | Login portal screens. |
| `api.js` | Supabase client, `rpc()`, `storageFile()` / `dayDomains()` (private Storage + JSZip), `logEvent()`, the `Lists` store (favorites / discards / CRM) and `Seeds` store. |
| `core.js` | DOM helper `el()`, formatting, charts (`drawBars`, `sparkline`), dialogs, toast, CSV, multi-select, badges, matching rules, US tile-map layout. |
| `niche.js` · `leads.js` · `research.js` · `daily.js` · `admin.js` | One tab each: `mount(host, ctx) → { show(opts), redraw() }`. |
| `guide.js` | Guide tab, the spotlight tour engine (`startTour(ctx, name)`, steps in `STEPS`), the ? help button. The welcome tour starts on the first sign-in (`profiles.tour_seen_at` is null) and only covers tabs the user can use. |

UI state per tab is remembered in `localStorage` (`dr_nf`, `dr_leads`, `dr_research`, `dr_admin`). Charts follow one rule set:
one hue (`--series-1`) for single series, a sequential blue ramp (`--seq-1..5`) for the map, a hover tooltip, and light + dark themes.

## Free-tier budget (approximate)

- Storage: about 0.35 MB zip + 0.3 MB niche JSON per day ≈ 240 MB/year (1 GB free).
- Database: leads ≈ 2–5 k/day × 120 days ≈ 300–600 k rows ≈ 150–300 MB (500 MB free). Lower `keep_days` or narrow `leads.tlds` if needed.
- Actions: free and unlimited on public repos. Each run takes about 2–10 min.
- Supabase free projects pause after 7 days idle; the job's writes every 3 h keep it active.
