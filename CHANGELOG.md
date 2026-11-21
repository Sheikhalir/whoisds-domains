# Changelog

## 3.1: feature access per user
- **Admin → Users → Access**: allow, lock (🔒 tab with a message) or hide Niche Finder, Leads, Research and Daily Files for each user.
  Also in Edit, Approve, Invites (applied at sign-up) and a default for new requests in Settings. Users table and CSV show each user's access.
- Enforced by the database (`has_feature()` in RLS policies, storage and functions), not just hidden in the page. Admins always have everything.
- Faster lead search: access checks in policies are evaluated once per query.
- Upgrade: re-run `supabase/schema.sql` (with your owner email) in the SQL Editor, then upload the changed files.

## 3.0: private multi-user version
- **Login portal** on Supabase Auth: sign in, create account / request access, waiting-for-approval, disabled / expired screens,
  temporary password → forced change, change name / password.
- **Admin**: overview analytics (active users, sign-ins, exports, tabs, niches, actions, data and storage usage, job health,
  "needs attention"), users (approve / decline / edit role, status and access end date / disable / temp password / delete / activity / CSV),
  invites (bulk, role, access length, copy invite message), activity log, data & jobs, settings (title, invite-only, default access length).
- **All data private**: moved from the public repo to Supabase Storage + Postgres with row-level security. The old `data/` folder migrates automatically.
- **Leads tab**: "did they launch?" checks at 0/7/14/30 days (website status, builder, MX/email provider, contacts, socials),
  RDAP owner info, a 0–100 lead score with reasons, CRM (status, follow-up, notes), My pipeline, Follow-ups due, a details panel, CSV export.
- **Gap Finder**: available exact-match .com names for busy niche + city markets.
- **Research tab**: Momentum (period vs previous, sparklines, history chart) and Geography (US tile map, cities / states / outside US).
- Seeds, favorites and discards are now **per user** in the database (one-click import from the old browser-only version).
- Job runs every 3 hours, resumes after failures, records its runs, and prunes old data.
- Docs for setup, users, admins, architecture, database, development and AI agents. Local test environment with 111 automated checks.

## 2.x: GitHub Pages dashboard
- Niche Finder (37 niches, locations), seed keywords, favorites / discards, by-niche view, exports. Data stored publicly in the repository.

## 1.0: downloader
- Daily WhoisDS download script for Windows / GitHub Actions.
