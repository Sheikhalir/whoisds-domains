// GUIDE tab + guided tours.
// - mount(host, ctx): the "Guide" tab: quick start, one card per feature (only the ones this user can use), glossary, FAQ.
// - startTour(ctx, name): spotlight walkthrough that switches tabs, highlights real elements and explains them.
//   Tours: "welcome" (first sign-in, all of the user's features), "niche", "leads", "research", "daily", "admin".
// Only shows features the user has access to (ctx.access). Never renders untrusted text with innerHTML.
import { el } from "./core.js";
import { rpc, logEvent } from "./api.js";

const LABEL = { niche: "Niche Finder", leads: "Leads", research: "Research", daily: "Daily Files", admin: "Admin", guide: "Guide" };

// ---------------------------------------------------------------------------------------------
// Tour steps. tab = which tab to open, sel = what to highlight (inside that tab's pane), place = popover side.
// A step whose element isn't on the page (e.g. no data yet) is shown in the middle of the screen instead.
// ---------------------------------------------------------------------------------------------
const P = id => `[data-pane="${id}"] `;
const STEPS = {
  niche: [
    { tab: "niche", sel: P("niche") + "#nf-range", title: "Pick the days", text: "Look at the latest day, the last 7 or 30 days, or everything stored. The dropdown next to it opens one exact day." },
    { tab: "niche", sel: P("niche") + "#nf-tiles", title: "The numbers at a glance", text: "How many new domains there are in your selection, how many fit a niche, and how that compares with before." },
    { tab: "niche", sel: P("niche") + "#nf-list", place: "right", title: "Choose niches", text: "Click one or more niches (Roofing, Plumbing, …). The counts follow your other filters. At the top, “+ Add” lets you add your own seed keywords, which are searched every day." },
    { tab: "niche", sel: P("niche") + "#nf-ext", title: "Narrow it down", text: "Extension (.com only is best for real businesses), location (a city or state in the name) and a search box filter the list." },
    { tab: "niche", sel: P("niche") + "#nf-views", title: "Results, favorites, discards", text: "Switch between the results and your ★ Favorites and ✕ Discarded lists. They're saved to your account on every device." },
    { tab: "niche", sel: P("niche") + "#nf-actions", title: "Export", text: "Download the list as CSV, one CSV per niche in a .zip, or copy it." },
  ],
  leads: [
    { tab: "leads", sel: P("leads") + "#ld-sub", title: "Four views", text: "All leads, My pipeline (your CRM), Follow-ups due (today and overdue) and Gap Finder (free domain names in busy markets)." },
    { tab: "leads", sel: P("leads") + "#ld-tiles", title: "Lead summary", text: "Hot leads (score 70+), domains that need a website (email set up but no real site), leads with contact details." },
    { tab: "leads", sel: P("leads") + "#ld-states", title: "Website status", text: "Every new domain is checked on day 0, 7, 14 and 30: no website, parked, coming soon, placeholder, live… Click a chip to filter." },
    { tab: "leads", sel: P("leads") + "#ld-table", place: "top", title: "Work your leads", text: "Hover the score to see why it's high. Set a Status (New → Contacted → Won) and a Follow-up date on any row, or open Details for contacts, owner info and notes." },
  ],
  research: [
    { tab: "research", sel: P("research") + "#rs-sub", title: "Momentum and Geography", text: "Momentum ranks niches by growth (this period vs the one before). Geography shows where new businesses are registering." },
    { tab: "research", sel: P("research") + "#rs-body", place: "top", title: "Find growing markets", text: "Sort by growth or volume, click a niche for its history, or click a US state on the map to see its cities and top niches." },
  ],
  daily: [
    { tab: "daily", sel: P("daily") + "#d-chart", title: "Every stored day", text: "New domains per day. Click a bar or a file in the list to open that day." },
    { tab: "daily", sel: P("daily") + "#dayselect", title: "Browse day by day", text: "Use ‹ Prev / Next › or pick a date." },
    { tab: "daily", sel: P("daily") + "#q", title: "Search the full list", text: "Contains, starts with, ends with or a regex, plus an extension filter. Searches every domain registered that day, not only niche ones." },
    { tab: "daily", sel: P("daily") + "#dltxt", title: "Download", text: "Download what you filtered as .txt, or the original WhoisDS .zip." },
  ],
  admin: [
    { tab: "admin", sel: P("admin") + "#ad-sub", title: "Admin tools", text: "Overview (usage analytics), Users, Invites, Activity log, Data & jobs and Settings." },
    { tab: "admin", sel: P("admin") + "#ad-body", place: "top", title: "Users and access", text: "In Users: approve requests, set an end date, disable people, set a temporary password, and use Access to lock or hide features for each person." },
  ],
};

