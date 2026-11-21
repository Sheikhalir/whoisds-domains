// NICHE FINDER tab: daily domains sorted into niches, seed keywords, favorites / discards,
// table or by-niche layout, CSV / zip export.
import { el, $, $$, fmt, prettyDate, debounce, eachLimit, highlight, tldOf, labelOf, matchSeed, seedSig, PAGE_SIZE,
         drawBars, tile, seg, csv, download, copyText, safeName, toast, errText, openDialog, whoisLink, bus, store } from "./core.js";
import { rpc, storageFile, dayDomains, Lists, Seeds, logEvent } from "./api.js";

const SCAN_MAX_DAYS = 60;

export function mount(host, ctx) {
  const { days, meta } = ctx;
  const S = Object.assign({ range: 7, day: null, ext: "all", loc: "", q: "", sel: [], view: "results", layout: "table" }, store.get("dr_nf", {}));
  S.sel = new Set(S.sel); S.page = 0;
  if (S.day && !days.some(d => d.date === S.day)) S.day = null;
  const nicheFiles = new Map(), missing = new Set(), scanHits = new Map(), expanded = new Set();
  let quiet = false, rows = [], filtered = [], loadToken = 0, seeds = [], scanIds = new Set(), serverHits = [], restoreArm = false;
  const save = () => store.set("dr_nf", { range: S.range, day: S.day, ext: S.ext, loc: S.loc, q: S.q, sel: [...S.sel], view: S.view, layout: S.layout });
  const rangeDates = () => S.day ? [S.day] : (S.range ? days.slice(-S.range) : days).map(d => d.date);
  const rangeLabel = () => S.day ? prettyDate(S.day) : S.range === 1 ? prettyDate(days[days.length - 1]?.date) : S.range ? "last " + S.range + " days" : "all " + days.length + " days";
  const logNiches = debounce(() => S.sel.size && logEvent("niche_select", { niches: [...S.sel].filter(i => !i.startsWith("seed:")) }), 3000);

  if (!days.length) {
    host.replaceChildren(el("div", { class: "card msg" }, ctx.indexError
      ? "No data yet. The daily job hasn't stored any days in Supabase. Admin: open GitHub → Actions → Daily job → Run workflow, then reload."
      : "No days stored yet."));
    return { show() {} };
  }

  function applySeeds() {
    for (const [id, m] of [...meta]) if (m.group === "My seed keywords" && id !== "seed") meta.delete(id);
    seeds = Seeds.list().map(s => ({ ...s, nid: "seed:" + s.id }));
    seeds.forEach(s => meta.set(s.nid, { name: s.name, group: "My seed keywords" }));
    scanIds = new Set(seeds.filter(s => !Seeds.processed(s)).map(s => s.nid));
  }

  // ---------- layout ----------
  const rangeBtn = (v, t) => el("button", { "data-v": v, onclick: () => { S.range = v; S.day = null; S.page = 0; save(); syncRange(); load(); } }, t);
  host.replaceChildren(
    el("div", { class: "filters" },
      el("div", { class: "seg", id: "nf-range" }, rangeBtn(1, "Latest day"), rangeBtn(7, "7 days"), rangeBtn(30, "30 days"), rangeBtn(0, "All")),
      el("select", { id: "nf-day", "aria-label": "Pick a single day", onchange: e => { S.day = e.target.value || null; S.page = 0; save(); syncRange(); load(); } },
        el("option", { value: "" }, "…or pick a day"), ...days.slice().reverse().map(d => el("option", { value: d.date }, d.date))),
      el("label", {}, "Extension",
        el("select", { id: "nf-ext", onchange: e => { S.ext = e.target.value; S.page = 0; save(); apply(); } },
          el("option", { value: "all" }, "All"), el("option", { value: "com" }, ".com only"), el("option", { value: "main" }, ".com .net .org .co .us"))),
      el("label", {}, "Location", el("select", { id: "nf-loc", onchange: e => { S.loc = e.target.value; S.page = 0; save(); apply(); } })),
      el("div", { style: { flex: 1, minWidth: "200px" } },
        el("input", { type: "search", id: "nf-q", placeholder: "Search within results… e.g. emergency, dallas", value: S.q,
          oninput: debounce(e => { S.q = e.target.value.trim().toLowerCase(); S.page = 0; save(); apply(); }, 150) }))),
    el("div", { id: "nf-warn" }),
    el("div", { class: "tiles", id: "nf-tiles" }),
    el("div", { class: "nf-grid" },
      el("section", { class: "card" },
        el("div", { class: "card-head", style: { marginBottom: "6px" } },
          el("h2", {}, "Niches"),
          el("button", { class: "btn small", id: "nf-clear", onclick: () => { S.sel.clear(); S.page = 0; save(); apply(); } }, "Show all")),
        el("div", { class: "hint", style: { margin: "0 6px 4px" } }, "Click to select one or more niches. Counts follow your filters."),
        el("div", { id: "nf-list", class: "scroll", style: { maxHeight: "66vh", margin: "0 -6px", padding: "0 6px" } }),
        el("div", { id: "nf-progress" })),
      el("section", { class: "card" },
        el("div", { class: "vtabs", id: "nf-views" }),
        el("div", { class: "card-head" },
          el("div", {}, el("h2", { id: "nf-title" }), el("div", { class: "sub num", id: "nf-sub" })),
          el("div", { class: "controls", id: "nf-actions" })),
        el("div", { class: "chart", id: "nf-chart", style: { height: "140px", marginBottom: "12px" } }),
        el("div", { id: "nf-results" }))));
  $("#nf-ext", host).value = S.ext;
  function syncRange() {
    $$("#nf-range button", host).forEach(b => b.setAttribute("aria-pressed", String(!S.day && +b.dataset.v === S.range)));
    $("#nf-day", host).value = S.day || "";
  }
  syncRange();

  // ---------- loading ----------
  async function load() {
    const token = ++loadToken, dates = rangeDates();
    $("#nf-results", host).replaceChildren(el("div", { class: "msg" }, "Loading " + rangeLabel() + "…"));
    try {
      await eachLimit(dates.filter(d => !nicheFiles.has(d)), 6, async d => {
        try { nicheFiles.set(d, (await storageFile("niches/" + d + ".json")).rows); missing.delete(d); }
        catch { nicheFiles.set(d, []); missing.add(d); }
      });
      const processed = seeds.filter(s => !scanIds.has(s.nid));
      serverHits = processed.length ? (await rpc("my_seed_hits", { p_from: dates[0], p_to: dates[dates.length - 1] })) || [] : [];
      if (scanIds.size) await scan(dates, token);
      if (token !== loadToken) return;
      combine(dates); apply();
    } catch (e) {
      $("#nf-results", host).replaceChildren(el("div", { class: "msg err" }, "Couldn't load niche data (" + errText(e) + ")"));
    }
  }

  // seeds the daily job hasn't processed yet are searched here in the browser
  async function scan(dates, token) {
    // the browser search reads the original daily files, which need Daily Files access
    if (ctx.access?.("daily") !== "on") {
      $("#nf-progress", host).replaceChildren(el("div", { class: "hint" }, "New seed keywords are searched by the next daily run (within about 3 hours). Their matches appear here after that."));
      return;
    }
    const todo = seeds.filter(s => scanIds.has(s.nid));
    const scanDates = dates.slice(-SCAN_MAX_DAYS).filter(d => todo.some(s => !scanHits.has(d + "|" + s.nid + "|" + seedSig(s))));
    if (!scanDates.length) return;
    const prog = $("#nf-progress", host), bar = el("div"), label = el("div", { class: "hint" });
    prog.replaceChildren(label, el("div", { class: "progress" }, bar));
    let done = 0;
    await eachLimit(scanDates, 3, async d => {
      if (token !== loadToken) return;
      let list = []; try { list = await dayDomains(d); } catch {}
      for (const s of todo) {
        const key = d + "|" + s.nid + "|" + seedSig(s); if (scanHits.has(key)) continue;
        const hits = [];
        for (const dom of list) { const lab = labelOf(dom), kw = matchSeed(s, lab); if (kw) hits.push({ d: dom, kw, loc: ctx.locate(lab) }); }
        scanHits.set(key, hits);
      }
      done++; label.textContent = "Searching your new seed keywords… " + done + " / " + scanDates.length + " days"; bar.style.width = (done / scanDates.length * 100) + "%";
    });
    prog.replaceChildren(el("div", { class: "hint" }, "New seed keywords were searched in your browser. The next daily run processes them automatically."));
  }

  function combine(dates) {
    rows = [];
    const bySeed = new Map(seeds.map(s => [s.id, s]));
    const hitsByDate = new Map();
    for (const h of serverHits) { const s = bySeed.get(h.seed_id); if (!s) continue; (hitsByDate.get(h.date) || hitsByDate.set(h.date, []).get(h.date)).push([s.nid, h]); }
    for (const date of dates.slice().reverse()) {
      const map = new Map();
      for (const [d, ids, kws, loc] of nicheFiles.get(date) || []) {
        const keep = ids.map((id, i) => [id, kws[i]]).filter(([id]) => meta.has(id));
        if (keep.length) map.set(d, { date, d, ids: keep.map(k => k[0]), kws: keep.map(k => k[1]), loc });
      }
      const add = (nid, dom, kw, loc) => {
        const r = map.get(dom);
        if (r) { if (!r.ids.includes(nid)) { r.ids.push(nid); r.kws.push(kw); } }
        else map.set(dom, { date, d: dom, ids: [nid], kws: [kw], loc: loc || "" });
      };
      for (const [nid, h] of hitsByDate.get(date) || []) add(nid, h.domain, h.kw, h.loc);
      for (const s of seeds) if (scanIds.has(s.nid)) for (const h of scanHits.get(date + "|" + s.nid + "|" + seedSig(s)) || []) add(s.nid, h.d, h.kw, h.loc);
      for (const r of map.values()) rows.push(r);
    }
  }

  // ---------- filtering ----------
  const extOk = r => S.ext === "all" ? true : S.ext === "com" ? r.d.toLowerCase().endsWith(".com") : /\.(com|net|org|co|us)$/i.test(r.d);
  const qOk = r => !S.q || r.d.toLowerCase().includes(S.q) || (r.loc && r.loc.toLowerCase().includes(S.q));
  const locOk = r => !S.loc || (S.loc === "__any" ? !!r.loc : r.loc === S.loc);
  const nicheOk = r => !S.sel.size || (r.ids || []).some(i => S.sel.has(i));

  function apply() {
    for (const id of [...S.sel]) if (!meta.has(id)) S.sel.delete(id);
    const base = rows.filter(r => !Lists.isDis(r.d) && extOk(r) && qOk(r));
    const counts = new Map();
    for (const r of base) if (locOk(r)) for (const i of r.ids) counts.set(i, (counts.get(i) || 0) + 1);
    const locCounts = new Map(); let anyLoc = 0;
    for (const r of base) if (nicheOk(r) && r.loc) { locCounts.set(r.loc, (locCounts.get(r.loc) || 0) + 1); anyLoc++; }
    filtered = base.filter(r => locOk(r) && nicheOk(r));
    drawList(counts); drawLocations(locCounts, anyLoc); drawTiles(base.filter(locOk), counts); render();
  }
  function render() { drawWarn(); drawViews(); drawHeader(); drawActions(); drawTrend(); drawResults(); }

  function drawWarn() {
    const dates = rangeDates(), miss = dates.filter(d => missing.has(d)), kids = [];
    if (miss.length) kids.push(el("div", { class: "warn" }, el("b", {}, "Niche data is missing for " + fmt(miss.length) + " of " + fmt(dates.length) + " days. "),
      "Built-in niches can't be counted for those days until the daily job processes them (Admin → Data & jobs)."));
    const active = [];
    if (S.loc) active.push("Location: " + (S.loc === "__any" ? "any city/state" : S.loc));
    if (S.ext !== "all") active.push("Extension: " + (S.ext === "com" ? ".com only" : "main"));
    if (S.q) active.push("Search: “" + S.q + "”");
    if (active.length) kids.push(el("div", { class: "active-filters" }, el("span", { class: "sub" }, "Filters on: " + active.join(" · ")),
      el("button", { class: "btn small", onclick: () => { S.loc = ""; S.ext = "all"; S.q = ""; S.page = 0; save(); $("#nf-ext", host).value = "all"; $("#nf-q", host).value = ""; apply(); } }, "Clear filters")));
    $("#nf-warn", host).replaceChildren(...kids);
  }

  function drawList(counts) {
    const groups = [{ name: "My seed keywords", ids: seeds.map(s => s.nid), seeds: true }];
    for (const n of ctx.cfg.niches) { let g = groups.find(x => x.name === n.group); if (!g) groups.push(g = { name: n.group, ids: [] }); g.ids.push(n.id); }
    const max = Math.max(1, ...[...counts].filter(([i]) => i !== "generic").map(([, v]) => v));
    const kids = [];
    for (const g of groups) {
      const ids = g.ids.slice().sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
      const total = ids.reduce((s, i) => s + (counts.get(i) || 0), 0);
      kids.push(el("div", { class: "group-h" }, el("span", {}, g.name),
        g.seeds ? el("button", { class: "linkbtn", onclick: openSeedDialog }, seeds.length ? "✎ Edit" : "+ Add") : el("span", { class: "num" }, fmt(total))));
      if (g.seeds && !seeds.length) kids.push(el("div", { class: "seed-empty", role: "button", tabindex: "0", onclick: openSeedDialog },
        el("b", {}, "+ Add your seed keywords"), el("div", { class: "hint", style: { margin: "2px 0 0" } }, "e.g. chimney, stucco, epoxy. Each becomes its own niche, searched every day.")));
      for (const id of ids) {
        const n = counts.get(id) || 0, on = S.sel.has(id), pending = scanIds.has(id);
        kids.push(el("div", {
            class: "nrow" + (on ? " on" : "") + (n ? "" : " zero"), role: "checkbox", "aria-checked": String(on), tabindex: "0",
            title: pending ? "New: searched in your browser until the next daily run" : null,
            onclick: () => { on ? S.sel.delete(id) : S.sel.add(id); S.page = 0; save(); apply(); logNiches(); },
            onkeydown: e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.currentTarget.click(); } } },
          el("span", { class: "box" }, on ? "✓" : ""),
          el("span", {}, meta.get(id)?.name || id, pending ? el("span", { class: "new" }, "new") : null),
          el("div", { class: "track" }, n && id !== "generic" ? el("div", { class: "fill", style: { width: (n / max * 100) + "%" } }) : ""),
          el("span", { class: "cnt num" }, fmt(n))));
      }
    }
    $("#nf-list", host).replaceChildren(...kids);
    $("#nf-clear", host).disabled = !S.sel.size;
  }

  function drawLocations(locCounts, anyLoc) {
    const sel = $("#nf-loc", host);
    const opts = [el("option", { value: "" }, "All locations"), el("option", { value: "__any" }, "Any city/state in name (" + fmt(anyLoc) + ")")];
    [...locCounts].sort((a, b) => b[1] - a[1]).forEach(([l, n]) => opts.push(el("option", { value: l }, l + " (" + fmt(n) + ")")));
    if (S.loc && S.loc !== "__any" && !locCounts.has(S.loc)) opts.push(el("option", { value: S.loc }, S.loc + " (0)"));
    sel.replaceChildren(...opts); sel.value = S.loc;
  }

  function drawTiles(base, counts) {
    const ds = new Set(rangeDates());
    const total = days.filter(d => ds.has(d.date)).reduce((s, d) => s + d.domains, 0);
    const top = [...counts].filter(([i]) => i !== "generic" && !i.startsWith("seed:")).sort((a, b) => b[1] - a[1])[0];
    const seedHits = base.filter(r => r.ids.some(i => i.startsWith("seed:"))).length;
    $("#nf-tiles", host).replaceChildren(
      tile("Service-business domains", fmt(base.length), (total ? (base.length / total * 100).toFixed(1) : 0) + "% of " + fmt(total) + " new domains"),
      tile("Matching your seeds", fmt(seedHits), seeds.length ? seeds.length + " seed group" + (seeds.length > 1 ? "s" : "") : "add seed keywords on the left"),
      tile("Top niche", top ? fmt(top[1]) : "–", top ? meta.get(top[0])?.name : "no matches"),
      tile("Favorites", fmt(Lists.favCount()), fmt(Lists.disCount()) + " discarded"));
  }

  function drawViews() {
    const v = (key, label) => el("button", { "aria-selected": String(S.view === key), onclick: () => { S.view = key; S.page = 0; save(); render(); } }, label);
    $("#nf-views", host).replaceChildren(v("results", "Results"), v("fav", "★ Favorites (" + fmt(Lists.favCount()) + ")"), v("dis", "Discarded (" + fmt(Lists.disCount()) + ")"));
  }
  const favRows = () => Lists.favs().map(f => ({ d: f.domain, date: f.found_date, ids: f.niche_ids || [], kws: f.kws || [], loc: f.loc || "", at: f.updated_at }))
    .filter(f => extOk(f) && qOk(f) && locOk(f) && nicheOk(f)).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  const disRows = () => Lists.diss().map(f => ({ d: f.domain, at: f.updated_at })).filter(r => !S.q || r.d.includes(S.q)).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  const current = () => S.view === "fav" ? favRows() : S.view === "dis" ? disRows() : filtered;

  function drawHeader() {
    const names = [...S.sel].map(i => meta.get(i)?.name).filter(Boolean);
    const nichesText = names.length ? (names.length > 3 ? names.slice(0, 3).join(", ") + " +" + (names.length - 3) : names.join(", ")) : "All niches";
    let title, sub;
    if (S.view === "fav") { title = "★ Favorites" + (names.length ? " · " + nichesText : ""); sub = fmt(current().length) + " saved domains (all dates)"; }
    else if (S.view === "dis") { title = "Discarded domains"; sub = fmt(current().length) + " hidden from your results"; }
    else {
      title = nichesText; sub = fmt(filtered.length) + " domains · " + rangeLabel();
      if (S.loc) sub += " · " + (S.loc === "__any" ? "with a location" : S.loc);
      if (S.ext !== "all") sub += " · " + (S.ext === "com" ? ".com only" : "main extensions");
    }
    $("#nf-title", host).textContent = title; $("#nf-sub", host).textContent = sub;
  }

  function drawActions() {
    const list = current(), none = !list.length, kids = [];
    if (S.view === "results") kids.push(seg([["table", "Table"], ["group", "By niche"]], S.layout, k => { S.layout = k; save(); drawActions(); drawResults(); }));
    if (S.view !== "dis") {
      kids.push(el("button", { class: "btn", disabled: none, onclick: e => copyText(e.currentTarget, list.map(r => r.d).join("\n"), list.length) }, "Copy"));
      kids.push(el("button", { class: "btn" + (S.view === "fav" ? " primary" : ""), disabled: none, onclick: () => exportCsv(list, S.view === "fav" ? "favorites" : null) }, "Export CSV"));
      if (S.view === "results") kids.push(el("button", { class: "btn primary", disabled: none, onclick: exportZip }, "Export by niche (.zip)"));
    } else {
      kids.push(el("button", { class: "btn", disabled: none, onclick: async e => {
        if (!restoreArm) { restoreArm = true; e.currentTarget.textContent = "Click again to restore all"; setTimeout(() => { restoreArm = false; drawActions(); }, 4000); return; }
        restoreArm = false;
        try { await Lists.set(Lists.diss().map(r => r.domain), { discarded: false }); toast("Restored all discarded domains"); } catch (err) { toast(errText(err)); }
      } }, "Restore all"));
    }
    $("#nf-actions", host).replaceChildren(...kids);
  }

  function drawTrend() {
    const box = $("#nf-chart", host), dates = rangeDates();
    const showIt = S.view === "results" && dates.length > 1;
    box.style.display = showIt ? "" : "none"; if (!showIt) return;
    const per = new Map(dates.map(d => [d, 0]));
    for (const r of filtered) per.set(r.date, (per.get(r.date) || 0) + 1);
    drawBars(box, dates.map(d => ({ key: d, value: per.get(d) })), { unit: "matching domains", onClick: d => { S.day = d; S.page = 0; save(); syncRange(); load(); } });
  }

  // ---------- rows ----------
  function actCell(r) {
    const fav = Lists.isFav(r.d);
    return el("td", { class: "act" },
      el("button", { class: "icon star" + (fav ? " on" : ""), title: fav ? "Remove from favorites" : "Add to favorites", "aria-label": "Favorite",
        onclick: async e => { const b = e.currentTarget;
          quiet = true;
          try { const on = await Lists.toggleFav(r); b.classList.toggle("on", on); b.textContent = on ? "★" : "☆"; drawViews(); refreshFavTile(); if (S.view === "fav" && !on) render(); }
          catch (err) { toast(errText(err)); } finally { quiet = false; } } }, fav ? "★" : "☆"),
      el("button", { class: "icon dis", title: "Discard (hide from results)", "aria-label": "Discard", onclick: () => discard([r]) }, "✕"));
  }
  function refreshFavTile() { const t = $("#nf-tiles .tile:last-child .value", host); if (t) t.textContent = fmt(Lists.favCount()); }
  async function discard(rs) {
    try {
      quiet = true;
      const before = await Lists.set(rs.map(r => r.d), { discarded: true }, {}).finally(() => { quiet = false; });
      apply();
      toast(rs.length === 1 ? "Discarded " + rs[0].d : "Discarded " + fmt(rs.length) + " domains", async () => { await Lists.restore(before); apply(); });
    } catch (e) { toast(errText(e)); }
  }
  const chips = ids => (ids || []).map(id => el("span", { class: "chip" + (id.startsWith("seed") ? " seed" : "") }, meta.get(id)?.name || id));
  function rowEl(r, n, multiDay) {
    return el("tr", {}, actCell(r), el("td", { class: "idx num" }, fmt(n)),
      multiDay ? el("td", { class: "num muted", style: { whiteSpace: "nowrap" } }, (r.date || "").slice(5)) : null,
      el("td", {}, highlight(r.d, r.kws || [])), el("td", {}, ...chips(r.ids)),
      el("td", { class: "sub" }, r.loc || el("span", { class: "muted" }, "–")), el("td", { class: "r" }, whoisLink(r.d)));
  }
  const head = (multiDay, dateLabel = "Date") => el("thead", {}, el("tr", {}, el("th", { class: "act" }), el("th", {}, "#"), multiDay ? el("th", {}, dateLabel) : null,
    el("th", {}, "Domain"), el("th", {}, "Niche"), el("th", {}, "Location"), el("th", { class: "r" }, "Lookup")));
  function pager(total, onPage, extra) {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)), start = S.page * PAGE_SIZE;
    return el("div", { class: "pager" },
      el("span", { class: "sub num" }, "Showing " + fmt(start + 1) + "–" + fmt(Math.min(total, start + PAGE_SIZE)) + " of " + fmt(total)),
      el("div", { class: "controls" }, extra,
        el("button", { class: "btn", disabled: S.page === 0, onclick: () => { S.page--; onPage(); } }, "‹"),
        el("span", { class: "sub num" }, "Page " + fmt(S.page + 1) + " of " + fmt(pages)),
        el("button", { class: "btn", disabled: S.page >= pages - 1, onclick: () => { S.page++; onPage(); } }, "›")));
  }
  function drawResults() {
    const box = $("#nf-results", host);
    if (S.view === "dis") return drawDiscarded(box);
    const list = current();
    if (!list.length) return box.replaceChildren(el("div", { class: "msg" },
      S.view === "fav" ? "No favorites yet. Click ☆ next to a domain to save it here (it also appears in Leads → Pipeline)." : rows.length ? "No domains match these filters." : "No niche domains in this range yet."));
    if (S.view === "results" && S.layout === "group") return drawGrouped(box);
    const pages = Math.ceil(list.length / PAGE_SIZE); S.page = Math.min(S.page, pages - 1);
    const start = S.page * PAGE_SIZE, slice = list.slice(start, start + PAGE_SIZE);
    const multiDay = S.view === "fav" || rangeDates().length > 1;
    const tbody = el("tbody"); slice.forEach((r, i) => tbody.append(rowEl(r, start + i + 1, multiDay)));
    box.replaceChildren(el("div", { class: "scroll", style: { maxHeight: "640px" } }, el("table", {}, head(multiDay, S.view === "fav" ? "Found" : "Date"), tbody)),
      pager(list.length, drawResults, S.view === "results" ? el("button", { class: "btn small", onclick: () => discard(slice) }, "Discard this page") : null));
  }
  function groupsOf(list) {
    const g = new Map();
    for (const r of list) for (const id of r.ids) { if (S.sel.size && !S.sel.has(id)) continue; if (!g.has(id)) g.set(id, []); g.get(id).push(r); }
    return [...g].sort((a, b) => (a[0].startsWith("seed") ? 0 : 1) - (b[0].startsWith("seed") ? 0 : 1) || b[1].length - a[1].length);
  }
  function drawGrouped(box) {
    const multiDay = rangeDates().length > 1, kids = [];
    for (const [id, list] of groupsOf(filtered)) {
      const open = expanded.has(id), shown = open ? list : list.slice(0, 15);
      const tbody = el("tbody"); shown.forEach((r, i) => tbody.append(rowEl(r, i + 1, multiDay)));
      kids.push(el("div", { class: "group" },
        el("div", { class: "group-title" },
          el("div", {}, el("b", {}, meta.get(id)?.name || id), " ", el("span", { class: "muted num" }, fmt(list.length) + " domains"),
            id.startsWith("seed") ? el("span", { class: "chip seed", style: { marginLeft: "6px" } }, "seed") : null),
          el("div", { class: "controls" },
            el("button", { class: "btn small", onclick: e => copyText(e.currentTarget, list.map(r => r.d).join("\n"), list.length) }, "Copy"),
            el("button", { class: "btn small", onclick: () => exportCsv(list, meta.get(id)?.name || id) }, "CSV"))),
        el("div", { class: "scroll" }, el("table", {}, head(multiDay), tbody)),
        list.length > 15 ? el("button", { class: "linkbtn", style: { margin: "6px 8px" }, onclick: () => { open ? expanded.delete(id) : expanded.add(id); drawResults(); } },
          open ? "Show fewer" : "Show all " + fmt(list.length)) : null));
    }
    box.replaceChildren(...kids);
  }
  function drawDiscarded(box) {
    const list = disRows();
    if (!list.length) return box.replaceChildren(el("div", { class: "msg" }, "Nothing discarded. Click ✕ next to a domain to hide it from your results."));
    const pages = Math.ceil(list.length / PAGE_SIZE); S.page = Math.min(S.page, pages - 1);
    const start = S.page * PAGE_SIZE, slice = list.slice(start, start + PAGE_SIZE);
    const tbody = el("tbody");
    slice.forEach((r, i) => tbody.append(el("tr", {}, el("td", { class: "idx num" }, fmt(start + i + 1)), el("td", { class: "domain" }, r.d),
      el("td", { class: "muted num" }, (r.at || "").slice(0, 10)),
      el("td", { class: "r" }, el("button", { class: "btn small", onclick: async () => { try { await Lists.set([r.d], { discarded: false }); toast("Restored " + r.d); } catch (e) { toast(errText(e)); } } }, "Restore")))));
    box.replaceChildren(el("div", { class: "scroll", style: { maxHeight: "640px" } },
      el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "#"), el("th", {}, "Domain"), el("th", {}, "Discarded on"), el("th"))), tbody)), pager(list.length, drawResults));
  }

  // ---------- exports ----------
  const csvOf = list => csv(["date", "domain", "extension", "niches", "matched_keywords", "location", "favorite"],
    list.map(r => [r.date || "", r.d, tldOf(r.d), (r.ids || []).map(i => meta.get(i)?.name || i), r.kws || [], r.loc || "", Lists.isFav(r.d) ? "yes" : ""]));
  const fileTag = () => S.day || (S.range === 1 ? days[days.length - 1].date : S.range ? "last" + S.range + "days" : "all");
  function exportCsv(list, label) {
    const tag = label ? safeName(label) : S.sel.size ? [...S.sel].map(i => safeName(meta.get(i)?.name || i)).join("_").slice(0, 60) : "all-niches";
    download("domains_" + tag + "_" + (label === "favorites" ? new Date().toISOString().slice(0, 10) : fileTag()) + ".csv", csvOf(list), "text/csv");
    logEvent("export_csv", { tab: "niche", rows: list.length });
  }
  async function exportZip() {
    const zip = new window.JSZip(), groups = groupsOf(filtered);
    for (const [id, list] of groups) zip.file(safeName(meta.get(id)?.name || id) + ".csv", csvOf(list));
    zip.file("_all.csv", csvOf(filtered));
    download("niches_" + fileTag() + ".zip", await zip.generateAsync({ type: "blob" }));
    logEvent("export_zip", { tab: "niche", rows: filtered.length, files: groups.length });
    toast("Downloaded " + groups.length + " niche files");
  }

  // ---------- seed editor ----------
  function openSeedDialog() {
    openDialog(close => {
      const ta = el("textarea", { class: "input", rows: 12, spellcheck: "false", placeholder: "Chimney: chimney, chimneysweep, flue\nStucco: stucco, plaster\nEpoxy flooring: epoxy, garagefloor\nsiding" });
      ta.value = Seeds.toText();
      const status = el("div", { class: "hint" });
      return el("form", { class: "dlg", onsubmit: async e => {
          e.preventDefault();
          status.className = "hint"; status.textContent = "Saving…";
          try {
            const list = await Seeds.save(Seeds.parse(ta.value));
            close(); applySeeds(); load();
            toast("Saved " + list.length + " seed group" + (list.length === 1 ? "" : "s") + ". They're searched automatically from the next daily run.");
          } catch (err) { status.className = "hint err"; status.textContent = "Couldn't save: " + errText(err); }
        } },
        el("h2", {}, "My seed keywords"),
        el("p", { class: "sub" }, "One group per line. Each group becomes its own niche, and every new day is searched for it. Only you see your seeds."),
        el("div", { class: "fmt" },
          el("div", {}, el("code", {}, "Name: keyword1, keyword2"), " a named group"),
          el("div", {}, el("code", {}, "keyword"), " a single keyword (the name is the keyword)"),
          el("div", {}, el("code", {}, "-word"), " exclude names containing this word, e.g. ", el("code", {}, "Tree: tree, -street"))),
        ta,
        el("p", { class: "hint" }, "Spaces and dashes are ignored: “tree service” finds treeservice.com and tree-service.com. Keywords need at least 3 letters."),
        el("div", { class: "notice ok" }, "Saved to your account. The daily job searches every stored day for new seeds, then each new day automatically. Until then they're searched in your browser (last " + SCAN_MAX_DAYS + " days)."),
        status,
        el("div", { class: "dlg-actions" }, el("span", { style: { flex: 1 } }),
          el("button", { type: "button", class: "btn", onclick: close }, "Cancel"),
          el("button", { type: "submit", class: "btn primary" }, "Save seeds")));
    });
  }

  // one-time import of seeds / favorites the previous (browser-only) version kept in localStorage
  function legacyBanner() {
    if (store.get("dr_legacy_done", false)) return null;
    const oldSeeds = store.get("nf_seeds_local", null) || store.get("nf_custom", []);
    const oldLists = store.get("nf_lists", null);
    const nSeeds = (oldSeeds || []).length, nFav = oldLists ? Object.keys(oldLists.fav || {}).length : 0, nDis = oldLists ? Object.keys(oldLists.dis || {}).length : 0;
    if (!nSeeds && !nFav && !nDis) return null;
    return el("div", { class: "warn", id: "nf-legacy" }, el("b", {}, "Found data from the previous version in this browser: "),
      [nSeeds && nSeeds + " seed group(s)", nFav && nFav + " favorite(s)", nDis && nDis + " discarded"].filter(Boolean).join(", ") + ". ",
      el("button", { class: "btn small", onclick: async e => {
        e.target.disabled = true; e.target.textContent = "Importing…";
        try {
          if (nSeeds) {
            const cur = Seeds.list().map(x => ({ id: x.id, name: x.name, keywords: x.keywords, exclude: x.exclude }));
            const names = new Set(cur.map(x => x.name.toLowerCase()));
            const add = oldSeeds.filter(x => x.keywords?.length && !names.has((x.name || "").toLowerCase())).map(x => ({ name: x.name, keywords: x.keywords, exclude: x.exclude || [] }));
            if (add.length) await Seeds.save([...cur, ...add]);
          }
          for (const [d, v] of Object.entries(oldLists?.fav || {})) await Lists.set([d], { fav: true }, { found_date: v.date, niche_ids: v.ids, kws: v.kws, loc: v.loc || null });
          const dis = Object.keys(oldLists?.dis || {});
          if (dis.length) await Lists.set(dis, { discarded: true });
          store.set("dr_legacy_done", true); applySeeds(); load(); toast("Imported into your account");
        } catch (err) { toast(errText(err)); e.target.disabled = false; e.target.textContent = "Import"; }
      } }, "Import into my account"),
      el("button", { class: "btn small", style: { marginLeft: "6px" }, onclick: () => { store.set("dr_legacy_done", true); $("#nf-legacy", host)?.remove(); } }, "Ignore"));
  }
  const lb = legacyBanner();
  if (lb) $("#nf-warn", host).before(lb);

  bus.on("lists", () => { if (!quiet) apply(); });
  applySeeds();
  load();
  return {
    show() {},
    redraw() { drawTrend(); }
  };
}
