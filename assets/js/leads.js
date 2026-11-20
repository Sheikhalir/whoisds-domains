// LEADS tab: lead list with score, website status ("did they launch?"), email setup, contacts,
// owner info; CRM pipeline (status / follow-up / note); follow-ups due; Gap Finder.
import { el, $, $$, fmt, prettyDate, shortDate, dateTime, ago, debounce, isoDay, addDays, tile, seg, subtabs, multiSelect, csv, download, copyText,
         toast, errText, openDialog, whoisLink, scoreBadge, stateBadge, SITE_STATES, CRM, US, store, bus, highlight } from "./core.js";
import { rpc, Lists, logEvent } from "./api.js";

const LIMIT = 100;

export function mount(host, ctx) {
  const meta = ctx.meta;
  const S = Object.assign({ sub: "leads", range: 30, niches: [], us: "", states: [], mx: false, contact: false, min: 0, q: "", sort: "score", crm: [],
                            gNiches: [], gUs: "", gStatus: "available", gMin: 3 }, store.get("dr_leads", {}));
  S.page = 0;
  const save = () => { const { page, ...rest } = S; store.set("dr_leads", rest); };
  let res = null, token = 0, gaps = [];

  const nicheGroups = () => {
    const groups = [];
    for (const n of ctx.cfg.niches) { let g = groups.find(x => x.name === n.group); if (!g) groups.push(g = { name: n.group, items: [] }); g.items.push([n.id, n.name]); }
    groups.unshift({ name: "Seeds", items: [["seed", "Matches a seed keyword"]] });
    return groups;
  };
  const usOptions = (cur, all = "All states") => [el("option", { value: "" }, all), ...Object.entries(US).sort((a, b) => a[1].localeCompare(b[1])).map(([c, n]) => el("option", { value: c, selected: c === cur }, n))];

  host.replaceChildren(el("div", { id: "ld-sub" }), el("div", { id: "ld-body" }));

  function drawSub() {
    $("#ld-sub", host).replaceChildren(subtabs([
      ["leads", "All leads", res && S.sub === "leads" ? res.total : null],
      ["pipeline", "My pipeline", res ? Object.values(res.crm || {}).reduce((a, b) => a + b, 0) : null],
      ["followups", "Follow-ups due", res ? res.followups_due : null],
      ["gaps", "Gap Finder"]], S.sub, v => { S.sub = v; S.page = 0; save(); build(); logEvent("view", { tab: "leads:" + v }); }));
  }

  function build() {
    drawSub();
    if (S.sub === "gaps") return buildGaps();
    const body = $("#ld-body", host);
    const stateOrder = ["no_site", "parked", "coming_soon", "placeholder", "error", "live", "redirect", "unchecked"];
    body.replaceChildren(
      el("div", { class: "card", style: { marginBottom: "12px" } },
        el("div", { class: "filters", style: { marginBottom: "10px" } },
          S.sub === "leads" ? seg([[7, "7 days"], [14, "14 days"], [30, "30 days"], [60, "60 days"], [0, "All"]], S.range, v => { S.range = v; S.page = 0; save(); build(); }) : null,
          multiSelect({ label: "Niche", groups: nicheGroups(), selected: S.niches, onChange: v => { S.niches = v; S.page = 0; save(); query(); } }),
          el("select", { "aria-label": "US state", onchange: e => { S.us = e.target.value; S.page = 0; save(); query(); } }, ...usOptions(S.us)),
          el("label", { class: "toggle" }, el("input", { type: "checkbox", checked: S.mx, onchange: e => { S.mx = e.target.checked; S.page = 0; save(); query(); } }), "Email set up"),
          el("label", { class: "toggle" }, el("input", { type: "checkbox", checked: S.contact, onchange: e => { S.contact = e.target.checked; S.page = 0; save(); query(); } }), "Has phone/email"),
          el("div", { class: "range" }, "Min score", el("input", { type: "range", min: 0, max: 100, step: 5, value: S.min,
              oninput: e => { e.target.nextSibling.textContent = e.target.value; }, onchange: e => { S.min = +e.target.value; S.page = 0; save(); query(); } }), el("b", { class: "num" }, S.min)),
          el("div", { style: { flex: 1, minWidth: "180px" } }, el("input", { type: "search", placeholder: "Search domain, title, city…", value: S.q,
              oninput: debounce(e => { S.q = e.target.value.trim(); S.page = 0; save(); query(); }, 250) })),
          el("label", {}, "Sort", el("select", { onchange: e => { S.sort = e.target.value; save(); query(); } },
            ...[["score", "Best score"], ["found", "Newest"], ["followup", "Follow-up date"], ["updated", "Recently updated"]].map(([v, t]) => el("option", { value: v, selected: v === S.sort }, t))))),
        el("div", { class: "pills", id: "ld-states" }, ...stateOrder.map(st => el("button", { "data-st": st, "aria-pressed": String(S.states.includes(st)),
          onclick: () => { S.states = S.states.includes(st) ? S.states.filter(x => x !== st) : [...S.states, st]; S.page = 0; save(); query(); } }, SITE_STATES[st][0], el("span", { class: "n" })))),
        el("div", { class: "hint", style: { marginTop: "8px" } }, "Website status comes from automatic checks on the day a domain appears, then after 7, 14 and 30 days. Leads you track (★ or a status) are re-checked every 14 days.")),
      S.sub === "pipeline" ? el("div", { class: "kanban", id: "ld-kanban" }) : null,
      el("div", { class: "tiles five", id: "ld-tiles" }),
      el("section", { class: "card" },
        el("div", { class: "card-head" }, el("div", {}, el("h2", { id: "ld-title" }), el("div", { class: "sub", id: "ld-subtitle" })),
          el("div", { class: "controls" },
            el("button", { class: "btn", id: "ld-copy", onclick: e => res && copyText(e.currentTarget, res.rows.map(r => r.domain).join("\n"), res.rows.length) }, "Copy page"),
            el("button", { class: "btn primary", id: "ld-csv", onclick: exportCsv }, "Export CSV"))),
        el("div", { id: "ld-table" })));
    query();
  }

  function params(extra = {}) {
    const p = { view: S.sub === "leads" ? "all" : S.sub, niches: S.niches, us_state: S.us || null, site_states: S.states, min_score: S.min,
                has_mx: S.mx ? true : null, has_contact: S.contact ? true : null, q: S.q || null, sort: S.sub === "followups" ? "followup" : S.sort,
                statuses: S.sub === "pipeline" ? S.crm : [], limit: LIMIT, offset: S.page * LIMIT, ...extra };
    if (S.range && S.sub === "leads") p.from = addDays(isoDay(), -S.range);
    return p;
  }

  async function query() {
    const t = ++token;
    const tbl = $("#ld-table", host); if (!tbl) return;
    tbl.replaceChildren(el("div", { class: "msg" }, "Loading leads…"));
    try {
      const r = await rpc("search_leads", { p: params() });
      if (t !== token) return;
      res = r; draw();
    } catch (e) { tbl.replaceChildren(el("div", { class: "msg err" }, "Couldn't load leads: " + errText(e))); }
  }

  function draw() {
    drawSub();
    $$("#ld-states button", host).forEach(b => { b.querySelector(".n").textContent = fmt(res.by_state?.[b.dataset.st] || 0); b.setAttribute("aria-pressed", String(S.states.includes(b.dataset.st))); });
    if (S.sub === "pipeline") {
      const k = $("#ld-kanban", host);
      k.replaceChildren(...[...CRM, ["none", "★ No status yet"]].map(([v, t]) => el("button", { "aria-pressed": String(S.crm.includes(v)),
        onclick: () => { S.crm = S.crm.includes(v) ? S.crm.filter(x => x !== v) : [...S.crm, v]; S.page = 0; save(); query(); } },
        el("div", { class: "k-n" }, fmt(res.crm?.[v] || 0)), el("div", { class: "k-l" }, t))));
    }
    $("#ld-tiles", host).replaceChildren(
      tile(S.sub === "pipeline" ? "Tracked leads" : S.sub === "followups" ? "Follow-ups due" : "Leads", fmt(res.total), S.sub === "leads" ? (S.range ? "found in the last " + S.range + " days" : "all stored leads") : "matching filters"),
      tile("Hot leads (70+)", fmt(res.hot), "high score"),
      tile("Need a website", fmt(res.need_site), "email set up, no real site yet"),
      tile("With phone or email", fmt(res.with_contact), "found on their site"),
      tile("Follow-ups due", fmt(res.followups_due), "today or overdue"));
    $("#ld-title", host).textContent = S.sub === "pipeline" ? "My pipeline" : S.sub === "followups" ? "Follow-ups due" : "Leads";
    $("#ld-subtitle", host).textContent = fmt(res.total) + " leads" + (S.niches.length ? " · " + S.niches.map(n => meta.get(n)?.name || n).join(", ") : "") + (S.us ? " · " + US[S.us] : "");
    const tb = el("tbody");
    for (const r of res.rows) tb.append(row(r));
    const pages = Math.max(1, Math.ceil(res.total / LIMIT));
    $("#ld-table", host).replaceChildren(
      res.rows.length ? el("div", { class: "tbl-wrap", style: { maxHeight: "680px" } }, el("table", { class: "data" },
        el("thead", {}, el("tr", {}, el("th", { class: "act" }), el("th", {}, "Score"), el("th", {}, "Domain"), el("th", {}, "Niche"), el("th", {}, "Location"),
          el("th", {}, "Website"), el("th", {}, "Email"), el("th", {}, "Contact"), el("th", {}, "Status"), el("th", {}, "Follow-up"), el("th"))), tb))
        : el("div", { class: "empty" }, S.sub === "pipeline" ? "Nothing in your pipeline yet. Click ☆ on a lead or give it a status." :
                                       S.sub === "followups" ? "No follow-ups due. Set a follow-up date on a lead to see it here." :
                                       "No leads match. Leads appear after the daily job checks new niche domains (main extensions: .com .net .org .co .us …)."),
      res.rows.length ? el("div", { class: "pager" },
        el("span", { class: "sub num" }, "Showing " + fmt(S.page * LIMIT + 1) + "–" + fmt(S.page * LIMIT + res.rows.length) + " of " + fmt(res.total)),
        el("div", { class: "controls" },
          el("button", { class: "btn", disabled: S.page === 0, onclick: () => { S.page--; query(); } }, "‹"),
          el("span", { class: "sub num" }, "Page " + fmt(S.page + 1) + " of " + fmt(pages)),
          el("button", { class: "btn", disabled: S.page >= pages - 1, onclick: () => { S.page++; query(); } }, "›"))) : null);
  }

  const metaOf = r => ({ found_date: r.found_date, niche_ids: r.niche_ids, kws: r.kws, loc: r.loc });
  async function setMine(r, patch, quietToast) {
    try { await Lists.set([r.domain], patch, metaOf(r)); Object.assign(r, patch); if (!quietToast) toast("Saved"); return true; }
    catch (e) { toast(errText(e)); return false; }
  }
  const contactCell = r => el("td", { class: "contact" },
    ...(r.phones || []).slice(0, 1).map(p => el("a", { href: "tel:" + p }, "📞 " + p.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3"))),
    ...(r.emails || []).slice(0, 1).map(m => el("a", { href: "mailto:" + m }, "✉ " + m)),
    (r.socials || []).length ? el("span", { class: "muted", style: { fontSize: "11px" } }, r.socials.map(s => s.match(/\/\/(?:www\.|m\.)?([a-z]+)/)?.[1]).filter(Boolean).join(" · ")) : null,
    !(r.phones || []).length && !(r.emails || []).length && !(r.socials || []).length ? el("span", { class: "no" }, "–") : null);

  function row(r) {
    const fav = Lists.isFav(r.domain);
    const star = el("button", { class: "icon star" + (fav ? " on" : ""), title: "Favorite", onclick: async e => {
      e.stopPropagation(); const on = !Lists.isFav(r.domain);
      if (await setMine(r, { fav: on }, true)) { star.classList.toggle("on", on); star.textContent = on ? "★" : "☆"; } } }, fav ? "★" : "☆");
    const status = el("select", { class: "crm", onclick: e => e.stopPropagation(), onchange: e => setMine(r, { status: e.target.value || null }, true) },
      el("option", { value: "" }, "—"), ...CRM.map(([v, t]) => el("option", { value: v, selected: r.status === v }, t)));
    const fu = el("input", { type: "date", value: r.follow_up || "", onclick: e => e.stopPropagation(), onchange: e => setMine(r, { follow_up: e.target.value || null }, true) });
    const overdue = r.follow_up && r.follow_up <= isoDay();
    return el("tr", { class: "click", onclick: () => details(r) },
      el("td", { class: "act" }, star),
      el("td", { title: (r.score_reasons || []).join("\n") }, scoreBadge(r.score)),
      el("td", {}, el("div", {}, highlight(r.domain, r.kws)), el("div", { class: "muted", style: { fontSize: "11px" } }, "found " + shortDate(r.found_date))),
      el("td", {}, ...(r.niche_ids || []).filter(i => i !== "generic").slice(0, 2).map(id => el("span", { class: "chip" + (id === "seed" ? " seed" : "") }, meta.get(id)?.name || id))),
      el("td", { class: "sub" }, r.loc || el("span", { class: "no" }, "–")),
      el("td", {}, stateBadge(r.site_state, r.builder), r.title && r.site_state === "live" ? el("div", { class: "muted", style: { fontSize: "11px", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, r.title) : null),
      el("td", {}, r.has_mx ? el("span", { class: "yes", title: r.mx_provider || "" }, "✓ " + (r.mx_provider || "yes")) : r.has_mx === false ? el("span", { class: "no" }, "none") : el("span", { class: "no" }, "?")),
      contactCell(r),
      el("td", {}, status),
      el("td", { style: overdue ? { boxShadow: "inset 3px 0 0 var(--warn)" } : null }, fu),
      el("td", { class: "r" }, el("button", { class: "btn small", onclick: e => { e.stopPropagation(); details(r); } }, "Details")));
  }

  function details(r) {
    logEvent("lead_open", { domain: r.domain });
    openDialog(close => {
      const note = el("textarea", { class: "input", rows: 4, placeholder: "Notes: who you spoke to, what they need, prices quoted…" }); note.value = r.note || "";
      const status = el("select", {}, el("option", { value: "" }, "— no status —"), ...CRM.map(([v, t]) => el("option", { value: v, selected: r.status === v }, t)));
      const fu = el("input", { type: "date", value: r.follow_up || "" });
      const kv = pairs => el("dl", { class: "kv" }, ...pairs.filter(Boolean).flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v ?? el("span", { class: "no" }, "–"))]));
      const link = (u, t) => el("a", { href: u, target: "_blank", rel: "noopener noreferrer nofollow" }, t || u);
      return el("div", { class: "dlg" },
        el("div", { class: "card-head", style: { marginBottom: 0 } },
          el("div", {}, el("h2", { style: { fontSize: "19px" } }, r.domain), el("div", { class: "sub" }, "Found " + prettyDate(r.found_date) + (r.loc ? " · " + r.loc : ""))),
          el("div", { class: "controls" }, scoreBadge(r.score), el("button", { class: "btn small", onclick: close }, "Close"))),
        el("div", { class: "section-h" }, "Why this score"),
        el("ul", { class: "reasons" }, ...(r.score_reasons || []).map(x => el("li", {}, x)), !(r.score_reasons || []).length ? el("li", {}, "Not checked yet") : null),
        el("div", { class: "section-h" }, "Website"),
        kv([["Status", stateBadge(r.site_state, r.builder)], ["Builder", r.builder], ["Page title", r.title], ["HTTP", r.http_status],
            r.final_url ? ["Address", el("span", {}, link(r.final_url), el("div", { class: "hint" }, "New domains can be unsafe. Don't download anything from them."))] : null,
            ["History", (r.history || []).length ? el("div", { class: "timeline" }, ...r.history.map(h => el("span", { class: "badge" }, shortDate(h.at) + ": " + (SITE_STATES[h.state]?.[0] || h.state) + (h.mx ? " · email" : "")))) : null],
            ["Checks", (r.checks || 0) + " so far · last " + ago(r.last_checked_at) + (r.next_check_at ? " · next " + shortDate(r.next_check_at) : "")]]),
        el("div", { class: "section-h" }, "Contact"),
        kv([["Phone", (r.phones || []).length ? el("div", {}, ...r.phones.map(p => el("div", {}, el("a", { href: "tel:" + p }, p)))) : null],
            ["Email", (r.emails || []).length ? el("div", {}, ...r.emails.map(m => el("div", {}, el("a", { href: "mailto:" + m }, m)))) : null],
            ["Social", (r.socials || []).length ? el("div", {}, ...r.socials.map(s => el("div", {}, link(s)))) : null],
            ["Email set up", r.has_mx ? "Yes" + (r.mx_provider ? " (" + r.mx_provider + ")" : "") : r.has_mx === false ? "No MX records" : null]]),
        el("div", { class: "section-h" }, "Owner (public registration data)"),
        kv([["Registrar", r.registrar], ["Company", r.registrant_org], ["State / region", r.registrant_state], ["Country", r.registrant_country],
            ["Lookup", el("span", {}, whoisLink(r.domain), r.rdap_checked_at ? el("span", { class: "muted" }, " · checked " + ago(r.rdap_checked_at)) : null)]]),
        el("div", { class: "section-h" }, "Niche"),
        kv([["Niches", el("div", {}, ...(r.niche_ids || []).map(id => el("span", { class: "chip" }, meta.get(id)?.name || id)))], ["Keywords", (r.kws || []).join(", ")]]),
        el("div", { class: "section-h" }, "My pipeline"),
        el("div", { class: "form-grid" }, el("label", { class: "field" }, "Status", status), el("label", { class: "field" }, "Follow-up date", fu),
          el("label", { class: "field full" }, "Note", note)),
        el("div", { class: "dlg-actions" },
          el("button", { class: "btn", onclick: async () => { if (await setMine(r, { discarded: true }, true)) { close(); toast("Discarded " + r.domain); query(); } } }, "Discard"),
          el("button", { class: "btn", onclick: async e => { const on = !Lists.isFav(r.domain); if (await setMine(r, { fav: on }, true)) e.target.textContent = on ? "★ Favorited" : "☆ Favorite"; } },
            Lists.isFav(r.domain) ? "★ Favorited" : "☆ Favorite"),
          el("span", { style: { flex: 1 } }),
          el("button", { class: "btn primary", onclick: async () => {
            if (await setMine(r, { status: status.value || null, follow_up: fu.value || null, note: note.value.trim() || null })) { close(); query(); }
          } }, "Save")));
    }, { drawer: true });
  }

  async function exportCsv() {
    const btn = $("#ld-csv", host); btn.disabled = true; btn.textContent = "Exporting…";
    try {
      const all = [];
      for (let off = 0; off < 5000; off += 500) {
        const r = await rpc("search_leads", { p: params({ limit: 500, offset: off }) });
        all.push(...r.rows); if (r.rows.length < 500) break;
      }
      download("leads_" + S.sub + "_" + isoDay() + ".csv", csv(
        ["domain", "score", "found_date", "niches", "location", "us_state", "website_status", "builder", "page_title", "website_url", "email_set_up", "email_provider",
         "phones", "emails", "socials", "registrar", "owner_company", "owner_state", "owner_country", "favorite", "status", "follow_up", "note", "score_reasons"],
        all.map(r => [r.domain, r.score, r.found_date, (r.niche_ids || []).map(i => meta.get(i)?.name || i), r.loc, r.us_state, SITE_STATES[r.site_state]?.[0] || r.site_state,
                      r.builder, r.title, r.final_url, r.has_mx ? "yes" : r.has_mx === false ? "no" : "", r.mx_provider, r.phones, r.emails, r.socials, r.registrar,
                      r.registrant_org, r.registrant_state, r.registrant_country, r.fav ? "yes" : "", r.status, r.follow_up, r.note, r.score_reasons])), "text/csv");
      logEvent("export_csv", { tab: "leads", rows: all.length });
      toast("Exported " + fmt(all.length) + " leads" + (all.length >= 5000 ? " (first 5,000)" : ""));
    } catch (e) { toast(errText(e)); }
    btn.disabled = false; btn.textContent = "Export CSV";
  }

  // ---------------- Gap Finder ----------------
  function buildGaps() {
    const body = $("#ld-body", host);
    const groups = [{ name: "", items: ctx.cfg.niches.filter(n => n.gap_terms).map(n => [n.id, n.name]) }];
    body.replaceChildren(
      el("div", { class: "card", style: { marginBottom: "12px" } },
        el("p", { class: "sub", style: { marginTop: 0 } }, "Exact-match .com names that are ", el("b", {}, "still unregistered"),
          " in markets where many new businesses are appearing. Demand = new domains registered in that niche + city over the last 30 days."),
        el("div", { class: "filters", style: { marginBottom: 0 } },
          multiSelect({ label: "Niche", groups, selected: S.gNiches, onChange: v => { S.gNiches = v; save(); loadGaps(); } }),
          el("select", { onchange: e => { S.gUs = e.target.value; save(); loadGaps(); } }, ...usOptions(S.gUs)),
          seg([["available", "Available"], ["all", "All checked"]], S.gStatus, v => { S.gStatus = v; save(); buildGaps(); }),
          el("label", {}, "Min demand", el("input", { type: "number", min: 1, value: S.gMin, style: { width: "70px" }, onchange: e => { S.gMin = Math.max(1, +e.target.value || 1); save(); loadGaps(); } })),
          el("span", { style: { flex: 1 } }),
          el("button", { class: "btn", onclick: e => copyText(e.currentTarget, gaps.filter(g => g.status === "available").map(g => g.domain).join("\n")) }, "Copy available"),
          el("button", { class: "btn primary", onclick: exportGaps }, "Export CSV"))),
      el("div", { class: "tiles", id: "gp-tiles" }),
      el("section", { class: "card" }, el("div", { id: "gp-table" })));
    loadGaps();
  }
  async function loadGaps() {
    const box = $("#gp-table", host); if (!box) return;
    box.replaceChildren(el("div", { class: "msg" }, "Loading ideas…"));
    try { gaps = (await rpc("get_gaps", { p: { niches: S.gNiches, us_state: S.gUs || null, status: S.gStatus, min_demand: S.gMin, limit: 500 } })) || []; }
    catch (e) { return box.replaceChildren(el("div", { class: "msg err" }, errText(e))); }
    const avail = gaps.filter(g => g.status === "available");
    const cities = new Set(avail.map(g => g.location));
    const last = gaps.reduce((m, g) => g.checked_at > m ? g.checked_at : m, "");
    $("#gp-tiles", host).replaceChildren(tile("Available names", fmt(avail.length), "matching filters"), tile("Markets", fmt(cities.size), "niche + city pairs with a free name"),
      tile("Top demand", avail[0] ? fmt(avail[0].demand) : "–", avail[0] ? meta.get(avail[0].niche_id)?.name + " · " + avail[0].location : ""),
      tile("Last checked", last ? ago(last) : "–", "re-checked weekly"));
    if (!gaps.length) return box.replaceChildren(el("div", { class: "empty" }, "No ideas yet. The daily job checks about 150 names per run, so the list grows over the first few days."));
    const max = Math.max(...gaps.map(g => g.demand), 1);
    const tb = el("tbody");
    for (const g of gaps) {
      const niche = meta.get(g.niche_id)?.name || g.niche_id, city = g.location.split(",")[0];
      tb.append(el("tr", {},
        el("td", {}, el("b", { class: "domain" }, g.domain)),
        el("td", {}, el("span", { class: "chip" }, niche)),
        el("td", { class: "sub" }, g.location),
        el("td", {}, el("div", { class: "bar-list" }, el("div", { class: "bl", style: { gridTemplateColumns: "1fr 44px" } },
          el("div", { class: "track" }, el("div", { class: "fill", style: { width: (g.demand / max * 100) + "%" } })), el("span", { class: "num cnt" }, fmt(g.demand))))),
        el("td", { class: "muted" }, g.pattern),
        el("td", {}, g.status === "available" ? el("span", { class: "badge ok" }, "✓ Available") : g.status === "taken" ? el("span", { class: "badge" }, "Taken") : el("span", { class: "badge warn" }, "Unknown")),
        el("td", { class: "muted num" }, ago(g.checked_at)),
        el("td", { class: "r" }, el("div", { class: "row-actions" },
          el("a", { class: "btn small", href: "https://www.namecheap.com/domains/registration/results/?domain=" + encodeURIComponent(g.domain), target: "_blank", rel: "noopener noreferrer" }, "Check & register ↗"),
          el("a", { class: "btn small", href: "https://www.google.com/search?q=" + encodeURIComponent(niche.split(/[,&/]/)[0] + " " + city), target: "_blank", rel: "noopener noreferrer", title: "See the competition" }, "Competition ↗")))));
    }
    box.replaceChildren(el("div", { class: "hint", style: { marginBottom: "8px" } }, "Availability comes from the .com registry at check time. Always confirm at a registrar before buying."),
      el("div", { class: "tbl-wrap", style: { maxHeight: "680px" } }, el("table", { class: "data" },
        el("thead", {}, el("tr", {}, el("th", {}, "Name idea"), el("th", {}, "Niche"), el("th", {}, "City"), el("th", { style: { minWidth: "140px" } }, "Demand (30 days)"),
          el("th", {}, "Pattern"), el("th", {}, "Status"), el("th", {}, "Checked"), el("th"))), tb)));
  }
  function exportGaps() {
    download("gap_finder_" + isoDay() + ".csv", csv(["domain", "status", "niche", "location", "us_state", "demand_30d", "pattern", "checked_at"],
      gaps.map(g => [g.domain, g.status, meta.get(g.niche_id)?.name || g.niche_id, g.location, g.us_state, g.demand, g.pattern, g.checked_at])), "text/csv");
    logEvent("export_csv", { tab: "gaps", rows: gaps.length });
  }

  build();
  let shown = false;
  return { show() { if (shown && S.sub !== "gaps") query(); shown = true; }, redraw() {} };
}
