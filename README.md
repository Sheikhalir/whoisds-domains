# WhoisDS Daily Downloader + Dashboard (runs free on GitHub)

Downloads the free **Newly Registered Domains** list from
[whoisds.com](https://www.whoisds.com/newly-registered-domains) every day,
automatically, on GitHub's servers. It sorts every domain into **service niches**
(Roofing, Plumbing, Tree Service, HVAC, Lawyers, Dentists… 37 in total), detects
**cities and states** in the name, and gives you a **web dashboard** to find, filter
and export them for niche research or outreach. Your computer doesn't need to be on.

## What's in this package

| File | What it does |
|---|---|
| `whoisds_downloader.py` | downloads the daily files |
| `build_index.py` | sorts domains into niches and updates the dashboard data |
| `niches.json` | the built-in niche categories, keywords and locations |
| `seeds.json` | **your own seed keywords** (edited from the dashboard) |
| `index.html` | the dashboard |
| `.nojekyll` | tells GitHub Pages to serve the files as they are |
| `daily.yml` | the daily schedule (goes in `.github/workflows/`) |

## Setup (about 10 minutes, no coding)

1. Create a free account at <https://github.com> if you don't have one.
2. Click **+** (top right) → **New repository**. Give it a name (e.g. `whoisds-domains`),
   choose **Public**, tick **Add a README file**, and click **Create repository**.
   (On a free account the dashboard only works for Public repos. See the note below.)
3. **Upload the files:** click **Add file → Upload files**, drag in
   `whoisds_downloader.py`, `build_index.py`, `niches.json`, `seeds.json`, `index.html` and `.nojekyll`, then click **Commit changes**.
   *If you can't see `.nojekyll`:* click **Add file → Create new file** instead, name it `.nojekyll`,
   leave it empty, and commit.
4. **Add the schedule:** click **Add file → Create new file**. In the name box, type exactly
   `.github/workflows/daily.yml`.
   Open `daily.yml` from this package in Notepad, copy everything, paste it in, and click **Commit changes**.
5. **First run:** open the **Actions** tab, click **Daily WhoisDS download** on the left,
   then **Run workflow → Run workflow**. Wait about 1 minute until it shows a green tick.
6. **Turn on the dashboard:** go to **Settings → Pages**. Under *Build and deployment*, set
   Source to **Deploy from a branch**, Branch to **main**, and folder to **/ (root)**, then click **Save**.
   After 1 to 2 minutes your dashboard is live at
   **`https://YOUR-USERNAME.github.io/whoisds-domains/`**
   (the exact link appears at the top of the Pages settings page).

After that it runs on its own every day at about 09:30 and 21:30 Pakistan time,
and the dashboard updates itself after each run.

## Using the dashboard

### Niche Finder tab (opens first)

1. **Pick a date range** (Latest day, 7 days, 30 days, All), **or pick a single day** from the dropdown.
   Clicking a bar in the chart also opens that day.
2. **Pick niches** on the left. Click one or more (e.g. *Roofing* + *Gutters*). The counts show how many new
   domains each niche got, which is useful for spotting busy niches.
3. **Narrow it down:** Extension (`.com only` is usually best for real businesses), Location (city or state
   found in the name), and *Search within results* (e.g. `emergency`, `24`, `pros`).
4. **Choose a layout:** **Table** is one list. **By niche** gives each niche its own section, so with a single
   day picked you get that day's domains separated by niche.
5. **Export:** **Export CSV** (one file), **Export by niche (.zip)** (one CSV per niche plus `_all.csv`), or **Copy**.

### Seed keywords (searched automatically every day)

Under **My seed keywords** (top of the niche list), click **+ Add** or **✎ Edit** and type one group per line:

```
Chimney: chimney, chimneysweep, flue
Stucco: stucco, plaster
Epoxy flooring: epoxy, garagefloor
siding
Tree jobs: tree, -street, -treehouse
```

- `Name: word1, word2`: a named group. A single word on its own is also fine.
- `-word`: leave out names containing that word (e.g. *street* contains *tree*).
- Spaces and dashes are ignored, so `tree service` finds `treeservice.com` and `tree-service.com`.

Each group becomes its own niche, marked **seed**. When you save and GitHub is connected (see below), the seeds
are saved into your repository. The daily job then searches **every stored day** within a few minutes, and
**every new day automatically** after that. Until it has run, the dashboard searches in your browser and shows
a **new** badge. Each day's Release also gets a `..._niches.csv` with all matches.

### Favorites ★ and Discard ✕

Every domain has two buttons:
- **☆ / ★ Favorite** saves it to the **★ Favorites** list, which keeps all dates and has its own Export CSV.
- **✕ Discard** hides it from all results and counts. An **Undo** button appears for a few seconds.
  **Discard this page** hides every domain on the current page, which is handy for clearing junk quickly.
- The **Discarded** list lets you **Restore** any domain, or everything.

### Connect GitHub (recommended, one time)

Without connecting, seeds, favorites and discards are saved **in this browser only**, and seeds are searched in
the browser (up to 60 days). Connecting lets the dashboard save them into your repository, so seeds run
automatically every day and your lists are the same on every device.

1. On the dashboard, click **Connect GitHub** (top right).
2. Click **Open GitHub's token page** and create a *fine-grained token*:
   - **Repository access** → *Only select repositories* → your repository
   - **Permissions → Repository permissions → Contents** → *Read and write*
   - **Generate token** and copy it
3. Paste it in the dashboard and click **Connect**. Anything you saved in the browser before is uploaded.

The token is stored only in your browser and only lets the dashboard change files in that one repository.
Don't connect on a shared computer. Tokens expire (you choose when), so reconnect with a new one when that happens.
Favorites and discards are saved in `user/lists.json` in your repository.

### Daily Files tab

- **Domains per day:** a chart of how many domains were stored each day. Hover over a bar for the count, or click it to open that day.
- **Stored files:** every saved date with its domain count and size. Click a row to open it, or click **zip** to download it.
- **Day viewer:** pick a date with the dropdown or the Prev/Next buttons, then:
  - search by *Contains / Starts with / Ends with / Regex* (e.g. contains `bank`)
  - click an extension (`.com`, `.xyz`…) to show only those domains
  - **Download .txt** saves exactly what you've filtered, and **Copy** puts it on your clipboard
- You can bookmark or share a specific day: `.../#2026-11-18`

## Changing the built-in niches

For your own keywords, use **seed keywords** (above). To change the built-in niches, open `niches.json` on GitHub and click the pencil icon. Each niche has:
- `keywords`: a domain matches if its name contains any of them, e.g. `"roofing", "roofer"`
- `exclude`: words that cause false matches, e.g. Tree Service excludes `street` (it contains *tree*)

Add a new niche by copying an existing line and changing the `id`, `name` and words. Click **Commit changes**.
The workflow starts by itself and re-sorts every stored day, which takes a few minutes. You can also add
places to the `locations` list at the bottom.

## About outreach

The free WhoisDS list contains **domain names only**, with no owner names, emails or phone numbers.
To reach an owner:
- Click **WHOIS** next to a domain. Some show a contact email or company, but many hide it behind privacy protection.
- Wait a few weeks and visit the domain. Many new service businesses put up a site with their phone number.
- Search the business name from the domain on Google Maps or Facebook.

Be careful when visiting brand-new domains. Some are used for scams or malware, so don't download anything
from them. Follow anti-spam rules (for example CAN-SPAM in the US) when you email anyone.

## Good to know

- **Public vs private:** on a free GitHub account, Pages (the dashboard) only works for public repos.
  The daily download works either way. A public repo means anyone with the link can see the
  domain lists, which are already public data from whoisds.
- **Failure alerts:** if a run fails, GitHub emails you automatically.
- **Missed days:** each run checks all 4 days the site offers, so one late run loses nothing.
- **Releases:** each day is also published as a Release with the `.zip` and `.txt`.
- **Stopping it:** go to Actions → Daily WhoisDS download → `...` → **Disable workflow**.
- **Changing the time:** edit the `cron:` lines in `daily.yml`. They're in UTC, which is Pakistan time minus 5 hours.
- **Cost:** free. Each run takes about a minute.
- **Storage:** about 1 MB per day (zip + niche data), so roughly 350 MB a year, well within GitHub's limits.
