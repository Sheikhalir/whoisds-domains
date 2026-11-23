#!/usr/bin/env python3
"""End-to-end browser test of the dashboard against dev/mock_supabase.py.

Needs: playwright (pip install playwright && playwright install chromium), the mock server
running with data from the daily job (dev/run_local.sh does all of this).
Local copies of supabase-js and JSZip are served instead of the CDN (set SUPABASE_JS / JSZIP_JS).

    python dev/e2e_test.py --base http://localhost:8800 --shots /tmp/shots
"""
import argparse
import asyncio
import os
import sys

from playwright.async_api import async_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8800")
ap.add_argument("--shots", default="/tmp/shots")
ap.add_argument("--owner", default="owner@test.com")
ap.add_argument("--password", default="pass1234")
A = ap.parse_args()
os.makedirs(A.shots, exist_ok=True)
SB = open(os.environ.get("SUPABASE_JS", "/tmp/sbjs/node_modules/@supabase/supabase-js/dist/umd/supabase.js")).read()
JZ = open(os.environ.get("JSZIP_JS", "/opt/npm-tools/node_modules/jszip/dist/jszip.min.js")).read()
fails, errors = 0, []


def check(name, ok, info=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"   -> {info}"), flush=True)
    fails += 0 if ok else 1


async def new_page(browser, w=1360, h=1000, dark=False):
    ctx = await browser.new_context(viewport={"width": w, "height": h}, accept_downloads=True, color_scheme="dark" if dark else "light")
    await ctx.grant_permissions(["clipboard-read", "clipboard-write"])
    await ctx.add_init_script("try { localStorage.setItem('dr_no_tour', '1') } catch (e) {}")   # the welcome tour is tested separately
    pg = await ctx.new_page()
    await pg.route("**/supabase.js", lambda r: r.fulfill(body=SB, content_type="application/javascript"))
    await pg.route("**/jszip.min.js", lambda r: r.fulfill(body=JZ, content_type="application/javascript"))
    pg.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    pg.on("console", lambda m: m.type == "error" and "status of 400" not in m.text and "status of 401" not in m.text and "status of 500" not in m.text and errors.append(m.text))
    return pg


async def login(pg, email, pw, expect=".topbar"):
    await pg.goto(A.base + "/")
    await pg.wait_for_selector(".auth-card", timeout=15000)
    await pg.fill("input[name=email]", email)
    await pg.fill("input[name=password]", pw)
    await pg.click("button[type=submit]")
    await pg.wait_for_selector(expect, timeout=20000)


async def signup(pg, email, pw, name="Test Person", expect=".topbar"):
    await pg.goto(A.base + "/#signup?email=" + email)
    await pg.wait_for_selector("input[name=password2]", timeout=15000)
    await pg.fill("input[name=name]", name)
    await pg.fill("input[name=password]", pw)
    await pg.fill("input[name=password2]", pw)
    await pg.click("button[type=submit]")
    await pg.wait_for_selector(expect, timeout=20000)


