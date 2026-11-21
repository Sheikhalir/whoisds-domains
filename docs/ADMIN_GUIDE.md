# Admin guide

Admins see an extra **Admin** tab. The **owner** (the email set in `supabase/schema.sql`) is always an admin and can't be
demoted, disabled or deleted by other admins.

## How people get access

| Way | What happens |
|---|---|
| **Invite** (Admin → Invites) | You add their email (+ role, access length, note). When they create an account with that email they're **active immediately**. Use **Copy invite message** to send them the link. |
| **Request** (they sign up uninvited) | Their account is **Pending**. A banner shows "N access requests waiting". Approve (choose role + access length) or Decline. |
| **Invite-only mode** (Settings → turn off *Allow access requests*) | Uninvited sign-ups are refused with "This tool is invite-only". |

## Users (Admin → Users)

Filter: All · Pending · Active · Expired · Disabled · Admins, plus search (name, email, notes). Columns show last seen,
sign-ins / actions / exports in 30 days, favorites, pipeline size and seed groups.

Actions:
- **Approve / Decline** (pending requests).
- **Edit**: name, role (User / Admin), status (Active / Pending / Disabled), **access end date** (never, or a date; quick +7 / +30 / +1 year), feature access, admin notes.
- **Access**: choose per feature (Niche Finder, Leads, Research, Daily Files) whether the person may use it. See *Feature access* below.
- **Disable / Enable**: blocks or restores access instantly. Their data is kept.
- **Password**: sets a **temporary password** (auto-generated, or type one). They must choose their own at the next sign-in.
  **Copy message** gives you a ready-to-send text with the link, email and password.
- **Activity**: their activity log.
- **Delete**: permanently removes the account and all its data (type the email to confirm). Prefer *Disable* if unsure.
- **Export CSV** of all users.

Expired, disabled and pending accounts can't read **any** data. The database enforces this, so it can't be bypassed from the browser.
You can't remove your own admin access, and there must always be at least one active admin.

## Feature access

Each feature can be set per user to:

| Setting | What the user sees | Data |
|---|---|---|
| **Allowed** | the tab works normally | readable |
| **Locked** | the tab shows 🔒 and a "locked for your account" message | blocked |
| **Hidden** | no tab at all | blocked |

- Set it in **Users → Access** (or **Edit**), when **approving** a request, or for new people in **Invites** (applies when they sign up).
- **Settings → Feature access** is the default for new access requests and is pre-filled in the invite form. Existing users keep their own settings.
- The database enforces it, so a locked or hidden feature can't be opened from the browser console either:
  Leads also covers Gap Finder, Daily Files covers the original zip files, Niche Finder covers the daily niche files and seed matches,
  Research covers location stats and seed momentum.
- Admins always have every feature. Changes take effect the next time the user loads the page.
- Without Daily Files, Niche Finder doesn't search *new* seed keywords in the browser; their matches appear after the next daily run (≤ 3 hours).

## Overview (analytics)

- **Needs attention**: pending requests, accounts expiring within 7 days, a failed or overdue daily job.
- Tiles: users (active / pending / blocked), active today / this week / this month, sign-ins and new accounts (30 days), exports and rows downloaded.
- Charts: active users per day, sign-ins per day.
- Lists: most active users, most used tabs, most researched niches, what people do, leads by website status.
- Data: leads stored / checked / hot, Gap Finder names available, seeds, favorites / pipeline, database and storage size vs the free tier, last job status.

## Activity log

Every sign-in, tab view (at most once per 10 minutes per tab), niche selection, export, seed change, lead opened and admin action,
with user and details. Filter by user and action, **Load older**, **Export CSV**. Kept for 365 days.

## Data & jobs

The daily job's run history: duration, status, new days, leads checked, hot leads, owner lookups, Gap Finder checks, seeds re-run, and errors.
**Open GitHub Actions** opens the job page (from there: *Run workflow* to run it now). Also shows free-tier usage and cleanup rules.

## Settings

- **Dashboard name** (login page + header).
- **Allow access requests** (off = invite-only).
- **Default access length** for approved requests (days, empty = never expires).
- Owner email (read-only here; change it in `schema.sql` and re-run it).

## Good practice

- Give clients a fixed access length (e.g. 30 days) and extend it when they renew.
- Use **Disable** instead of **Delete** when someone pauses. Their pipeline and notes stay.
- Check **Overview → Needs attention** once a week.
- Keep the service_role / secret key only in GitHub Secrets. If it ever leaks, rotate it in Supabase (Project Settings → API Keys) and update the GitHub secret.
