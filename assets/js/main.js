// App entry point: login routing + app shell (header, tabs, user menu).
// Each tab is a module with mount(host, ctx) -> { show(opts), redraw() } and is built on first visit.
import { el, $, $$, debounce, makeLocator, openDialog, toast, errText } from "./core.js";
import { sb, configured, rpc, logEvent, storageFile, Lists, Seeds } from "./api.js";
import * as Auth from "./auth-ui.js";

const TABS = [
  ["niche", "Niche Finder", () => import("./niche.js")],
  ["leads", "Leads", () => import("./leads.js")],
  ["research", "Research", () => import("./research.js")],
  ["daily", "Daily Files", () => import("./daily.js")],
  ["admin", "Admin", () => import("./admin.js")],
];
const root = $("#app");
let settings = null, builtFor = null, recovering = false;

async function boot() {
  if (!configured) return Auth.notConfigured(root);
  try { settings = await rpc("get_public_settings"); } catch (e) { console.warn("settings", e); settings = null; }
  if (settings?.site_title) document.title = settings.site_title;
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") recovering = true;
    if (event === "TOKEN_REFRESHED" || (event === "USER_UPDATED" && !recovering)) return;
    setTimeout(() => route(session), 0);   // don't call Supabase inside the auth callback
  });
}

async function route(session) {
  if (!session) {
    builtFor = null;
    const m = location.hash.match(/^#signup(?:\?email=([^&]+))?/);
    return Auth.loginScreen(root, settings, m ? { initialTab: "signup", prefillEmail: decodeURIComponent(m[1] || "") } : {});
  }
  let profile;
  try { profile = await rpc("my_profile"); } catch (e) { profile = null; console.error(e); }
  if (!profile) return Auth.noProfileScreen(root, session.user.email);
  if (recovering) {
    return Auth.changePasswordScreen(root, profile, { reason: "Set a new password for " + profile.email + ".", onDone: () => { recovering = false; route(session); } });
  }
  if (profile.status === "pending") return Auth.waitingScreen(root, profile, () => route(session));
  if (!profile.is_active) return Auth.blockedScreen(root, profile);
  if (profile.must_change_password) {
    return Auth.changePasswordScreen(root, profile, { reason: "The admin set a temporary password for you. Choose your own to continue.", onDone: () => route(session) });
  }
  if (sessionStorage.getItem("dr_fresh_login")) { sessionStorage.removeItem("dr_fresh_login"); logEvent("login", {}); }
  if (builtFor === profile.id) return;
  builtFor = profile.id;
  if (location.hash.startsWith("#signup")) history.replaceState(null, "", location.pathname);
  await buildApp(profile);
}

async function buildApp(profile) {
  root.replaceChildren(el("div", { class: "boot" }, "Loading your dashboard…"));
  const isAdmin = profile.role === "admin";
  // feature access set by the admin (Admin → Users → Edit): "on" | "locked" (tab shown with a lock) | "hidden" (no tab).
  // The database enforces the same rules (has_feature), so this only decides what to show.
  const access = id => id === "admin" ? (isAdmin ? "on" : "hidden") : isAdmin ? "on" : ({ hidden: "hidden", locked: "locked" }[profile.features?.[id]] || "on");
  const ctx = { profile, isAdmin, access, settings, meta: new Map(), index: null, indexError: null, cfg: { niches: [], locations: [] } };
  const [cfg, index] = await Promise.all([
    fetch("niches.json?t=" + Date.now()).then(r => r.json()).catch(() => ({ niches: [], locations: [] })),
    storageFile("index.json").catch(e => { ctx.indexError = e; return null; }),
    Lists.load().catch(e => toast("Couldn't load your lists: " + errText(e))),
    Seeds.load().catch(e => toast("Couldn't load your seeds: " + errText(e))),
  ]);
  ctx.cfg = cfg;
  cfg.niches.forEach(n => ctx.meta.set(n.id, { name: n.name, group: n.group, value: n.value }));
  ctx.meta.set("seed", { name: "Seed match", group: "My seed keywords" });
  ctx.locate = makeLocator(cfg);
  ctx.index = index;
  ctx.days = (index?.days || []).slice().sort((a, b) => a.date.localeCompare(b.date));

  const tabs = TABS.filter(([id]) => access(id) !== "hidden");
  const panes = {}, mods = {};
  let current = null;
  const nav = el("nav", { class: "tabs", role: "tablist" }, ...tabs.map(([id, label]) =>
    el("button", { role: "tab", "data-tab": id, "aria-selected": "false", class: access(id) === "locked" ? "locked" : null,
      title: access(id) === "locked" ? "Your admin has locked this feature for your account" : null, onclick: () => show(id) },
      access(id) === "locked" ? "🔒 " : null, label)));
  const initials = (profile.full_name || profile.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join("");
  const menuList = el("div", { class: "menu-list", hidden: true },
    el("div", { class: "who" }, el("b", {}, profile.full_name || profile.email), el("br"), profile.email, el("br"),
      profile.role === "admin" ? "Admin" : "User", profile.expires_at ? " · access until " + new Date(profile.expires_at).toLocaleDateString() : ""),
    el("div", { class: "sep" }),
    el("button", { onclick: () => { menuList.hidden = true; editName(profile); } }, "Change my name"),
    el("button", { onclick: () => { menuList.hidden = true; changePassword(); } }, "Change password"),
    el("div", { class: "sep" }),
    el("button", { onclick: () => sb.auth.signOut() }, "Sign out"));
  const menu = el("div", { class: "menu" }, el("button", { class: "btn", onclick: e => { e.stopPropagation(); menuList.hidden = !menuList.hidden; } },
    el("span", { class: "avatar" }, initials), profile.full_name || profile.email.split("@")[0], " ▾"), menuList);
  document.addEventListener("click", e => { if (!menu.contains(e.target)) menuList.hidden = true; });
  const updated = el("span", { class: "sub" }, index?.updated ? "Data updated " + new Date(index.updated).toLocaleString() : "");

  root.replaceChildren(el("div", { class: "wrap" },
    el("header", { class: "topbar" },
      el("div", { class: "brand" }, el("div", { class: "logo" }, "DR"),
        el("div", {}, el("h1", {}, settings?.site_title || "Domain Radar"), el("div", { class: "sub" }, "New domains → niches, leads and research"))),
      el("div", { class: "usermenu" }, updated, menu)),
    tabs.length ? nav : el("div", { class: "card msg" }, el("b", {}, "No features are enabled for your account yet."), el("br"),
      "Ask your admin to give you access to Niche Finder, Leads, Research or Daily Files."),
    ...tabs.map(([id]) => (panes[id] = el("div", { "data-pane": id, hidden: true })))));

  async function show(id, opts) {
    if (!tabs.length) return;
    if (!panes[id]) id = (tabs.find(([t]) => access(t) === "on") || tabs[0])[0];
    current = id;
    $$(".tabs button", root).forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === id)));
    Object.entries(panes).forEach(([k, p]) => p.hidden = k !== id);
    if (access(id) === "locked") {
      const label = TABS.find(t => t[0] === id)[1];
      panes[id].replaceChildren(el("section", { class: "card locked-pane" }, el("div", { class: "lock-icon", "aria-hidden": "true" }, "🔒"),
        el("h2", {}, label + " is locked for your account"),
        el("p", { class: "sub" }, "Your admin hasn't given you access to this feature. Ask them to unlock it in Admin → Users.")));
      if (location.hash.slice(1).split("/")[0] !== id) history.replaceState(null, "", "#" + id);
      return;
    }
    if (!mods[id]) {
      panes[id].replaceChildren(el("div", { class: "boot" }, "Loading…"));
      try {
        const mod = await TABS.find(t => t[0] === id)[2]();
        panes[id].replaceChildren();
        mods[id] = mod.mount(panes[id], ctx);
      } catch (e) {
        console.error(e);
        panes[id].replaceChildren(el("div", { class: "card msg err" }, "This tab failed to load: " + errText(e)));
        return;
      }
    }
    mods[id].show?.(opts);
    logEvent("view", { tab: id });
    if (location.hash.slice(1).split("/")[0] !== id) history.replaceState(null, "", "#" + id);
  }
  ctx.goto = show;
  window.addEventListener("resize", debounce(() => mods[current]?.redraw?.(), 120));
  const start = location.hash.slice(1).split("/")[0];
  show(tabs.some(t => t[0] === start) ? start : null);
}

