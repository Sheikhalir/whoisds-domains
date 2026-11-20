// RESEARCH tab: Momentum (which niches are growing) and Geography (where new businesses appear).
import { el, $, $$, fmt, prettyDate, shortDate, isoDay, addDays, tile, seg, subtabs, multiSelect, sparkline, drawBars, seqColor, csv, download,
         US, US_TILES, store, toast, errText } from "./core.js";
import { rpc, Seeds, logEvent } from "./api.js";

export function mount(host, ctx) {
  const days = ctx.days, meta = ctx.meta;
  const S = Object.assign({ sub: "momentum", period: 7, group: "all", sort: "growth", minVol: 10, sel: null, gPeriod: 30, gNiches: [], gView: "cities", gState: "" }, store.get("dr_research", {}));
  const save = () => store.set("dr_research", S);
  let seedCounts = null;
  host.replaceChildren(el("div", { id: "rs-sub" }), el("div", { id: "rs-body" }));
  if (!days.length) { $("#rs-body", host).replaceChildren(el("div", { class: "card msg" }, "No data yet.")); return { show() {} }; }

  function drawSub() {
    $("#rs-sub", host).replaceChildren(subtabs([["momentum", "Momentum"], ["geo", "Geography"]], S.sub, v => { S.sub = v; save(); build(); logEvent("view", { tab: "research:" + v }); }));
  }
  function build() { drawSub(); S.sub === "geo" ? buildGeo() : buildMomentum(); }

  // ---------------- Momentum ----------------
  async function buildMomentum() {
    const body = $("#rs-body", host);
    const P = S.period, cur = days.slice(-P), prev = days.slice(-2 * P, -P), spark = days.slice(-Math.max(2 * P, 14));
    const enough = prev.length >= Math.max(2, Math.floor(P / 2));
    if (seedCounts === null && Seeds.list().length) {
      try { seedCounts = await rpc("seed_daily_counts", { p_from: days[0].date, p_to: days[days.length - 1].date }); } catch { seedCounts = []; }
    }
    const seedMap = new Map();   // seed nid -> date -> n
    for (const r of seedCounts || []) { const k = "seed:" + r.seed_id; if (!seedMap.has(k)) seedMap.set(k, new Map()); seedMap.get(k).set(r.date, +r.n); }
    const countOn = (id, d) => id.startsWith("seed:") ? (seedMap.get(id)?.get(d.date) || 0) : (d.niches?.[id] || 0);
    const ids = [...ctx.cfg.niches.filter(n => n.id !== "generic").map(n => n.id), ...Seeds.list().map(s => "seed:" + s.id)];
    Seeds.list().forEach(s => meta.set("seed:" + s.id, { name: s.name, group: "My seed keywords" }));
    const sum = (id, ds) => ds.reduce((a, d) => a + countOn(id, d), 0);
    const totalCur = cur.reduce((a, d) => a + Object.entries(d.niches || {}).filter(([k]) => k !== "generic").reduce((x, [, v]) => x + v, 0), 0);
    let rows = ids.map(id => {
      const c = sum(id, cur), p = sum(id, prev);
      const ca = cur.length ? c / cur.length : 0, pa = prev.length ? p / prev.length : 0;
      const change = pa ? (ca - pa) / pa * 100 : (ca ? null : 0);
      return { id, name: meta.get(id)?.name || id, group: meta.get(id)?.group || "", c, p, ca, pa, change, share: totalCur ? c / totalCur * 100 : 0, series: spark.map(d => countOn(id, d)) };
    }).filter(r => S.group === "all" || r.group === S.group);
    const ranked = rows.filter(r => r.c >= S.minVol || r.id.startsWith("seed:"));
    const sorters = { growth: (a, b) => (b.change ?? -1e9) - (a.change ?? -1e9), volume: (a, b) => b.c - a.c, name: (a, b) => a.name.localeCompare(b.name) };
    ranked.sort(sorters[S.sort]);
    const growth = rows.filter(r => r.c >= S.minVol && r.change != null && !r.id.startsWith("seed:"));
    const up = growth.slice().sort((a, b) => b.change - a.change)[0], down = growth.slice().sort((a, b) => a.change - b.change)[0];
    const busiest = rows.filter(r => !r.id.startsWith("seed:")).sort((a, b) => b.c - a.c)[0];
    const pct = v => v == null ? "new" : (v > 0 ? "+" : "") + v.toFixed(0) + "%";
    const groups = [...new Set(ctx.cfg.niches.map(n => n.group))].filter(g => g !== "Other");
    if (!S.sel || !ids.includes(S.sel)) S.sel = busiest?.id || ids[0];

    body.replaceChildren(
      el("div", { class: "filters" },
        seg([[7, "Last 7 vs previous 7 days"], [30, "Last 30 vs previous 30 days"]], P, v => { S.period = v; save(); buildMomentum(); }),
        el("select", { onchange: e => { S.group = e.target.value; save(); buildMomentum(); } }, el("option", { value: "all" }, "All groups"),
          ...[...groups, "My seed keywords"].map(g => el("option", { value: g, selected: g === S.group }, g))),
        el("label", {}, "Hide niches under", el("select", { onchange: e => { S.minVol = +e.target.value; save(); buildMomentum(); } },
          ...[1, 5, 10, 25, 50, 100].map(v => el("option", { value: v, selected: v === S.minVol }, v + " domains")))),
        el("span", { style: { flex: 1 } }),
        el("button", { class: "btn", onclick: () => { download("niche_momentum_" + isoDay() + ".csv", csv(["niche", "group", "this_period", "previous_period", "avg_per_day", "prev_avg_per_day", "change_pct", "share_pct"],
          ranked.map(r => [r.name, r.group, r.c, r.p, r.ca.toFixed(1), r.pa.toFixed(1), r.change == null ? "" : r.change.toFixed(1), r.share.toFixed(2)])), "text/csv"); logEvent("export_csv", { tab: "momentum", rows: ranked.length }); } }, "Export CSV")),
      !enough ? el("div", { class: "warn" }, el("b", {}, "Not enough history yet. "), "Comparisons need about " + 2 * P + " stored days (you have " + days.length + "). Numbers will firm up as data builds.") : null,
      el("div", { class: "tiles" },
        tile("Fastest growing", up ? pct(up.change) : "–", up ? up.name + " · " + fmt(up.c) + " domains" : "not enough data"),
        tile("Biggest drop", down && down.change < 0 ? pct(down.change) : "–", down && down.change < 0 ? down.name : "nothing is shrinking"),
        tile("Busiest niche", busiest ? fmt(busiest.c) : "–", busiest ? busiest.name : ""),
        tile("All niche domains", fmt(totalCur), cur.length + " days · " + shortDate(cur[0]?.date) + " – " + shortDate(cur[cur.length - 1]?.date))),
      el("div", { class: "grid-2" },
        el("section", { class: "card" },
          el("div", { class: "card-head" }, el("h2", {}, "Niches ranked"), el("div", { class: "seg" },
            ...[["growth", "Growth"], ["volume", "Volume"], ["name", "A–Z"]].map(([v, t]) => el("button", { "aria-pressed": String(S.sort === v), onclick: () => { S.sort = v; save(); buildMomentum(); } }, t)))),
          el("div", { class: "tbl-wrap", style: { maxHeight: "640px" } }, el("table", { class: "data" },
            el("thead", {}, el("tr", {}, el("th", {}, "Niche"), el("th", { class: "r" }, "This period"), el("th", { class: "r" }, "Previous"),
              el("th", { class: "r" }, "Change"), el("th", {}, "Daily trend"), el("th", { class: "r" }, "Share"))),
            el("tbody", {}, ...ranked.map(r => el("tr", { class: "click", style: r.id === S.sel ? { background: "var(--series-1-soft)" } : null, onclick: () => { S.sel = r.id; save(); buildMomentum(); } },
              el("td", {}, r.name, r.id.startsWith("seed:") ? el("span", { class: "chip seed", style: { marginLeft: "6px" } }, "seed") : null),
              el("td", { class: "r num" }, fmt(r.c)), el("td", { class: "r num muted" }, fmt(r.p)),
              el("td", { class: "r num" }, el("span", { class: "delta " + (r.change == null ? "" : r.change > 5 ? "up" : r.change < -5 ? "down" : "") }, pct(r.change))),
              el("td", {}, sparkline(r.series)), el("td", { class: "r num muted" }, r.share.toFixed(1) + "%"))))))),
        el("section", { class: "card" }, el("div", { id: "rs-detail" }))));
    const sel = rows.find(r => r.id === S.sel) || { id: S.sel, name: meta.get(S.sel)?.name, c: 0, p: 0, ca: 0, pa: 0, change: 0 };
    const det = $("#rs-detail", host);
    const chart = el("div", { class: "chart", style: { height: "220px" } });
    det.replaceChildren(el("div", { class: "card-head" }, el("div", {}, el("h2", {}, sel.name), el("div", { class: "sub" }, "New domains per day, all stored days"))),
      el("div", { class: "tiles", style: { gridTemplateColumns: "repeat(3, 1fr)" } },
        tile("Per day now", sel.ca.toFixed(1), "last " + P + " days"), tile("Per day before", sel.pa.toFixed(1), "previous " + P + " days"),
        tile("Change", pct(sel.change), sel.change == null ? "no earlier data" : sel.change > 0 ? "growing" : sel.change < 0 ? "shrinking" : "flat")),
      chart,
      el("p", { class: "hint" }, "Rising registrations in a niche usually mean new businesses (or investors) are moving in: more buyers for websites, leads and services, but also more competition."));
    requestAnimationFrame(() => drawBars(chart, days.map(d => ({ key: d.date, value: countOn(S.sel, d) })), { unit: "domains" }));
  }

  // ---------------- Geography ----------------
  async function buildGeo() {
    const body = $("#rs-body", host);
    const to = days[days.length - 1].date, P = S.gPeriod, from = addDays(to, -(P - 1)), pFrom = addDays(from, -P), pTo = addDays(from, -1);
    const groups = [];
    for (const n of ctx.cfg.niches) { if (n.id === "generic") continue; let g = groups.find(x => x.name === n.group); if (!g) groups.push(g = { name: n.group, items: [] }); g.items.push([n.id, n.name]); }
    body.replaceChildren(
      el("div", { class: "filters" },
        seg([[7, "7 days"], [30, "30 days"], [90, "90 days"]], P, v => { S.gPeriod = v; save(); buildGeo(); }),
        multiSelect({ label: "Niche", groups, selected: S.gNiches, allText: "All niches", onChange: v => { S.gNiches = v; save(); loadGeo(); } }),
        el("span", { class: "sub" }, shortDate(from) + " – " + shortDate(to) + " (compared with the " + P + " days before)")),
      el("div", { class: "tiles", id: "geo-tiles" }),
      el("div", { class: "grid-2" },
        el("section", { class: "card" }, el("div", { class: "card-head" }, el("h2", { id: "geo-map-title" }, "New service businesses by US state"),
          el("button", { class: "btn small", id: "geo-clear", onclick: () => { S.gState = ""; save(); render(); } }, "All states")),
          el("div", { class: "tilemap", id: "geo-map" }), el("div", { class: "legend-ramp", id: "geo-legend" }),
          el("div", { class: "section-h" }, "Top niches", el("span", { id: "geo-niche-scope" })), el("div", { class: "bar-list", id: "geo-niches" })),
        el("section", { class: "card" }, el("div", { class: "card-head" }, el("h2", {}, "Top locations"),
          el("div", { id: "geo-view" })), el("div", { id: "geo-table" }))));
    loadGeo();
    let cur = [], prev = [];
    async function loadGeo() {
      $("#geo-table", host).replaceChildren(el("div", { class: "msg" }, "Loading…"));
      try {
        [cur, prev] = await Promise.all([
          rpc("geo_summary", { p_from: from, p_to: to, p_niches: S.gNiches.length ? S.gNiches : null }),
          rpc("geo_summary", { p_from: pFrom, p_to: pTo, p_niches: S.gNiches.length ? S.gNiches : null })]);
        cur = (cur || []).filter(r => r.niche_id !== "generic"); prev = (prev || []).filter(r => r.niche_id !== "generic");
        render();
      } catch (e) { $("#geo-table", host).replaceChildren(el("div", { class: "msg err" }, errText(e))); }
    }
    function render() {
      const byState = new Map(), prevState = new Map(), byLoc = new Map(), prevLoc = new Map(), locState = new Map();
      for (const r of cur) { if (r.us_state) byState.set(r.us_state, (byState.get(r.us_state) || 0) + +r.n); byLoc.set(r.loc, (byLoc.get(r.loc) || 0) + +r.n); locState.set(r.loc, r.us_state); }
      for (const r of prev) { if (r.us_state) prevState.set(r.us_state, (prevState.get(r.us_state) || 0) + +r.n); prevLoc.set(r.loc, (prevLoc.get(r.loc) || 0) + +r.n); }
      const max = Math.max(1, ...byState.values());
      const total = [...byLoc.values()].reduce((a, b) => a + b, 0), usTotal = [...byState.values()].reduce((a, b) => a + b, 0);
      const topState = [...byState].sort((a, b) => b[1] - a[1])[0];
      const cities = [...byLoc].filter(([l]) => l.includes(","));
      const topCity = cities.sort((a, b) => b[1] - a[1])[0];
      const growth = [...byLoc].filter(([l, n]) => n >= 5 && prevLoc.get(l)).map(([l, n]) => [l, (n - prevLoc.get(l)) / prevLoc.get(l) * 100]).sort((a, b) => b[1] - a[1])[0];
      $("#geo-tiles", host).replaceChildren(
        tile("Domains with a location", fmt(total), fmt(usTotal) + " in the US"),
        tile("Top state", topState ? US[topState[0]] : "–", topState ? fmt(topState[1]) + " domains" : ""),
        tile("Top city", topCity ? topCity[0] : "–", topCity ? fmt(topCity[1]) + " domains" : ""),
        tile("Fastest growing place", growth ? growth[0] : "–", growth ? "+" + growth[1].toFixed(0) + "% vs previous " + P + " days" : "not enough data"));
      // map
      const map = $("#geo-map", host); map.replaceChildren();
      map.style.gridTemplateRows = "repeat(8, 1fr)";
      for (const [code, [c, r]] of Object.entries(US_TILES)) {
        const n = byState.get(code) || 0, p = prevState.get(code) || 0;
        const bg = seqColor(n, max), dark = n && n / max > 0.55;
        map.append(el("div", { class: "t" + (S.gState === code ? " sel" : ""), style: { gridColumn: c + 1, gridRow: r + 1, background: bg, color: dark ? "#fff" : "var(--text-primary)" },
          title: US[code] + ": " + fmt(n) + " domains (previous " + P + " days: " + fmt(p) + ")", role: "button", tabindex: "0",
          onclick: () => { S.gState = S.gState === code ? "" : code; save(); render(); } }, code));
      }
      $("#geo-legend", host).replaceChildren("Fewer", ...[1, 2, 3, 4, 5].map(k => el("span", { class: "sw", style: { background: `var(--seq-${k})` } })), "More", el("span", { style: { marginLeft: "8px" } }, "· click a state to filter"));
      $("#geo-map-title", host).textContent = S.gState ? US[S.gState] + " · " + fmt(byState.get(S.gState) || 0) + " domains" : "New service businesses by US state";
      $("#geo-clear", host).hidden = !S.gState;
      // niches in scope
      const nc = new Map();
      for (const r of cur) if (!S.gState || r.us_state === S.gState) nc.set(r.niche_id, (nc.get(r.niche_id) || 0) + +r.n);
      const nTop = [...nc].sort((a, b) => b[1] - a[1]).slice(0, 10), nMax = nTop[0]?.[1] || 1;
      $("#geo-niche-scope", host).textContent = S.gState ? " · " + US[S.gState] : " · all locations";
      $("#geo-niches", host).replaceChildren(...nTop.map(([id, n]) => el("div", { class: "bl" }, el("span", {}, meta.get(id)?.name || id),
        el("div", { class: "track" }, el("div", { class: "fill", style: { width: (n / nMax * 100) + "%" } })), el("span", { class: "num cnt" }, fmt(n)))));
      // table
      $("#geo-view", host).replaceChildren(seg([["cities", "Cities"], ["states", "States"], ["world", "Outside US"]], S.gView, v => { S.gView = v; save(); render(); }));
      let list;
      if (S.gView === "states") list = [...byState].map(([c, n]) => [US[c] || c, n, prevState.get(c) || 0, c]);
      else if (S.gView === "world") list = [...byLoc].filter(([l]) => !locState.get(l)).map(([l, n]) => [l, n, prevLoc.get(l) || 0, null]);
      else list = [...byLoc].filter(([l]) => l.includes(",") && locState.get(l) && (!S.gState || locState.get(l) === S.gState)).map(([l, n]) => [l, n, prevLoc.get(l) || 0, locState.get(l)]);
      list.sort((a, b) => b[1] - a[1]);
      const pct = (n, p) => p ? ((n - p) / p * 100) : null;
      $("#geo-table", host).replaceChildren(list.length ? el("div", { class: "tbl-wrap", style: { maxHeight: "640px" } }, el("table", { class: "data" },
        el("thead", {}, el("tr", {}, el("th", {}, "#"), el("th", {}, S.gView === "states" ? "State" : "Place"), el("th", { class: "r" }, "Domains"), el("th", { class: "r" }, "Previous"), el("th", { class: "r" }, "Change"))),
        el("tbody", {}, ...list.slice(0, 200).map(([name, n, p, st], i) => { const ch = pct(n, p);
          return el("tr", { class: S.gView === "states" ? "click" : "", onclick: S.gView === "states" ? () => { S.gState = st; S.gView = "cities"; save(); render(); } : null },
            el("td", { class: "idx num" }, i + 1), el("td", {}, name), el("td", { class: "r num" }, fmt(n)), el("td", { class: "r num muted" }, fmt(p)),
            el("td", { class: "r num" }, el("span", { class: "delta " + (ch == null ? "" : ch > 5 ? "up" : ch < -5 ? "down" : "") }, ch == null ? "new" : (ch > 0 ? "+" : "") + ch.toFixed(0) + "%"))); }))))
        : el("div", { class: "empty" }, "No locations found for this selection. Only domains with a city or state in the name are counted."));
    }
  }

  build();
  return { show() {}, redraw() { if (S.sub === "momentum") buildMomentum(); } };
}