function welcomeSteps(ctx) {
  const on = id => ctx.access(id) === "on";
  const name = (ctx.profile.full_name || ctx.profile.email.split("@")[0]).split(" ")[0];
  const steps = [{ title: "Welcome, " + name + " 👋", text: "This 1-minute tour shows you where everything is. You can skip it and restart it any time from the Guide tab or your menu (top right)." },
    { sel: "nav.tabs", title: "Your tabs", text: "Each tab is one tool. You only see the tools your admin has enabled for you." }];
  const pick = (id, i) => { const s = STEPS[id]?.[i]; if (s && on(id)) steps.push({ ...s, title: LABEL[id] + ": " + s.title }); };
  pick("niche", 2); pick("niche", 4); pick("leads", 0); pick("leads", 3); pick("research", 0); pick("daily", 2);
  if (ctx.isAdmin) pick("admin", 1);
  steps.push({ sel: ".usermenu .menu", title: "Your account", text: "Change your name or password and sign out here. “Quick tour” replays this tour." },
    { tab: "guide", sel: '[data-pane="guide"] .guide-features', place: "top", title: "Need more help?", text: "The Guide tab explains every feature step by step, with a short tour for each one. Have fun finding leads!" });
  return steps;
}

// ---------------------------------------------------------------------------------------------
// Tour engine
// ---------------------------------------------------------------------------------------------
let active = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(sel, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const n = sel && document.querySelector(sel);
    if (n && n.getClientRects().length && n.offsetParent !== null) return n;
    await sleep(120);
  }
  return null;
}

