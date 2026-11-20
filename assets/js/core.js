// Shared helpers used by every tab: DOM builder, formatting, charts, dialogs,
// toast, CSV/download, and the domain-matching rules (must match scripts/classify.py).

export const PAGE_SIZE = 100;
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const fmt = n => (n ?? 0).toLocaleString("en-US");
export const kb = b => b >= 1073741824 ? (b / 1073741824).toFixed(2) + " GB" : b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round((b || 0) / 1024) + " KB";
export const prettyDate = d => d ? new Date(String(d).slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "–";
export const shortDate = d => d ? new Date(String(d).slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "–";
export const dateTime = t => t ? new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
export const isoDay = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export function ago(t) {
  if (!t) return "never";
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  if (s < 86400 * 30) return Math.floor(s / 86400) + " d ago";
  return shortDate(t);
}

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "value") n.value = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
  return n;
}
const _rc = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...k) { return _rc.apply(this, k.flat().filter(x => x != null && x !== false)); };

export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export async function eachLimit(items, limit, fn) {
  let i = 0; const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}
export const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

// ---------- tiny pub/sub so tabs refresh when favorites / seeds change ----------
const subs = {};
export const bus = {
  on(ev, fn) { (subs[ev] ||= new Set()).add(fn); return () => subs[ev].delete(fn); },
  emit(ev, data) { (subs[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }
};

// ---------- domain rules (keep in sync with scripts/classify.py) ----------
export const labelOf = d => d.toLowerCase().split(".")[0].replace(/-/g, "");
export const tldOf = d => d.slice(d.lastIndexOf(".") + 1).toLowerCase();
export const matchSeed = (s, label) => { let t = label; for (const ex of s.exclude || []) t = t.split(ex).join("|"); return (s.keywords || []).find(k => t.includes(k)); };
export const seedSig = s => [...s.keywords].sort().join(",") + "|" + [...(s.exclude || [])].sort().join(",");
export function makeLocator(cfg) {
  const list = (cfg.locations || []).map(([k, v]) => [k.toLowerCase(), v]).sort((a, b) => b[0].length - a[0].length);
  return label => { for (const [k, v] of list) if (label.includes(k)) return v; return ""; };
}
export const US = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska",
  NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming"
};
// tile-grid map positions [col, row]
export const US_TILES = {
  AK: [0, 0], ME: [11, 0], VT: [10, 1], NH: [11, 1],
  WA: [1, 2], ID: [2, 2], MT: [3, 2], ND: [4, 2], MN: [5, 2], IL: [6, 2], WI: [7, 2], MI: [8, 2], NY: [9, 2], RI: [10, 2], MA: [11, 2],
  OR: [1, 3], NV: [2, 3], WY: [3, 3], SD: [4, 3], IA: [5, 3], IN: [6, 3], OH: [7, 3], PA: [8, 3], NJ: [9, 3], CT: [10, 3],
  CA: [1, 4], UT: [2, 4], CO: [3, 4], NE: [4, 4], MO: [5, 4], KY: [6, 4], WV: [7, 4], VA: [8, 4], MD: [9, 4], DE: [10, 4],
  AZ: [2, 5], NM: [3, 5], KS: [4, 5], AR: [5, 5], TN: [6, 5], NC: [7, 5], SC: [8, 5], DC: [9, 5],
  OK: [4, 6], LA: [5, 6], MS: [6, 6], AL: [7, 6], GA: [8, 6], HI: [0, 7], TX: [4, 7], FL: [9, 7]
};

export function highlight(domain, kws) {
  const low = domain.toLowerCase(), spans = [];
  for (const k of new Set(kws || [])) { const i = low.indexOf(k); if (i >= 0) spans.push([i, i + k.length]); }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const sp of spans) { const last = merged[merged.length - 1]; if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else merged.push(sp.slice()); }
  const span = el("span", { class: "domain" });
  let pos = 0;
  for (const [a, b] of merged) { span.append(domain.slice(pos, a), el("mark", {}, domain.slice(a, b))); pos = b; }
  span.append(domain.slice(pos));
  return span;
}

