# Database reference

Everything is created by `supabase/schema.sql` (idempotent: re-run it after updates). All tables are in `public` with RLS enabled.

## Tables

| Table | Rows | Written by | Read by |
|---|---|---|---|
| `app_settings` | 1 (`id = 1`): `owner_email`, `site_title`, `allow_requests`, `default_expiry_days` | admin functions | admins (public subset via `get_public_settings`) |
| `profiles` | one per auth user: `email, full_name, role (admin/user), status (pending/active/disabled), expires_at, must_change_password, notes, approved_at/by, last_seen_at, last_login_at` | trigger + functions | own row; admins all |
| `invites` | `email (pk), role, expires_at, note, invited_by` | admin functions | admins |
| `activity` | `user_id, email, action, detail jsonb, at` | `log_event()` + functions | admins |
| `seeds` | per user: `name, keywords[], exclude[], sig` (trigger) `, processed_sig, processed_at` | `save_my_seeds()`; job sets `processed_sig` | owner |
| `seed_hits` | `(seed_id, date, domain)`, `kw, loc` | job | owner of the seed |
| `user_leads` | `(user_id, domain)`: `fav, discarded, status (new/contacted/replied/meeting/won/lost), note, follow_up, found_date, niche_ids, kws, loc` | `set_my_leads()` | owner |
| `leads` | one per domain: found info, DNS/site/contact results, RDAP owner, `score, score_reasons, checks, stage, last_checked_at, next_check_at, history` | job | active users |
| `gaps` | `domain (pk), niche_id, location, us_state, term, pattern, demand, status (available/taken/unknown), checked_at` | job | active users |
| `geo_daily` | `(date, niche_id, loc)`, `us_state, n` | job | active users |
| `job_runs` | `started_at, finished_at, status (running/ok/error), summary jsonb, error` | job | admins |

Storage bucket **`daily`** (private): `zip/DATE.zip`, `niches/DATE.json`, `index.json`, readable only by active users.

## Functions used by the dashboard

| Function | Who | Purpose |
|---|---|---|
| `get_public_settings()` | anyone | `{site_title, allow_requests}` for the login page |
| `my_profile()` | logged in | own profile + `is_active`, `is_expired` |
| `update_my_profile(p_full_name)` | logged in | change own name |
| `password_changed()` | logged in | clears `must_change_password` |
| `log_event(p_action, p_detail)` | logged in | analytics event; updates `last_seen_at` (+ `last_login_at` for `login`) |
| `list_my_seeds()` / `save_my_seeds(p jsonb)` | active | read / replace own seed groups `[{id?, name, keywords[], exclude[]}]` (keywords cleaned to `[a-z0-9]`, ≥ 3 chars) |
| `my_seed_hits(p_from, p_to)` | active | own seed matches (only for seeds processed with their current keywords) |
| `seed_daily_counts(p_from, p_to)` | active | per seed per day counts (Momentum) |
| `my_lists()` | active | own `user_leads` rows |
| `set_my_leads(p_domains[], p jsonb)` | active | upsert keys present in `p` (`fav, discarded, status, note, follow_up`, plus first-time `found_date, niche_ids, kws, loc`). Discarding also removes ★. Rows with nothing left are deleted. Max 1,000 domains. |
| `search_leads(p jsonb)` | active | `{total, rows[], by_state, hot, need_site, with_contact, followups_due, crm}`. `p`: `from, to, niches[], site_states[], us_state, loc, min_score, has_mx, has_contact, q, view (all/pipeline/followups), statuses[] ('none' = no status), sort (score/found/followup/updated), limit ≤ 500, offset`. Own discards are excluded. |
| `get_gaps(p jsonb)` | active | `p`: `niches[], us_state, status (available default / all), min_demand, limit ≤ 1000` |
| `geo_summary(p_from, p_to, p_niches[])` | active | `(loc, us_state, niche_id, n)` sums |
| `admin_list_users()` | admin | profiles + 30-day counts (events, logins, exports) + favorites / pipeline / seeds |
| `admin_update_user(p_id, p jsonb)` | admin | `role, status, expires_at (null = never), notes, full_name`. Approving a pending user applies `default_expiry_days` unless `expires_at` is given. |
| `admin_set_password(p_id, p_password)` | admin | bcrypt into `auth.users`; sets `must_change_password` |
| `admin_delete_user(p_id)` | admin | deletes from `auth.users` (cascades) |
| `admin_invite(p_email, p_role, p_expires_at, p_note)` / `admin_list_invites()` / `admin_revoke_invite(p_email)` | admin | invites |
| `admin_get_settings()` / `admin_update_settings(p jsonb)` | admin | settings |
| `admin_activity(p jsonb)` | admin | `p`: `user_id, action, before, limit ≤ 500` |
| `admin_stats(p_days)` | admin | users, active 1/7/30 d, `by_day`, actions, top users, tabs, niches, exports, data sizes, last job |
| `admin_job_runs(p_limit)` | admin | job history |

## Functions for the daily job (service role only)

`job_active_seeds()`, `job_tracked_domains()`, `job_prune(p_lead_days, p_geo_days, p_activity_days)`.
The job also writes the tables directly through PostgREST (`/rest/v1/...`) and Storage (`/storage/v1/...`), see `scripts/supa.py`.

## Adding a table

1. `create table if not exists ...` in `schema.sql`.
2. `alter table ... enable row level security;` + policies (never leave a table without RLS).
3. `revoke all on ... from anon;` and, for shared data, `revoke insert, update, delete ... from authenticated`.
4. Add a test to `dev/test_database.py` for each role (anon / pending / active / admin).