export function startTour(ctx, name = "welcome") {
  active?.end(false);
  const steps = name === "welcome" ? welcomeSteps(ctx) : (STEPS[name] || []).filter(s => !s.tab || ctx.access(s.tab) === "on" || (s.tab === "admin" && ctx.isAdmin));
  if (!steps.length) return;
  let i = 0, target = null, token = 0;
  const veil = el("div", { class: "tour-veil", onclick: () => end(false) });
  const ring = el("div", { class: "tour-ring" });
  const title = el("h3", { id: "tour-title" }), text = el("p"), count = el("span", { class: "muted num" });
  const back = el("button", { class: "btn small", onclick: () => go(i - 1) }, "Back");
  const next = el("button", { class: "btn small primary", onclick: () => go(i + 1) }, "Next");
  const pop = el("div", { class: "tour-pop", role: "dialog", "aria-modal": "true", "aria-labelledby": "tour-title" },
    el("button", { class: "tour-x", "aria-label": "Close tour", onclick: () => end(false) }, "✕"),
    title, text, el("div", { class: "tour-foot" }, count, el("span", { style: { flex: 1 } }),
      el("button", { class: "linkbtn", onclick: () => end(false) }, "Skip tour"), back, next));
  const root = el("div", { class: "tour" }, veil, ring, pop);
  document.body.append(root);
  const onKey = e => { if (e.key === "Escape") end(false); else if (e.key === "ArrowRight") go(i + 1); else if (e.key === "ArrowLeft" && i > 0) go(i - 1); };
  const onMove = () => place();
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onMove);
  window.addEventListener("scroll", onMove, true);

  function place() {
    const pad = 6, vw = innerWidth, vh = innerHeight;
    if (!target) {
      ring.hidden = true; veil.classList.add("dim");
      pop.style.left = Math.max(12, (vw - pop.offsetWidth) / 2) + "px"; pop.style.top = Math.max(12, (vh - pop.offsetHeight) / 2) + "px";
      return;
    }
    veil.classList.remove("dim"); ring.hidden = false;
    const r = target.getBoundingClientRect();
    const top = Math.max(4, r.top - pad), left = Math.max(4, r.left - pad);
    const h = Math.min(r.height + pad * 2, vh - top - 4), w = Math.min(r.width + pad * 2, vw - left - 4);
    Object.assign(ring.style, { top: top + "px", left: left + "px", width: w + "px", height: h + "px" });
    const pw = pop.offsetWidth, ph = pop.offsetHeight, gap = 12;
    const want = steps[i].place || "bottom";
    const fits = { bottom: top + h + gap + ph < vh, top: top - gap - ph > 0, right: left + w + gap + pw < vw };
    const side = fits[want] ? want : fits.bottom ? "bottom" : fits.top ? "top" : fits.right ? "right" : "inside";
    let x, y;
    if (side === "right") { x = left + w + gap; y = top; }
    else if (side === "top") { x = left; y = top - gap - ph; }
    else if (side === "bottom") { x = left; y = top + h + gap; }
    else { x = left + 16; y = top + 16; }
    pop.style.left = Math.min(Math.max(12, x), vw - pw - 12) + "px";
    pop.style.top = Math.min(Math.max(12, y), vh - ph - 12) + "px";
  }
  async function go(n) {
    if (n >= steps.length) return end(true);
    if (n < 0) return;
    const my = ++token; i = n;
    const s = steps[i];
    back.disabled = i === 0; next.textContent = i === steps.length - 1 ? "Done" : "Next";
    count.textContent = (i + 1) + " / " + steps.length;
    title.textContent = s.title; text.textContent = s.text;
    pop.classList.add("busy");
    if (s.tab && ctx.goto) await ctx.goto(s.tab);
    target = s.sel ? await waitFor(s.sel) : null;
    if (my !== token) return;
    if (target) { target.scrollIntoView({ block: "center", behavior: "instant" }); await sleep(30); }
    pop.classList.remove("busy");
    place();
    next.focus({ preventScroll: true });
  }
  function end(done) {
    if (!root.isConnected) return;
    token++; root.remove(); active = null;
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onMove);
    window.removeEventListener("scroll", onMove, true);
    logEvent(done ? "tour_done" : "tour_skipped", { tour: name, step: i + 1, of: steps.length });
    if (name === "welcome") markSeen(ctx);
  }
  active = { end };
  go(0);
}

function markSeen(ctx) {
  if (ctx.profile.tour_seen_at) return;
  ctx.profile.tour_seen_at = new Date().toISOString();
  try { localStorage.setItem("dr_tour_" + ctx.profile.id, "1"); } catch {}
  rpc("mark_tour_seen").catch(() => {});
}
export function shouldAutoStart(ctx) {
  if (ctx.profile.tour_seen_at) return false;
  try { if (localStorage.getItem("dr_tour_" + ctx.profile.id) || localStorage.getItem("dr_no_tour")) return false; } catch {}   // dr_no_tour: automated tests
  return true;
}