// ---------- toast ----------
let toastTimer;
export function toast(text, undo) {
  const t = $("#toast");
  t.replaceChildren(el("span", {}, text));
  if (undo) t.append(el("button", { class: "btn small", onclick: () => { undo(); t.hidden = true; } }, "Undo"));
  t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 6000);
}
export const errText = e => {
  const m = (e && (e.message || e.error_description || e.msg)) || String(e || "Something went wrong");
  const map = { NOT_ACTIVE: "Your access isn't active.", ADMIN_ONLY: "Only admins can do that.", CANNOT_CHANGE_SELF: "You can't remove your own admin access.",
                OWNER_PROTECTED: "The owner account can't be changed that way.", LAST_ADMIN: "At least one active admin is required.",
                CANNOT_DELETE_SELF: "You can't delete your own account.", ALREADY_USER: "That email already has an account.", BAD_EMAIL: "That email address doesn't look right.",
                PASSWORD_TOO_SHORT: "Use at least 8 characters." };
  for (const [k, v] of Object.entries(map)) if (m.includes(k)) return v + (m.includes(":") && k !== "NOT_ACTIVE" ? "" : "");
  return m.replace(/^[A-Z_]+: /, "");
};

// ---------- dialogs ----------
export function openDialog(build, { drawer = false, wide = false } = {}) {
  const d = el("dialog", { class: drawer ? "drawer" : "", style: wide ? { width: "min(760px, 96vw)" } : null });
  document.body.append(d);
  const close = () => { d.close(); d.remove(); };
  d.addEventListener("cancel", e => { e.preventDefault(); close(); });
  d.addEventListener("click", e => { if (e.target === d) close(); });
  d.append(build(close));
  d.showModal();
  return close;
}
export function confirmDialog({ title, text, okText = "Confirm", danger = false, typeToConfirm = null }) {
  return new Promise(resolve => {
    openDialog(close => {
      const input = typeToConfirm ? el("input", { type: "text", placeholder: typeToConfirm }) : null;
      const ok = el("button", { class: "btn primary", style: danger ? { background: "var(--critical)", borderColor: "var(--critical)" } : null, type: "submit" }, okText);
      if (input) { ok.disabled = true; input.addEventListener("input", () => ok.disabled = input.value.trim() !== typeToConfirm); }
      return el("form", { class: "dlg", onsubmit: e => { e.preventDefault(); close(); resolve(true); } },
        el("h2", {}, title), el("p", { class: "sub" }, text),
        input ? el("label", { class: "field" }, "Type " + typeToConfirm + " to confirm", input) : null,
        el("div", { class: "dlg-actions" }, el("span", { style: { flex: 1 } }),
          el("button", { type: "button", class: "btn", onclick: () => { close(); resolve(false); } }, "Cancel"), ok));
    });
  });
}

