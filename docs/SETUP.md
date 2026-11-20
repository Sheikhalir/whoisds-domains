# Setup guide

About 30 minutes, no coding. You need a free **GitHub** account and a free **Supabase** account.
The same steps work for moving the project to a new account (see the end of this page).

---

## 1. Create the Supabase project (login + database + private storage)

1. Go to <https://supabase.com>, sign up (GitHub sign-in is fine), and click **New project**.
   - Name: e.g. `domain-radar`. Set a strong database password and save it somewhere. Pick a region near you or your users.
   - Wait about 2 minutes until the project is ready.
2. **Run the database setup:**
   - Open `supabase/schema.sql` from this package in Notepad.
   - Find the line marked `<<< OWNER EMAIL` and replace `YOUR_EMAIL@example.com` with **your own email**.
     That account becomes the admin when you sign up.
   - In Supabase open **SQL Editor → New query**, paste the whole file and click **Run**.
   - The result should say `Domain Radar database is ready. Owner email: you@...`.
3. **Email settings:** go to **Authentication → Sign In / Providers → Email**:
   - Keep **Email** enabled.
   - Turn **Confirm email OFF** (recommended). Admin approval and invites already control who gets in, and Supabase's built-in
     email sender only delivers to your own team addresses unless you add custom SMTP (Resend, Brevo, etc.).
     If you do add SMTP later, you can turn confirmation back on and "Forgot password" emails will work too.
4. **URL settings:** go to **Authentication → URL Configuration** and set **Site URL** to your dashboard address from step 3.4
   (e.g. `https://YOUR-USERNAME.github.io/REPO-NAME/`). You can come back to this after step 3.
5. **Copy two keys:** go to **Project Settings → API Keys** (older projects: **Project Settings → API**):
   - **Project URL**, e.g. `https://abcdefgh.supabase.co`
   - **anon public** key (or the new **publishable** key `sb_publishable_…`). This goes in the dashboard and is safe to publish.
   - **service_role** key (under *Legacy API keys*) or a **secret** key (`sb_secret_…`). This one is **private**: it goes only into GitHub Secrets.

## 2. Put the files in GitHub

Use your existing repository (or create a new **public** one: *New repository → Public → Add a README*).

1. **If you used an older version:** delete these old files from the repository root (open each file → `…` → *Delete file*):
   `build_index.py`, `whoisds_downloader.py`, `seeds.json`, `daily.yml` and, if it exists, the `user/` folder.
   **Don't delete the `data/` folder.** The new job copies it into Supabase once and then removes it itself.
2. **Upload** (*Add file → Upload files*) everything from this package **except** the `.github` folder:
   `index.html`, `niches.json`, `README.md`, `AGENTS.md`, `CHANGELOG.md`, `.nojekyll`, and the folders `assets`, `scripts`, `supabase`, `docs`, `dev`.
   You can drag folders into the upload page. Then click **Commit changes**.
3. **Workflow file:** open `.github/workflows/daily.yml` in the repository (or *Add file → Create new file* with that exact name if it doesn't exist),
   click ✏️, replace everything with the contents of `.github/workflows/daily.yml` from this package, and commit.
4. **Connect the dashboard:** open `assets/js/config.js` in the repository, click ✏️, and fill in:
   ```js
   export const SUPABASE_URL = "https://abcdefgh.supabase.co";
   export const SUPABASE_ANON_KEY = "eyJ...  (anon)  or  sb_publishable_...";
   ```
   Commit. **Never put the service_role / secret key here.**

## 3. Secrets, first run, dashboard

1. **GitHub Secrets:** repository **Settings → Secrets and variables → Actions → New repository secret**, add two secrets:
   - `SUPABASE_URL` = the Project URL
   - `SUPABASE_SERVICE_KEY` = the service_role (or secret) key
2. **First run:** **Actions** tab → **Daily job** → **Run workflow**. The first run takes 2–10 minutes. It:
   uploads old data (if any) to Supabase, downloads the latest days from WhoisDS, sorts them, starts lead checks,
   and removes the old public `data/` folder from the repository.
   Green tick = done. Red cross: open the run, read the red lines (see *Troubleshooting*).
3. **GitHub Pages:** **Settings → Pages** → *Deploy from a branch* → `main` / `(root)` → **Save**.
   After 1–2 minutes the dashboard is at `https://YOUR-USERNAME.github.io/REPO-NAME/`.
4. **Create your admin account:** open the dashboard → **Create account** → use the **owner email** from step 1.2.
   You're in immediately as admin.
5. **Invite people:** **Admin → Invites**. See [ADMIN_GUIDE.md](ADMIN_GUIDE.md).

From now on the job runs **every 3 hours** by itself. Leads are checked a little more each run (about 4,000 checks per run).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Dashboard says **"Almost ready"** | `assets/js/config.js` still has the placeholders. Fill in URL + anon key, commit, wait 1 min, hard-reload (Ctrl+F5). |
| **"This tool is invite-only"** when signing up with your own email | The owner email in `schema.sql` didn't match. Edit the line, run the whole file again in SQL Editor, then sign up again (or sign in if the account exists). |
| **"Account not set up"** after login | Run `supabase/schema.sql` again: it creates profiles for accounts made before the setup. |
| Signed in but **"Waiting for approval"** as owner | Same as above: the owner email didn't match. Fix it and re-run `schema.sql`: it promotes the owner automatically. |
| Job fails: `SUPABASE_URL and SUPABASE_SERVICE_KEY must be set` | Add both GitHub Secrets (names must match exactly). |
| Job fails with **401 / 403** | Wrong key in `SUPABASE_SERVICE_KEY`: it must be the service_role / secret key, not the anon key. If a `sb_secret_` key fails, try the legacy `service_role` key (or the other way round). |
| Job fails: `relation "public.leads" does not exist` | `schema.sql` wasn't run in this Supabase project. |
| WhoisDS download step shows "not available (HTTP 403)" | WhoisDS may be blocking GitHub's servers that day. The job retries every 3 hours. If it persists, run `scripts/whoisds_downloader.py` on your own PC and upload the zips (see DEVELOPMENT.md). |
| Supabase project **paused** | Free projects pause after a week with no activity. The job runs every 3 hours, which keeps it active. If paused, click *Restore* in Supabase. |
| Everything shows 0 | Check Admin → Data & jobs. The job probably hasn't completed yet. |

---

## Moving to another account

1. New Supabase project → steps 1.2–1.5 (run `schema.sql` with the owner email).
2. New GitHub repository → upload all files → workflow → `config.js` → secrets → Pages (steps 2–3).
3. **Data:** the old Supabase project's files can be copied with the job's cache. The simplest way is to let the new job start fresh:
   it downloads the 4 days WhoisDS offers, and history builds from there. To keep history, download the old bucket's `zip/` folder
   (Supabase → Storage → daily → zip → select all → Download), put the files in a folder named `data/zip/` in the new repository,
   and run the job: it uploads them and removes the folder.
4. Users must create accounts again in the new project. Invite them from Admin → Invites.