// ---------------------------------------------------------------------------------------------
// Guide tab
// ---------------------------------------------------------------------------------------------
const FEATURES = [
  { id: "niche", icon: "🧭", what: "See every new domain registered in the last days, sorted into business niches (roofing, plumbing, dental…).",
    how: ["Pick a date range at the top (Latest day, 7 days, 30 days).", "Click one or more niches on the left.", "Filter by extension (.com only), location or a search word.",
      "★ the domains you like, ✕ the ones you don't. They're saved to your account.", "Export CSV or one file per niche (.zip)."],
    tip: "Add your own seed keywords (+ Add at the top of the niche list) to track any word every day, e.g. “Chimney: chimney, flue”." },
  { id: "leads", icon: "🎯", what: "New businesses checked automatically: do they have a website, email, phone? Each one gets a 0–100 lead score.",
    how: ["Start with All leads, sorted by score. 70+ is hot.", "Click a website-status chip, e.g. “No website”, to find businesses that need a site.",
      "Open Details to see contacts, the owner and the score reasons.", "Set a Status and a Follow-up date to track your outreach.",
      "Check My pipeline and Follow-ups due every day."],
    tip: "“Need a website” = email set up but no real site yet: the best web-design leads. Gap Finder suggests free .com names in busy niche + city markets." },
  { id: "research", icon: "📈", what: "Which niches are growing, and where new businesses are opening.",
    how: ["Momentum: compare this period with the one before, sorted by growth.", "Click a niche to see its full history.",
      "Geography: click a US state on the map for its cities and top niches."],
    tip: "Growing niches mean more new businesses needing websites and marketing, but also more competition." },
  { id: "daily", icon: "🗂️", what: "The complete list of every domain registered each day, not only the niche ones.",
    how: ["Pick a day in the chart, the file list or the date picker.", "Search with Contains, Starts with, Ends with or a regex.", "Download your filtered list (.txt) or the original .zip."],
    tip: "Use Ends with + an extension filter to find patterns like every new “…roofing.com”." },
];
const GLOSSARY = [
  ["Lead score", "0–100 points: niche value, .com, city in the name, email set up, no real site yet, contacts found. 70+ = hot."],
  ["Email set up (MX)", "The domain can receive email, a strong sign of a real business."],
  ["Website status", "No website · Server not working · Parked / for sale · Coming soon · Placeholder · Live website · Redirects elsewhere."],
  ["Seed keywords", "Your own words, searched in every new domain every day. Use “-word” to exclude names containing it."],
  ["Pipeline", "Your private CRM: New → Contacted → Replied → Meeting → Won / Lost, with follow-up dates and notes."],
];
const FAQ = [
  ["How often is the data updated?", "Every 3 hours, automatically. The time of the last update is shown at the top right."],
  ["Can other users see my favorites, notes or pipeline?", "No. They belong to your account only. Admins see counts, not your lists."],
  ["A tab is missing or shows a 🔒", "Your admin decides which tools you can use. Ask them to unlock it."],
  ["Is it safe to visit these domains?", "New domains can be unsafe. Don't download anything from them, and follow anti-spam rules (CAN-SPAM, GDPR) when contacting people."],
  ["I forgot my password", "Ask your admin for a temporary password. You'll choose your own at the next sign-in."],
];