// ---------- download / copy / csv ----------
export function download(name, data, type = "text/plain") {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export function csv(header, rows) {
  const q = v => { v = v == null ? "" : Array.isArray(v) ? v.join("; ") : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return "﻿" + [header.join(","), ...rows.map(r => r.map(q).join(","))].join("\r\n") + "\r\n";
}
export async function copyText(btn, text, count) {
  const t = btn.textContent;
  try { await navigator.clipboard.writeText(text); btn.textContent = "Copied" + (count != null ? " " + fmt(count) : ""); } catch { btn.textContent = "Copy failed"; }
  setTimeout(() => btn.textContent = t, 1800);
}
export const safeName = s => String(s).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 50) || "file";

// ---------- charts (single series; see dataviz rules: one hue, thin marks, hover tooltip) ----------
function niceStep(v) { if (v <= 1) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const f of [1, 2, 5, 10]) if (f * p >= v) return f * p; return 10 * p; }
export function drawBars(box, data, { selected, onClick, unit = "domains", labelFmt = d => d.key.slice(5), tipTitle = d => prettyDate(d.key) } = {}) {
  const W = box.clientWidth, H = box.clientHeight; if (!W) return;
  const m = { t: 10, r: 4, b: 22, l: 44 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = Math.max(...data.map(d => d.value), 1), stepV = niceStep(max / 4), ticks = Math.max(1, Math.ceil(max / stepV)), nice = stepV * ticks;
  const slot = iw / Math.max(1, data.length), bw = Math.max(2, Math.min(28, slot - 2));
  const y = v => m.t + ih - (v / nice) * ih;
  const ns = "http://www.w3.org/2000/svg";
  const s = (tag, a) => { const n = document.createElementNS(ns, tag); for (const k in a) n.setAttribute(k, a[k]); return n; };
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Bar chart of " + unit });
  for (let i = 0; i <= ticks; i++) {
    const v = stepV * i, yy = y(v);
    svg.append(s("line", { x1: m.l, x2: W - m.r, y1: yy, y2: yy, stroke: "var(--grid)", "stroke-width": 1 }));
    const t = s("text", { x: m.l - 8, y: yy + 4, "text-anchor": "end", fill: "var(--text-muted)", "font-size": 11 });
    t.textContent = v >= 1000 ? (+(v / 1000).toFixed(1)) + "k" : +v.toFixed(1); svg.append(t);
  }
  const every = Math.ceil(data.length / Math.max(1, Math.floor(iw / 56)));
  const tip = $("#tip");
  data.forEach((d, i) => {
    const cx = m.l + slot * i + slot / 2, x = cx - bw / 2, top = y(d.value), h = m.t + ih - top, r = Math.min(4, bw / 2, h);
    const g = s("g", { class: "bar" });
    g.append(s("rect", { x: m.l + slot * i, y: m.t, width: slot, height: ih, fill: "transparent" }));
    if (h > 0) g.append(s("path", {
      d: `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${top + h} Z`,
      fill: "var(--series-1)", opacity: selected && selected !== d.key ? 0.45 : 1 }));
    g.addEventListener("mousemove", e => {
      tip.replaceChildren(el("b", {}, fmt(d.value) + " " + unit), el("span", { class: "muted" }, tipTitle(d)));
      tip.style.display = "block";
      tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
      tip.style.top = (e.clientY - tip.offsetHeight - 10) + "px";
    });
    g.addEventListener("mouseleave", () => tip.style.display = "none");
    if (onClick) { g.style.cursor = "pointer"; g.addEventListener("click", () => onClick(d.key)); }
    svg.append(g);
    if (i % every === 0) {
      const t = s("text", { x: cx, y: H - 5, "text-anchor": "middle", fill: "var(--text-muted)", "font-size": 11 });
      t.textContent = labelFmt(d); svg.append(t);
    }
  });
  svg.append(s("line", { x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih, stroke: "var(--text-muted)", "stroke-width": 1 }));
  box.replaceChildren(svg);
}
export function sparkline(values, { w = 110, h = 26 } = {}) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", w); svg.setAttribute("height", h); svg.setAttribute("class", "spark"); svg.setAttribute("aria-hidden", "true");
  if (!values.length) return svg;
  const max = Math.max(...values, 1), step = values.length > 1 ? (w - 4) / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${2 + i * step},${h - 3 - (v / max) * (h - 6)}`).join(" ");
  const pl = document.createElementNS(ns, "polyline");
  pl.setAttribute("points", pts); pl.setAttribute("fill", "none"); pl.setAttribute("stroke", "var(--series-1)"); pl.setAttribute("stroke-width", "2");
  pl.setAttribute("stroke-linejoin", "round"); pl.setAttribute("stroke-linecap", "round");
  svg.append(pl);
  return svg;
}
export const seqColor = (v, max) => {
  if (!v) return "var(--seq-0)";
  const k = Math.min(5, Math.max(1, Math.ceil((v / Math.max(max, 1)) * 5)));
  return `var(--seq-${k})`;
};

// ---------- UI bits ----------
export function tile(label, value, note) {
  return el("div", { class: "card tile" }, el("div", { class: "label" }, label), el("div", { class: "value num" }, value), el("div", { class: "note" }, note || ""));
}
export function seg(options, current, onPick) {
  return el("div", { class: "seg" }, ...options.map(([v, t]) => el("button", { "aria-pressed": String(v === current), onclick: () => onPick(v) }, t)));
}
export function subtabs(options, current, onPick) {
  return el("div", { class: "subtabs", role: "tablist" }, ...options.map(([v, t, n]) =>
    el("button", { role: "tab", "aria-selected": String(v === current), onclick: () => onPick(v) }, t, n != null ? el("span", { class: "count num" }, fmt(n)) : null)));
}
// multi-select dropdown: groups = [{name, items: [[value, label]]}]
export function multiSelect({ label, groups, selected, onChange, allText = "All" }) {
  const sel = new Set(selected);
  const btn = el("button", { class: "btn", type: "button" });
  const list = el("div", { class: "ms-list", hidden: true });
  const wrap = el("div", { class: "ms" }, btn, list);
  const text = () => { btn.textContent = label + ": " + (sel.size ? (sel.size === 1 ? groups.flatMap(g => g.items).find(([v]) => sel.has(v))?.[1] : sel.size + " selected") : allText) + " ▾"; };
  const render = () => {
    list.replaceChildren(
      el("div", { class: "controls", style: { justifyContent: "space-between", padding: "2px 4px 6px" } },
        el("button", { class: "linkbtn", type: "button", onclick: () => { sel.clear(); render(); onChange([...sel]); } }, "Clear"),
        el("button", { class: "linkbtn", type: "button", onclick: () => { list.hidden = true; } }, "Done")),
      ...groups.flatMap(g => [g.name ? el("div", { class: "ms-h" }, g.name) : null,
        ...g.items.map(([v, t]) => { const cb = el("input", { type: "checkbox" }); cb.checked = sel.has(v);
          cb.addEventListener("change", () => { cb.checked ? sel.add(v) : sel.delete(v); text(); onChange([...sel]); });
          return el("label", {}, cb, t); })]));
    text();
  };
  btn.addEventListener("click", e => { e.stopPropagation(); list.hidden = !list.hidden; });
  document.addEventListener("click", e => { if (!wrap.contains(e.target)) list.hidden = true; });
  render();
  return wrap;
}
export function scoreBadge(s) {
  const k = s >= 85 ? 4 : s >= 70 ? 3 : s >= 50 ? 2 : s >= 30 ? 1 : 0;
  return el("span", { class: "score s" + k, title: "Lead score " + s + " / 100" }, s);
}
export const SITE_STATES = {
  unchecked: ["Not checked yet", false], no_site: ["No website", true], error: ["Server not working", true], parked: ["Parked / for sale", true],
  coming_soon: ["Coming soon", true], placeholder: ["Placeholder page", true], redirect: ["Redirects elsewhere", false], live: ["Live website", false]
};
export function stateBadge(st, builder) {
  const [label, need] = SITE_STATES[st] || [st, false];
  return el("span", { class: "state" + (need ? " need" : st === "live" ? " live" : "") }, el("span", { class: "dot" }), label + (builder && st === "live" ? " · " + builder : ""));
}
export const CRM = [["new", "New"], ["contacted", "Contacted"], ["replied", "Replied"], ["meeting", "Meeting"], ["won", "Won"], ["lost", "Lost"]];
export const whoisLink = d => el("a", { href: "https://lookup.icann.org/en/lookup?name=" + encodeURIComponent(d), target: "_blank", rel: "noopener noreferrer", style: { fontSize: "12px" } }, "WHOIS");
