# User guide

Sign in at your dashboard address. If you don't have an account, click **Create account**:
- **Invited** emails get in immediately.
- Others wait for the admin's approval ("Waiting for approval" screen → click **Check again** later).
- Forgot your password? Ask the admin for a temporary password. You'll choose your own at the next sign-in.

Your menu (top right) has **Change my name**, **Change password**, **Sign out**.
Favorites, discards, notes and seed keywords belong to **your account**. They follow you to any device, and other users can't see them.

---

## Niche Finder

New domains from the last days, sorted into niches.

- **Date range**: *Latest day*, *7 days*, *30 days*, *All*, or **pick one day**. Clicking a bar in the chart also opens that day.
- **Niches** (left): click one or more. The counts follow your other filters.
- **Filters**: *Extension* (`.com only` is best for real businesses), *Location* (city or state found in the name),
  *Search within results*. A "Filters on … Clear filters" line shows whenever a filter is active.
- **Layout**: *Table* (one list) or **By niche** (one section per niche, ideal with a single day).
- **Export**: *Export CSV*, **Export by niche (.zip)** (one CSV per niche), *Copy*.
- **★ Favorite / ✕ Discard** on every row. Discarded domains disappear from all lists and counts (with **Undo**).
  *Discard this page* clears 100 at once. **★ Favorites** and **Discarded** tabs show your lists. *Restore* brings domains back.

### My seed keywords (searched every day)
Top of the niche list → **+ Add** / **✎ Edit**. One group per line:
```
Chimney: chimney, chimneysweep, flue
Stucco: stucco, plaster
siding
Tree jobs: tree, -street, -treehouse
```
`Name: words` makes a named group, a single word is fine too, and `-word` excludes names containing it. Spaces and dashes are ignored.
Each group becomes its own niche (marked **seed**). New seeds are searched in your browser right away (**new** badge)
and processed for all stored days at the next daily run.

---

## Leads

Each new niche domain on a main extension (.com .net .org .co .us .biz .pro), plus every domain you ★, is checked automatically
**on the day it appears, then after 7, 14 and 30 days**. Domains you track (★ or a status) are re-checked every 14 days.

**Website status**
| Status | Meaning |
|---|---|
| No website | no web server yet |
| Server not working | the domain points somewhere, but the site doesn't load |
| Parked / for sale | registrar parking or for-sale page |
| Coming soon | "coming soon / under construction" page |
| Placeholder page | default server page or empty site |
| Live website | a real site (the builder is shown: Wix, GoDaddy, WordPress, GoHighLevel, …) |
| Redirects elsewhere | forwards to a different domain |

**Email set up** = the domain has mail (MX) records. That's a strong sign of a real business, and the provider is shown (Google, Microsoft 365, …).
**Contact** = phone, email and social links found on their site (homepage, then /contact).
**Owner** = registrar and, when not privacy-protected, company and state (from RDAP, the official replacement for WHOIS).

**Lead score (0–100)**: hover the score or open **Details** to see why. Roughly:
+30/20/10 niche value (high/medium/low) · +10 .com · +10 city/state in name · +20 email set up · +20 no real website yet ·
+10 basic builder site (upgrade lead) · +10 contact found · +5 owner company visible · −5 long name / digits / many hyphens · −10 redirects.
**70+ = hot.** "Need a website" = email set up but no real site: the best web-design leads.

**Filters**: found within (7/14/30/60 days), niche, US state, website status chips, *Email set up*, *Has phone/email*, minimum score, search, sort.

**My pipeline (CRM)**
- Set a **Status** on any row (*New → Contacted → Replied → Meeting → Won / Lost*) and a **Follow-up** date.
- **Details** opens everything about the lead, plus a **Note**.
- **My pipeline** shows tracked leads with status counters (click a counter to filter). **Follow-ups due** shows today's and overdue follow-ups.
- **Export CSV** includes website, contacts, owner, status, follow-up and notes (up to 5,000 rows).

> New domains can be unsafe. Don't download anything from them, and follow anti-spam rules (CAN-SPAM, GDPR) when you contact people.

### Gap Finder (inside Leads)
Name ideas like `dallasroofing.com`, `roofingdallas.com`, `dallasroofingpros.com` for the niche + city markets with the most new
registrations in the last 30 days, checked against the `.com` registry. Filter by niche, state or minimum demand, then
**Check & register** (opens Namecheap) or **Competition** (Google search). Always confirm availability at a registrar before buying.

---

## Research

**Momentum**: every niche with this period vs the previous one (7 or 30 days), measured as average per day so missing days don't distort it.
Sort by *Growth*, *Volume* or *A–Z*. Each row has a daily trend line. Click a niche for its full history chart.
Growing niches = more new businesses (customers for websites and leads), but also more competition.

**Geography**: US state map (darker = more new service businesses). Click a state to see its cities and top niches.
Switch between *Cities*, *States* and *Outside US*, with change vs the previous period. Only names containing a city or state are counted.

---

## Daily Files

Every stored day: chart, file list, the full domain list with *Contains / Starts with / Ends with / Regex* search,
extension filter, **Download .txt** (what you filtered) and **Original .zip**.