async def tab(pg, name):
    await pg.click(f".tabs button[data-tab={name}]")
    await pg.wait_for_timeout(400)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # ---------------- admin ----------------
        adm = await new_page(b)
        await login(adm, A.owner, A.password)
        tabs = await adm.eval_on_selector_all(".tabs button", "bs=>bs.map(b=>b.textContent)")
        check("admin sees all 6 tabs", tabs == ["Niche Finder", "Leads", "Research", "Daily Files", "Guide", "Admin"], tabs)
        await tab(adm, "admin")
        await adm.wait_for_selector("#ad-body .tiles", timeout=20000)
        await adm.wait_for_timeout(600)
        await adm.screenshot(path=f"{A.shots}/admin_overview.png", full_page=True)
        check("admin overview tiles", "Users" in await adm.inner_text("#ad-body .tiles"))
        # invite
        await adm.click("#ad-sub button:has-text('Invites')")
        await adm.wait_for_selector("textarea", timeout=10000)
        await adm.fill("textarea", "invited1@test.com, invited2@test.com")
        await adm.select_option("form select >> nth=1", "30")
        await adm.click("button:has-text('Send invites')")
        await adm.wait_for_selector("td:has-text('invited1@test.com')", timeout=10000)
        check("admin invites two emails", await adm.locator("td:has-text('invited2@test.com')").count() == 1)
        await adm.screenshot(path=f"{A.shots}/admin_invites.png", full_page=True)

        # ---------------- invited user: instant access ----------------
        inv = await new_page(b)
        await signup(inv, "invited1@test.com", "secret123", "Invited One")
        check("invited user gets in immediately", await inv.locator(".tabs button[data-tab=admin]").count() == 0)

        # ---------------- request access: pending -> approved ----------------
        req = await new_page(b)
        await signup(req, "requester@test.com", "secret123", "Req Uester", expect="h1:has-text('Waiting for approval')")
        check("non-invited sign-up waits for approval", True)
        await req.screenshot(path=f"{A.shots}/waiting.png")
        await adm.click("#ad-sub button:has-text('Users')")
        await adm.wait_for_selector("td:has-text('requester@test.com')", timeout=10000)
        await adm.screenshot(path=f"{A.shots}/admin_users.png", full_page=True)
        row = adm.locator("tr", has=adm.locator("text=requester@test.com"))
        await row.locator("button:has-text('Approve')").click()
        await adm.wait_for_selector("dialog[open] select", timeout=5000)
        await adm.select_option("dialog[open] select >> nth=1", "30")
        await adm.click("dialog[open] button[type=submit]")
        await adm.wait_for_timeout(800)
        await req.click("button:has-text('Check again')")
        await req.wait_for_selector(".topbar", timeout=15000)
        check("approved user gets in after 'Check again'", True)

        # ---------------- Leads ----------------
        await tab(req, "leads")
        await req.wait_for_selector("#ld-table table", timeout=20000)
        tiles = await req.inner_text("#ld-tiles")
        check("leads load with tiles", "Hot leads" in tiles, tiles)
        await req.click("#ld-states button[data-st=no_site]")
        await req.wait_for_timeout(700)
        states = await req.eval_on_selector_all("#ld-table tbody tr td:nth-child(6)", "ts=>[...new Set(ts.map(t=>t.innerText.split('\\n')[0]))]")
        check("website filter: only 'No website'", states == ["No website"], states)
        await req.click("#ld-states button[data-st=no_site]")
        await req.wait_for_timeout(700)
        first = req.locator("#ld-table tbody tr").first
        dom = (await first.locator("td:nth-child(3) .domain").inner_text()).strip()
        await first.locator(".icon.star").click()
        await first.locator("select.crm").select_option("contacted")
        await req.wait_for_timeout(500)
        await first.locator("button:has-text('Details')").click()
        await req.wait_for_selector("dialog.drawer[open]", timeout=5000)
        await req.fill("dialog.drawer textarea", "Called, wants a quote")
        await req.fill("dialog.drawer input[type=date]", "2020-01-01")
        await req.screenshot(path=f"{A.shots}/lead_details.png")
        await req.click("dialog.drawer button:has-text('Save')")
        await req.wait_for_timeout(800)
        await req.click("#ld-sub button:has-text('My pipeline')")
        await req.wait_for_selector("#ld-kanban", timeout=10000)
        await req.wait_for_timeout(800)
        k = await req.inner_text("#ld-kanban")
        check("pipeline shows the contacted lead", dom in await req.inner_text("#ld-table") and "Contacted" in k, (dom, k))
        await req.screenshot(path=f"{A.shots}/pipeline.png", full_page=True)
        await req.click("#ld-sub button:has-text('Follow-ups due')")
        await req.wait_for_timeout(900)
        check("follow-ups due lists the overdue lead", dom in await req.inner_text("#ld-table"))
        await req.click("#ld-sub button:has-text('All leads')")
        await req.wait_for_selector("#ld-table table", timeout=10000)
        await req.screenshot(path=f"{A.shots}/leads.png", full_page=False)
        async with req.expect_download() as dl:
            await req.click("#ld-csv")
        d = await dl.value
        lines = open(await d.path(), encoding="utf-8-sig").read().splitlines()
        check("leads CSV export", lines[0].startswith("domain,score,found_date") and len(lines) > 10, (lines[:1], len(lines)))
        # gap finder
        await req.click("#ld-sub button:has-text('Gap Finder')")
        await req.wait_for_selector("#gp-table table", timeout=10000)
        check("gap finder lists available names", "Available" in await req.inner_text("#gp-table"))
        await req.screenshot(path=f"{A.shots}/gap_finder.png", full_page=False)
        # niche finder sees the favorite
        await tab(req, "niche")
        await req.wait_for_function("document.querySelector('#nf-views')?.textContent.includes('Favorites (1)')", timeout=20000)
        check("favorite from Leads shows in Niche Finder", True)

        # ---------------- Research ----------------
        await tab(req, "research")
        await req.wait_for_selector("#rs-body table", timeout=20000)
        await req.wait_for_timeout(600)
        check("momentum table", await req.locator("#rs-body tbody tr").count() > 10)
        await req.screenshot(path=f"{A.shots}/momentum.png", full_page=True)
        await req.click("#rs-sub button:has-text('Geography')")
        await req.wait_for_selector("#geo-map .t", timeout=20000)
        await req.wait_for_selector("#geo-table table", timeout=20000)
        await req.click("#geo-map .t:has-text('TX')")
        await req.wait_for_timeout(500)
        title = await req.inner_text("#geo-map-title")
        cities = await req.eval_on_selector_all("#geo-table tbody tr td:nth-child(2)", "ts=>ts.map(t=>t.textContent)")
        check("geography: click Texas filters to Texas cities", title.startswith("Texas") and cities and all(c.endswith("TX") or "TX/" in c for c in cities), (title, cities[:5]))
        await req.screenshot(path=f"{A.shots}/geography.png", full_page=True)

        # ---------------- admin: password reset forces change ----------------
        await adm.click("#ad-sub button:has-text('Users')")
        await adm.wait_for_selector("td:has-text('invited1@test.com')", timeout=10000)
        row = adm.locator("tr", has=adm.locator("text=invited1@test.com"))
        await row.locator("button:has-text('Password')").click()
        await adm.wait_for_selector("dialog[open] input[type=text]")
        await adm.fill("dialog[open] input[type=text]", "TempPass123")
        await adm.click("dialog[open] button[type=submit]")
        await adm.wait_for_selector("dialog[open] h2:has-text('Temporary password set')", timeout=5000)
        await adm.click("dialog[open] button:has-text('Done')")
        u2 = await new_page(b)
        await login(u2, "invited1@test.com", "TempPass123", expect="h1:has-text('Choose a new password')")
        check("temporary password forces a new password", True)
        pw = u2.locator("input[type=password]")
        await pw.nth(0).fill("MyOwnPass99"); await pw.nth(1).fill("MyOwnPass99")
        await u2.click("button[type=submit]")
        await u2.wait_for_selector(".topbar", timeout=15000)
        check("after choosing a password the user is in", True)

        # ---------------- admin: disable -> blocked ----------------
        await adm.click("#ad-sub button:has-text('Users')")
        await adm.wait_for_selector("td:has-text('invited1@test.com')", timeout=10000)
        row = adm.locator("tr", has=adm.locator("text=invited1@test.com"))
        await row.locator("button:has-text('Disable')").click()
        await adm.wait_for_timeout(800)
        await u2.reload()
        await u2.wait_for_selector("h1:has-text('disabled')", timeout=15000)
        check("disabled user is blocked on reload", True)
        await u2.screenshot(path=f"{A.shots}/blocked.png")

        # ---------------- admin: invite-only mode ----------------
        await adm.click("#ad-sub button:has-text('Settings')")
        await adm.wait_for_selector("input[type=checkbox]", timeout=10000)
        await adm.uncheck("#ad-body input[type=checkbox]")
        await adm.click("button:has-text('Save settings')")
        await adm.wait_for_timeout(600)
        s = await new_page(b)
        await s.goto(A.base + "/#signup?email=stranger@test.com")
        await s.wait_for_selector("input[name=password2]", timeout=15000)
        await s.fill("input[name=password]", "secret123"); await s.fill("input[name=password2]", "secret123")
        await s.click("button[type=submit]")
        await s.wait_for_selector(".msg-box.err:not([hidden])", timeout=10000)
        check("invite-only mode refuses strangers", "invite-only" in (await s.inner_text(".msg-box.err")).lower(), await s.inner_text(".msg-box.err"))
        await adm.check("#ad-body input[type=checkbox]")
        await adm.click("button:has-text('Save settings')")

        # ---------------- admin activity + data ----------------
        await adm.click("#ad-sub button:has-text('Activity log')")
        await adm.wait_for_selector("#ad-body table", timeout=10000)
        acts = await adm.inner_text("#ad-body table")
        check("activity log records sign-ins and exports", "Signed in" in acts and "Exported CSV" in acts, acts[:300])
        await adm.screenshot(path=f"{A.shots}/admin_activity.png")
        await adm.click("#ad-sub button:has-text('Data & jobs')")
        await adm.wait_for_selector("#ad-body table", timeout=10000)
        check("job runs listed", "ok" in await adm.inner_text("#ad-body table"))
        await adm.click("#ad-sub button:has-text('Overview')")
        await adm.wait_for_selector("#ad-body .tiles", timeout=10000)
        await adm.wait_for_timeout(600)
        await adm.screenshot(path=f"{A.shots}/admin_overview2.png", full_page=True)

        # ---------------- dark mode + mobile smoke ----------------
        m = await new_page(b, 390, 860, dark=True)
        await login(m, "requester@test.com", "secret123")
        await tab(m, "leads")
        await m.wait_for_selector("#ld-table table", timeout=20000)
        await m.screenshot(path=f"{A.shots}/mobile_dark_leads.png")
        check("mobile + dark mode renders", True)

        await b.close()
    real = [e for e in errors if "favicon" not in e]
    check("no JavaScript errors", not real, real[:6])
    print("\n" + ("ALL PASSED" if not fails else f"{fails} FAILED"))
    sys.exit(1 if fails else 0)


asyncio.run(main())
