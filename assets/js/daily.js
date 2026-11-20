// DAILY FILES tab: every stored day, its full domain list, search, extension filter, downloads.
import { el, $, $$, fmt, kb, prettyDate, debounce, tldOf, PAGE_SIZE, drawBars, tile, seg, download, copyText, toast, errText } from "./core.js";
import { storageFile, dayDomains, logEvent } from "./api.js";

export function mount(host, ctx) {
  const days = ctx.days;
  let range = 30, cur = null, list = [], filtered = [], page = 0, tldFilter = null, mode = "contains", query = "";
  if (!days.length) { host.replaceChildren(el("div", { class: "card msg" }, "No days stored yet.")); return { show() {} }; }
  const total = days.reduce((s, d) => s + d.domains, 0), latest = days[days.length - 1];

  host.replaceChildren(
    el("div", { class: "tiles" },
      tile("Days stored", fmt(days.length), days[0].date + " → " + latest.date),
      tile("Domains stored", fmt(total), "across all days"),
      tile("Latest day", fmt(latest.domains), prettyDate(latest.date)),
      tile("Average per day", fmt(Math.round(total / days.length)), "domains")),
    el("div", { class: "row2" },
      el("section", { class: "card" },
        el("div", { class: "card-head" }, el("h2", {}, "Domains per day"), el("div", { id: "d-range" })),
        el("div", { class: "chart", id: "d-chart", style: { height: "240px" } })),
      el("section", { class: "card" },
        el("div", { class: "card-head" }, el("h2", {}, "Stored files"), el("span", { class: "muted" }, fmt(days.length) + " files")),
        el("div", { class: "scroll", style: { maxHeight: "240px" } },
          el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Date"), el("th", { class: "r" }, "Domains"), el("th", { class: "r" }, "Size"))),
            el("tbody", { id: "files" }))))),
    el("section", { class: "card" },
      el("div", { class: "card-head" },
        el("div", {}, el("div", { class: "viewer-title", id: "vtitle" }), el("div", { class: "sub num", id: "vsub" })),
        el("div", { class: "controls" },
          el("button", { class: "btn", id: "prev", onclick: () => step(-1) }, "‹ Prev"),
          el("select", { id: "dayselect", "aria-label": "Choose a date", onchange: e => open(e.target.value) },
            ...days.slice().reverse().map(d => el("option", { value: d.date }, d.date + "  (" + fmt(d.domains) + ")"))),
          el("button", { class: "btn", id: "next", onclick: () => step(1) }, "Next ›"))),
      el("div", { class: "row-viewer" },
        el("div", {},
          el("div", { class: "card-head", style: { marginBottom: "6px" } }, el("h2", {}, "Top extensions"), el("span", { class: "muted", style: { fontSize: "12px" } }, "click to filter")),
          el("div", { id: "tlds" })),
        el("div", {},
          el("div", { class: "controls", style: { marginBottom: "10px" } },
            el("select", { id: "mode", "aria-label": "Search type", onchange: e => { mode = e.target.value; filter(); } },
              el("option", { value: "contains" }, "Contains"), el("option", { value: "starts" }, "Starts with"),
              el("option", { value: "ends" }, "Ends with"), el("option", { value: "regex" }, "Regex")),
            el("div", { style: { flex: 1, minWidth: "180px" } },
              el("input", { type: "search", id: "q", placeholder: "Search all domains of this day…", oninput: debounce(e => { query = e.target.value.trim(); filter(); }, 150) })),
            el("button", { class: "btn", id: "copy", onclick: e => copyText(e.currentTarget, filtered.join("\n"), filtered.length) }, "Copy"),
            el("button", { class: "btn primary", id: "dltxt", onclick: () => { download(cur + ".txt", filtered.join("\n") + "\n"); logEvent("export_txt", { tab: "daily", rows: filtered.length }); } }, "Download .txt"),
            el("button", { class: "btn", id: "dlzip", onclick: downloadZip }, "Original .zip")),
          el("div", { id: "results" })))));

  const tb = $("#files", host);
  days.slice().reverse().forEach(d => tb.append(el("tr", { "data-date": d.date, style: { cursor: "pointer" }, onclick: () => open(d.date) },
    el("td", { class: "num" }, d.date), el("td", { class: "r num" }, fmt(d.domains)), el("td", { class: "r num muted" }, kb(d.bytes)))));

  function redraw() {
    $("#d-range", host).replaceChildren(seg([[30, "30 days"], [90, "90 days"], [0, "All"]], range, v => { range = v; redraw(); }));
    const box = $("#d-chart", host); if (!box || host.hidden) return;
    drawBars(box, (range ? days.slice(-range) : days).map(d => ({ key: d.date, value: d.domains })), { selected: cur, onClick: open });
  }
  function step(dir) { const i = days.findIndex(d => d.date === cur) + dir; if (days[i]) open(days[i].date); }
  async function open(date) {
    cur = date;
    const info = days.find(d => d.date === date); if (!info) return;
    $("#vtitle", host).textContent = prettyDate(date);
    $("#vsub", host).textContent = fmt(info.domains) + " domains · " + kb(info.bytes) + " zip";
    $("#dayselect", host).value = date;
    const i = days.indexOf(info); $("#prev", host).disabled = i <= 0; $("#next", host).disabled = i >= days.length - 1;
    $$("#files tr", host).forEach(r => r.classList.toggle("active", r.dataset.date === date));
    redraw();
    tldFilter = null; page = 0; $("#tlds", host).replaceChildren();
    $("#results", host).replaceChildren(el("div", { class: "msg" }, "Loading " + date + "…"));
    try { const l = await dayDomains(date); if (cur !== date) return; list = l; drawTlds(); filter(); }
    catch (e) { $("#results", host).replaceChildren(el("div", { class: "msg err" }, "Couldn't open " + date + " (" + errText(e) + ")")); }
  }
  async function downloadZip() {
    try { const buf = await storageFile("zip/" + cur + ".zip", "buffer"); download(cur + ".zip", new Blob([buf], { type: "application/zip" })); logEvent("export_zip", { tab: "daily", rows: list.length }); }
    catch (e) { toast("Couldn't download: " + errText(e)); }
  }
  function drawTlds() {
    const counts = new Map(); for (const d of list) { const t = tldOf(d); counts.set(t, (counts.get(t) || 0) + 1); }
    const sorted = [...counts].sort((a, b) => b[1] - a[1]), top = sorted.slice(0, 12), max = top[0]?.[1] || 1;
    const row = (key, label, n, w) => el("div", { class: "tld" + (tldFilter === key ? " active" : ""), role: "button", tabindex: "0",
        onclick: () => { tldFilter = tldFilter === key || key === null ? null : key; page = 0; drawTlds(); filter(); } },
      el("span", { class: "domain" }, label), el("div", { class: "track" }, w == null ? "" : el("div", { class: "fill", style: { width: w + "%" } })), el("span", { class: "cnt num" }, fmt(n)));
    $("#tlds", host).replaceChildren(row(null, "All", list.length, null), ...top.map(([t, n]) => row(t, "." + t, n, n / max * 100)),
      sorted.length > 12 ? el("div", { class: "muted", style: { fontSize: "12px", padding: "6px" } }, "+ " + (sorted.length - 12) + " more extensions") : null);
  }
  function filter() {
    let test = () => true; const q = query.toLowerCase(); $("#q", host).style.borderColor = "";
    if (q) {
      if (mode === "regex") { try { const re = new RegExp(query, "i"); test = d => re.test(d); } catch { $("#q", host).style.borderColor = "var(--critical)"; test = () => false; } }
      else if (mode === "starts") test = d => d.startsWith(q);
      else if (mode === "ends") test = d => d.endsWith(q);
      else test = d => d.includes(q);
    }
    filtered = list.filter(d => (!tldFilter || tldOf(d) === tldFilter) && test(d));
    page = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
    results();
  }
  function results() {
    const box = $("#results", host), pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const start = page * PAGE_SIZE, slice = filtered.slice(start, start + PAGE_SIZE);
    $("#dltxt", host).disabled = $("#copy", host).disabled = !filtered.length;
    if (!filtered.length) return box.replaceChildren(el("div", { class: "msg" }, "No domains match."));
    const tbody = el("tbody");
    slice.forEach((d, i) => tbody.append(el("tr", {}, el("td", { class: "idx num" }, fmt(start + i + 1)), el("td", { class: "domain" }, d), el("td", { class: "muted" }, "." + tldOf(d)))));
    box.replaceChildren(
      el("div", { class: "scroll", style: { maxHeight: "560px" } }, el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "#"), el("th", {}, "Domain"), el("th", {}, "Extension"))), tbody)),
      el("div", { class: "pager" },
        el("span", { class: "sub num" }, "Showing " + fmt(start + 1) + "–" + fmt(start + slice.length) + " of " + fmt(filtered.length) + (filtered.length !== list.length ? " (filtered from " + fmt(list.length) + ")" : "")),
        el("div", { class: "controls" },
          el("button", { class: "btn", disabled: page === 0, onclick: () => { page--; results(); } }, "‹"),
          el("span", { class: "sub num" }, "Page " + fmt(page + 1) + " of " + fmt(pages)),
          el("button", { class: "btn", disabled: page >= pages - 1, onclick: () => { page++; results(); } }, "›"))));
  }
  open(latest.date);
  return { show() { redraw(); }, redraw };
}