export function mount(host, ctx) {
  const access = ctx.access;
  const open = FEATURES.filter(f => access(f.id) === "on");
  const locked = FEATURES.filter(f => access(f.id) === "locked");
  const name = (ctx.profile.full_name || ctx.profile.email.split("@")[0]).split(" ")[0];
  const goBtn = (id, label = "Open " + LABEL[id] + " →") => el("button", { class: "btn small", onclick: () => ctx.goto(id) }, label);
  const tourBtn = id => el("button", { class: "btn small primary", onclick: () => startTour(ctx, id) }, "▶ Show me around");

  const steps = [];
  if (access("niche") === "on") steps.push(["Find a niche", "Open Niche Finder, choose “7 days” and click a niche you sell to.", "niche"]);
  if (access("niche") === "on") steps.push(["Save what you like", "Click ★ on interesting domains, or add your own seed keywords.", "niche"]);
  if (access("leads") === "on") steps.push(["Pick hot leads", "In Leads, filter “No website” and sort by score.", "leads"]);
  if (access("leads") === "on") steps.push(["Track outreach", "Set a Status and a Follow-up date. Check “Follow-ups due” daily.", "leads"]);
  if (access("research") === "on") steps.push(["Spot trends", "Use Research → Momentum to see which niches are growing.", "research"]);
  if (access("daily") === "on" && steps.length < 4) steps.push(["Search everything", "Daily Files searches every domain registered on a day.", "daily"]);

  host.replaceChildren(el("div", { class: "guide" },
    el("section", { class: "card guide-hero" },
      el("div", {},
        el("h2", {}, "Welcome to " + (ctx.settings?.site_title || "Domain Radar") + ", " + name),
        el("p", { class: "sub" }, "Every day thousands of new domains are registered, often by brand-new businesses. This tool sorts them into niches, ",
          "checks which ones need a website and helps you contact them first."),
        el("div", { class: "controls" },
          el("button", { class: "btn primary", onclick: () => startTour(ctx, "welcome") }, "▶ Take the 1-minute tour"),
          open[0] ? goBtn(open[0].id, "Skip to " + LABEL[open[0].id] + " →") : null)),
      steps.length ? el("ol", { class: "guide-steps" }, ...steps.slice(0, 4).map(([t, d, id]) =>
        el("li", {}, el("b", {}, t), el("span", { class: "sub" }, d), el("button", { class: "linkbtn", onclick: () => ctx.goto(id) }, "Go →")))) : null),

    !open.length ? el("div", { class: "card msg" }, "Your admin hasn't enabled any tools for your account yet. Ask them for access.") : null,

    el("div", { class: "guide-features" }, ...open.map(f => el("section", { class: "card guide-card" },
      el("div", { class: "card-head" }, el("h2", {}, el("span", { "aria-hidden": "true" }, f.icon + " "), LABEL[f.id]), el("div", { class: "controls" }, tourBtn(f.id), goBtn(f.id, "Open →"))),
      el("p", { class: "sub", style: { marginTop: 0 } }, f.what),
      el("ol", { class: "guide-how" }, ...f.how.map(h => el("li", {}, h))),
      el("div", { class: "guide-tip" }, el("b", {}, "Tip: "), f.tip)))),

    locked.length ? el("section", { class: "card", style: { marginTop: "12px" } },
      el("h2", {}, "🔒 Locked for your account"),
      el("p", { class: "sub" }, locked.map(f => LABEL[f.id]).join(", ") + ". Ask your admin if you need " + (locked.length > 1 ? "them" : "it") + ".")) : null,

    ctx.isAdmin ? el("section", { class: "card guide-card", style: { marginTop: "12px" } },
      el("div", { class: "card-head" }, el("h2", {}, "🛡️ For admins"), el("div", { class: "controls" }, tourBtn("admin"), goBtn("admin", "Open →"))),
      el("ol", { class: "guide-how" },
        el("li", {}, "Invite people in Admin → Invites (they get in instantly), or approve requests in Users."),
        el("li", {}, "Use Users → Access to lock or hide Niche Finder, Leads, Research or Daily Files per person."),
        el("li", {}, "Set an access end date for trials. Disable people you no longer work with."),
        el("li", {}, "Overview shows who uses what. Data & jobs shows the 3-hourly update job.")),
      el("div", { class: "guide-tip" }, el("b", {}, "Tip: "), "New users get the 1-minute tour automatically the first time they sign in.")) : null,

    el("div", { class: "grid-2", style: { marginTop: "12px" } },
      el("section", { class: "card" }, el("h2", {}, "Words you'll see"),
        el("dl", { class: "kv guide-kv" }, ...GLOSSARY.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]))),
      el("section", { class: "card" }, el("h2", {}, "Questions"),
        ...FAQ.map(([q, a]) => el("details", { class: "guide-faq" }, el("summary", {}, q), el("p", { class: "sub" }, a)))))));
  return { show() {}, redraw() {} };
}

export function helpButton(ctx, current) {
  const menu = el("div", { class: "menu-list help-menu", hidden: true });
  const btn = el("button", { class: "help-fab", "aria-label": "Help", title: "Help", onclick: e => {
    e.stopPropagation();
    const id = current();
    const has = STEPS[id] && (ctx.access(id) === "on" || (id === "admin" && ctx.isAdmin));
    menu.replaceChildren(
      has ? el("button", { onclick: () => { menu.hidden = true; startTour(ctx, id); } }, "▶ Tour this page (" + LABEL[id] + ")") : null,
      el("button", { onclick: () => { menu.hidden = true; startTour(ctx, "welcome"); } }, "▶ Quick tour of everything"),
      el("button", { onclick: () => { menu.hidden = true; ctx.goto("guide"); } }, "📘 Open the Guide"));
    menu.hidden = !menu.hidden;
  } }, "?");
  document.addEventListener("click", e => { if (!menu.contains(e.target) && e.target !== btn) menu.hidden = true; });
  return el("div", { class: "help-wrap" }, menu, btn);
}