function changePassword() {
  openDialog(close => {
    const p1 = el("input", { type: "password", minlength: 8, required: true, autocomplete: "new-password" });
    const p2 = el("input", { type: "password", minlength: 8, required: true, autocomplete: "new-password" });
    const msg = el("div", { class: "hint err" });
    return el("form", { class: "dlg", onsubmit: async e => {
        e.preventDefault();
        if (p1.value.length < 8) return msg.textContent = "Use at least 8 characters.";
        if (p1.value !== p2.value) return msg.textContent = "The two passwords don't match.";
        const { error } = await sb.auth.updateUser({ password: p1.value });
        if (error) return msg.textContent = errText(error);
        logEvent("password_changed_self"); close(); toast("Password changed.");
      } },
      el("h2", {}, "Change password"),
      el("label", { class: "field" }, "New password", p1), el("label", { class: "field" }, "Repeat new password", p2), msg,
      el("div", { class: "dlg-actions" }, el("span", { style: { flex: 1 } }), el("button", { type: "button", class: "btn", onclick: close }, "Cancel"),
        el("button", { type: "submit", class: "btn primary" }, "Save")));
  });
}

function editName(profile) {
  openDialog(close => {
    const n = el("input", { type: "text", value: profile.full_name || "", maxlength: 120 });
    return el("form", { class: "dlg", onsubmit: async e => {
        e.preventDefault();
        try { await rpc("update_my_profile", { p_full_name: n.value }); profile.full_name = n.value; close(); toast("Saved. Reload to see it everywhere."); }
        catch (err) { toast(errText(err)); }
      } },
      el("h2", {}, "Your name"), el("label", { class: "field" }, "Name shown to the admin", n),
      el("div", { class: "dlg-actions" }, el("span", { style: { flex: 1 } }), el("button", { type: "button", class: "btn", onclick: close }, "Cancel"),
        el("button", { type: "submit", class: "btn primary" }, "Save")));
  });
}

boot();
