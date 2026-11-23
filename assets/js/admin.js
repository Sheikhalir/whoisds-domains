// ADMIN tab (admins only - the database also refuses these calls for non-admins):
// Overview analytics, Users, Invites, Activity log, Data & jobs, Settings.
import { el, $, $$, fmt, kb, ago, dateTime, shortDate, isoDay, addDays, tile, seg, subtabs, drawBars, csv, download, copyText, toast, errText,
         openDialog, confirmDialog, store, SITE_STATES } from "./core.js";
import { rpc, logEvent } from "./api.js";

const ACTIONS = {
  login: "Signed in", view: "Opened a tab", signup: "Created account", niche_select: "Selected niches", export_csv: "Exported CSV", export_zip: "Exported zip",
  export_txt: "Exported .txt", seeds_saved: "Saved seed keywords", lead_open: "Opened a lead", password_changed: "Chose password after reset", password_changed_self: "Changed own password",
  admin_update_user: "Admin: changed a user", admin_set_password: "Admin: set a password", admin_delete_user: "Admin: deleted a user", admin_invite: "Admin: invited",
  admin_revoke_invite: "Admin: revoked invite", admin_update_settings: "Admin: changed settings", tour_done: "Finished a tour", tour_skipped: "Skipped a tour"
};
const TAB_NAMES = { niche: "Niche Finder", leads: "Leads", research: "Research", daily: "Daily Files", admin: "Admin", guide: "Guide", "leads:leads": "Leads › All leads",
  "leads:pipeline": "Leads › Pipeline", "leads:followups": "Leads › Follow-ups", "leads:gaps": "Leads › Gap Finder", "research:momentum": "Research › Momentum", "research:geo": "Research › Geography" };
const statusOf = u => u.status === "active" && u.is_expired ? "expired" : u.status;

// ---------- feature access (per user; enforced by the database too) ----------
const FEATURES = [["niche", "Niche Finder"], ["leads", "Leads"], ["research", "Research"], ["daily", "Daily Files"]];
const ACCESS = [["on", "Allowed"], ["locked", "Locked: tab shows a lock"], ["hidden", "Hidden: no tab"]];
const cleanFeatures = f => Object.fromEntries(Object.entries(f || {}).filter(([k, v]) => FEATURES.some(x => x[0] === k) && (v === "locked" || v === "hidden")));
// per-feature dropdowns; value() returns {feature: "locked"|"hidden"} for restricted features only
function featureEditor(current, { disabled = false, note } = {}) {
  const sels = FEATURES.map(([id, label]) => {
    const sel = el("select", { disabled, "data-feature": id }, ...ACCESS.map(([v, t]) => el("option", { value: v, selected: (current?.[id] || "on") === v }, t)));
    return el("label", { class: "field" }, label, sel);
  });
  const all = v => () => sels.forEach(l => { const s = l.querySelector("select"); if (!s.disabled) s.value = v; });
  const node = el("div", { class: "field full" }, "Feature access",
    note ? el("div", { class: "hint", style: { margin: 0 } }, note) : null,
    el("div", { class: "form-grid" }, ...sels),
    disabled ? null : el("div", { class: "controls" },
      el("button", { type: "button", class: "btn small", onclick: all("on") }, "Allow all"),
      el("button", { type: "button", class: "btn small", onclick: all("locked") }, "Lock all"),
      el("button", { type: "button", class: "btn small", onclick: all("hidden") }, "Hide all")));
  return { node, value: () => cleanFeatures(Object.fromEntries(sels.map(l => { const s = l.querySelector("select"); return [s.dataset.feature, s.value]; }))) };
}
function accessBadges(features, isAdmin) {
  if (isAdmin) return el("span", { class: "muted" }, "Full (admin)");
  const f = cleanFeatures(features), keys = FEATURES.filter(([id]) => f[id]);
  if (!keys.length) return el("span", { class: "muted" }, "All features");
  return el("div", { class: "access-badges" }, ...keys.map(([id, label]) =>
    el("span", { class: "badge " + (f[id] === "hidden" ? "bad" : "warn"), title: f[id] === "hidden" ? "Hidden: no tab" : "Locked: tab shows a lock" },
      (f[id] === "hidden" ? "Hidden: " : "🔒 ") + label)));
}
const accessText = (features, isAdmin) => isAdmin ? "full" : FEATURES.filter(([id]) => cleanFeatures(features)[id]).map(([id, l]) => l + " " + cleanFeatures(features)[id]).join("; ") || "all";
const STATUS_BADGE = { active: ["Active", "ok"], pending: ["Pending", "warn"], disabled: ["Disabled", "bad"], expired: ["Expired", "bad"] };

export function mount(host, ctx) {
  if (!ctx.isAdmin) { host.replaceChildren(el("div", { class: "card msg err" }, "Admins only.")); return { show() {} }; }
  const S = Object.assign({ sub: "overview", uFilter: "all", uq: "", actUser: "", actAction: "" }, store.get("dr_admin", {}));
  const save = () => store.set("dr_admin", S);
  let users = [], stats = null;
  host.replaceChildren(el("div", { id: "ad-sub" }), el("div", { id: "ad-body" }));

  function drawSub() {
    const pending = users.filter(u => u.status === "pending").length;
    $("#ad-sub", host).replaceChildren(subtabs([["overview", "Overview"], ["users", "Users", users.length || null], ["invites", "Invites"],
      ["activity", "Activity log"], ["data", "Data & jobs"], ["settings", "Settings"]], S.sub, v => { S.sub = v; save(); build(); }));
    if (pending) $("#ad-sub", host).append(el("div", { class: "warn", style: { borderColor: "var(--warn)" } },
      el("b", { style: { color: "var(--warn)" } }, fmt(pending) + " access request" + (pending > 1 ? "s" : "") + " waiting. "),
      el("button", { class: "linkbtn", onclick: () => { S.sub = "users"; S.uFilter = "pending"; save(); build(); } }, "Review now →")));
  }
  async function loadUsers() { users = (await rpc("admin_list_users")) || []; }
  async function build() {
    const body = $("#ad-body", host);
    body.replaceChildren(el("div", { class: "msg" }, "Loading…"));
    try {
      await loadUsers(); drawSub();
      if (S.sub === "overview") await overview(body);
      else if (S.sub === "users") usersView(body);
      else if (S.sub === "invites") await invitesView(body);
      else if (S.sub === "activity") await activityView(body);
      else if (S.sub === "data") await dataView(body);
      else await settingsView(body);
    } catch (e) { body.replaceChildren(el("div", { class: "card msg err" }, errText(e))); }
  }

  // ---------------- Overview ----------------
  async function overview(body) {
    stats = await rpc("admin_stats", { p_days: 30 });
    const u = stats.users, byDay = stats.by_day || [], d = stats.data || {};
    const logins = byDay.reduce((a, x) => a + x.logins, 0), exports = byDay.reduce((a, x) => a + x.exports, 0);
    const barList = (items, label, val, max = Math.max(1, ...items.map(val))) => items.length ? el("div", { class: "bar-list" }, ...items.map(it =>
      el("div", { class: "bl" }, el("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label(it)),
        el("div", { class: "track" }, el("div", { class: "fill", style: { width: (val(it) / max * 100) + "%" } })), el("span", { class: "num cnt" }, fmt(val(it)))))) : el("div", { class: "empty" }, "No data yet");
    const dau = el("div", { class: "chart", style: { height: "180px" } }), lg = el("div", { class: "chart", style: { height: "180px" } });
    const job = stats.last_job;
    const alerts = [];
    if (u.pending) alerts.push(el("div", {}, "• ", fmt(u.pending), " pending access request(s). ", el("button", { class: "linkbtn", onclick: () => { S.sub = "users"; S.uFilter = "pending"; save(); build(); } }, "Review")));
    if (u.expiring_7d) alerts.push(el("div", {}, "• ", fmt(u.expiring_7d), " user(s) lose access within 7 days."));
    if (job?.status === "error") alerts.push(el("div", {}, "• The last daily job failed: ", el("code", {}, (job.error || "").slice(0, 160))));
    if (job && Date.now() - new Date(job.started_at).getTime() > 8 * 3600e3) alerts.push(el("div", {}, "• The daily job hasn't run for " + ago(job.started_at).replace(" ago", "") + ". Check GitHub → Actions."));
    if (!job) alerts.push(el("div", {}, "• The daily job has never run. Open GitHub → Actions → Daily job → Run workflow."));
    body.replaceChildren(
      alerts.length ? el("div", { class: "warn", style: { borderColor: "var(--warn)" } }, el("b", { style: { color: "var(--warn)" } }, "Needs attention"), ...alerts) : null,
      el("div", { class: "tiles" },
        tile("Users", fmt(u.total), fmt(u.active) + " active · " + fmt(u.pending) + " pending · " + fmt(u.disabled + u.expired) + " blocked"),
        tile("Active today", fmt(stats.active_1d), fmt(stats.active_7d) + " this week · " + fmt(stats.active_30d) + " this month"),
        tile("Sign-ins (30 days)", fmt(logins), fmt(u.new_in_period) + " new accounts"),
        tile("Exports (30 days)", fmt(exports), fmt(stats.exports) + " rows downloaded")),
      el("div", { class: "grid-2" },
        el("section", { class: "card" }, el("div", { class: "card-head" }, el("h2", {}, "Active users per day")), dau),
        el("section", { class: "card" }, el("div", { class: "card-head" }, el("h2", {}, "Sign-ins per day")), lg)),
      el("div", { class: "grid-3", style: { marginTop: "12px" } },
        el("section", { class: "card" }, el("div", { class: "card-head" }, el("h2", {}, "Most active users"), el("span", { class: "muted" }, "30 days")),
          barList(stats.top_users || [], x => x.email, x => x.n)),
        el("section", { class: "card" }, el("div", { class: "card-head" }, el("h2", {}, "Most used tabs")),
          barList((stats.tabs || []).filter(x => x.tab), x => TAB_NAMES[x.tab] || x.tab, x => x.n)),
        el("section", { class: "card" }, el("div", { class: "card-head" }, el("h2", {}, "Most researched niches")),
          barList(stats.niches || [], x => ctx.meta.get(x.niche)?.name || x.niche, x => x.n))),
      el("div", { class: "grid-3", style: { marginTop: "12px" } },
        el("section", { class: "card" }, el("div", { class: "card-head" }, el("h2", {}, "What people do"), el("span", { class: "muted" }, "30 days")),
          barList((stats.actions || []).slice(0, 10), x => ACTIONS[x.action] || x.action, x => x.n)),
        el("section", { class: "card" }, el("div", { class: "card-head" }, el("h2", {}, "Leads by website status")),
          barList(Object.entries(d.by_site_state || {}).sort((a, b) => b[1] - a[1]), ([k]) => SITE_STATES[k]?.[0] || k, ([, v]) => v)),
        el("section", { class: "card" }, el("div", { class: "card-head" }, el("h2", {}, "Data")),
          el("dl", { class: "kv" }, ...[["Leads stored", fmt(d.leads)], ["Checked", fmt(d.leads_checked)], ["Hot (70+)", fmt(d.leads_hot)], ["Gap ideas available", fmt(d.gaps_available)],
            ["Seed groups", fmt(d.seeds) + " (" + fmt(d.seed_hits) + " matches)"], ["Favorites / pipeline", fmt(d.favorites) + " / " + fmt(d.pipeline)],
            ["Database size", kb(d.db_bytes) + " of 500 MB free tier"], ["File storage", kb(d.storage_bytes) + " in " + fmt(d.storage_files) + " files (1 GB free)"],
            ["Last daily job", job ? el("span", {}, el("span", { class: "badge " + (job.status === "ok" ? "ok" : job.status === "error" ? "bad" : "warn") }, job.status), " " + ago(job.started_at)) : "never"]]
            .flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])))));
    requestAnimationFrame(() => {
      drawBars(dau, byDay.map(x => ({ key: x.date, value: x.users })), { unit: "active users" });
      drawBars(lg, byDay.map(x => ({ key: x.date, value: x.logins })), { unit: "sign-ins" });
    });
  }

  // ---------------- Users ----------------
  function usersView(body) {
    const counts = { all: users.length, pending: 0, active: 0, expired: 0, disabled: 0, admin: 0 };
    users.forEach(u => { counts[statusOf(u)]++; if (u.role === "admin") counts.admin++; });
    const filterOk = u => S.uFilter === "all" || (S.uFilter === "admin" ? u.role === "admin" : statusOf(u) === S.uFilter);
    const qOk = u => !S.uq || (u.email + " " + (u.full_name || "") + " " + (u.notes || "")).toLowerCase().includes(S.uq);
    const list = users.filter(u => filterOk(u) && qOk(u));
    const tb = el("tbody");
    for (const u of list) {
      const st = statusOf(u), [lbl, cls] = STATUS_BADGE[st];
      const me = u.id === ctx.profile.id;
      tb.append(el("tr", {},
        el("td", {}, el("b", {}, u.full_name || u.email.split("@")[0]), me ? el("span", { class: "badge blue", style: { marginLeft: "6px" } }, "you") : null,
          el("div", { class: "muted", style: { fontSize: "12px" } }, u.email), u.notes ? el("div", { class: "hint", style: { margin: 0 } }, u.notes.slice(0, 80)) : null),
        el("td", {}, u.role === "admin" ? el("span", { class: "badge blue" }, "Admin") : "User"),
        el("td", {}, el("span", { class: "badge " + cls }, lbl)),
        el("td", {}, accessBadges(u.features, u.role === "admin")),
        el("td", { class: "num" }, u.expires_at ? el("span", { class: u.is_expired ? "delta down" : "" }, shortDate(u.expires_at)) : el("span", { class: "muted" }, "never")),
        el("td", { class: "muted" }, ago(u.last_seen_at)),
        el("td", { class: "r num" }, fmt(u.logins_30d)), el("td", { class: "r num" }, fmt(u.events_30d)), el("td", { class: "r num" }, fmt(u.exports_30d)),
        el("td", { class: "r num" }, fmt(u.favorites)), el("td", { class: "r num" }, fmt(u.pipeline)), el("td", { class: "r num" }, fmt(u.seeds)),
        el("td", { class: "muted num" }, shortDate(u.created_at)),
        el("td", {}, el("div", { class: "row-actions" },
          u.status === "pending" ? el("button", { class: "btn small primary", onclick: () => approve(u) }, "Approve") : null,
          u.status === "pending" ? el("button", { class: "btn small", onclick: () => update(u, { status: "disabled" }, "Request declined") }, "Decline") : null,
          el("button", { class: "btn small", onclick: () => editUser(u) }, "Edit"),
          u.role !== "admin" ? el("button", { class: "btn small", onclick: () => editAccess(u) }, "Access") : null,
          !me && u.status === "active" ? el("button", { class: "btn small", onclick: () => update(u, { status: "disabled" }, "Disabled " + u.email) }, "Disable") : null,
          !me && u.status === "disabled" ? el("button", { class: "btn small", onclick: () => update(u, { status: "active" }, "Enabled " + u.email) }, "Enable") : null,
          el("button", { class: "btn small", onclick: () => setPassword(u) }, "Password"),
          el("button", { class: "btn small", onclick: () => { S.sub = "activity"; S.actUser = u.id; save(); build(); } }, "Activity"),
          !me ? el("button", { class: "btn small", style: { color: "var(--critical)" }, onclick: () => del(u) }, "Delete") : null))));
    }
    body.replaceChildren(
      el("div", { class: "filters" },
        el("div", { class: "pills" }, ...[["all", "All"], ["pending", "Pending"], ["active", "Active"], ["expired", "Expired"], ["disabled", "Disabled"], ["admin", "Admins"]].map(([v, t]) =>
          el("button", { "aria-pressed": String(S.uFilter === v), onclick: () => { S.uFilter = v; save(); usersView(body); } }, t, el("span", { class: "n" }, fmt(counts[v]))))),
        el("div", { style: { flex: 1, minWidth: "200px" } }, el("input", { type: "search", placeholder: "Search name, email, notes…", value: S.uq,
          oninput: e => { S.uq = e.target.value.trim().toLowerCase(); usersView(body); $("input[type=search]", body).focus(); } })),
        el("button", { class: "btn primary", onclick: () => { S.sub = "invites"; save(); build(); } }, "+ Invite users"),
        el("button", { class: "btn", onclick: () => download("users_" + isoDay() + ".csv", csv(["email", "name", "role", "status", "features", "access_until", "last_seen", "logins_30d", "events_30d", "exports_30d", "favorites", "pipeline", "seeds", "joined", "notes"],
          users.map(u => [u.email, u.full_name, u.role, statusOf(u), accessText(u.features, u.role === "admin"), u.expires_at, u.last_seen_at, u.logins_30d, u.events_30d, u.exports_30d, u.favorites, u.pipeline, u.seeds, u.created_at, u.notes])), "text/csv") }, "Export CSV")),
      el("section", { class: "card" }, list.length ? el("div", { class: "tbl-wrap" }, el("table", { class: "data" },
        el("thead", {}, el("tr", {}, ...["User", "Role", "Status", "Features", "Access until", "Last seen", "Sign-ins 30d", "Actions 30d", "Exports 30d", "★", "Pipeline", "Seeds", "Joined", ""].map((h, i) =>
          el("th", { class: i >= 6 && i <= 11 ? "r" : "" }, h)))), tb)) : el("div", { class: "empty" }, "No users match.")));
  }
  async function update(u, patch, msg) {
    try { await rpc("admin_update_user", { p_id: u.id, p: patch }); toast(msg || "Saved"); await build(); } catch (e) { toast(errText(e)); }
  }
  function approve(u) {
    openDialog(close => {
      const len = el("select", {}, el("option", { value: "" }, "Default from Settings"), el("option", { value: "never" }, "Never expires"),
        ...[7, 30, 90, 180, 365].map(n => el("option", { value: n }, n + " days")));
      const role = el("select", {}, el("option", { value: "user" }, "User"), el("option", { value: "admin" }, "Admin"));
      const fe = featureEditor(u.features, { note: "Pre-filled from the default in Settings. Admins always get every feature." });
      return el("form", { class: "dlg", onsubmit: async e => {
          e.preventDefault();
          const p = { status: "active", role: role.value, features: fe.value() };
          if (len.value === "never") p.expires_at = null; else if (len.value) p.expires_at = new Date(Date.now() + len.value * 86400e3).toISOString();
          close(); await update(u, p, "Approved " + u.email);
        } },
        el("h2", {}, "Approve " + u.email),
        el("p", { class: "sub" }, (u.full_name ? u.full_name + " · " : "") + "requested access " + ago(u.created_at) + "."),
        el("div", { class: "form-grid" }, el("label", { class: "field" }, "Role", role), el("label", { class: "field" }, "Access length", len), fe.node),
        el("div", { class: "dlg-actions" }, el("span", { style: { flex: 1 } }), el("button", { type: "button", class: "btn", onclick: close }, "Cancel"),
          el("button", { type: "submit", class: "btn primary" }, "Approve")));
    });
  }
  function editUser(u) {
    const me = u.id === ctx.profile.id;
    openDialog(close => {
      const name = el("input", { type: "text", value: u.full_name || "" });
      const role = el("select", { disabled: me }, el("option", { value: "user", selected: u.role === "user" }, "User"), el("option", { value: "admin", selected: u.role === "admin" }, "Admin (can manage users)"));
      const status = el("select", { disabled: me }, ...[["active", "Active"], ["pending", "Pending"], ["disabled", "Disabled"]].map(([v, t]) => el("option", { value: v, selected: u.status === v }, t)));
      const never = el("input", { type: "checkbox", checked: !u.expires_at, disabled: me });
      const until = el("input", { type: "date", value: u.expires_at ? u.expires_at.slice(0, 10) : "", disabled: me || !u.expires_at });
      never.addEventListener("change", () => { until.disabled = never.checked; if (!never.checked && !until.value) until.value = addDays(isoDay(), 30); });
      const quick = n => el("button", { type: "button", class: "btn small", disabled: me, onclick: () => { never.checked = false; until.disabled = false;
        const base = until.value && until.value > isoDay() ? until.value : isoDay(); until.value = addDays(base, n); } }, "+" + (n >= 365 ? "1 year" : n + " days"));
      const notes = el("textarea", { class: "input", rows: 3 }); notes.value = u.notes || "";
      const fe = featureEditor(u.features, { disabled: u.role === "admin", note: u.role === "admin" ? "Admins always have every feature. Change the role to User to restrict features." : null });
      const msg = el("div", { class: "hint err" });
      return el("form", { class: "dlg", onsubmit: async e => {
          e.preventDefault();
          const p = { full_name: name.value.trim(), notes: notes.value.trim() };
          if (u.role !== "admin") p.features = fe.value();
          if (!me) { p.role = role.value; p.status = status.value; p.expires_at = never.checked ? null : (until.value ? new Date(until.value + "T23:59:59").toISOString() : null); }
          try { await rpc("admin_update_user", { p_id: u.id, p }); close(); toast("Saved " + u.email); build(); } catch (err) { msg.textContent = errText(err); }
        } },
        el("h2", {}, "Edit " + u.email),
        me ? el("p", { class: "hint" }, "You can't change your own role, status or access length.") : null,
        el("div", { class: "form-grid" },
          el("label", { class: "field" }, "Name", name), el("label", { class: "field" }, "Role", role),
          el("label", { class: "field" }, "Status", status),
          el("div", { class: "field" }, "Access", el("label", { class: "toggle" }, never, "Never expires"),
            el("div", { class: "controls" }, until, quick(7), quick(30), quick(365))),
          fe.node,
          el("label", { class: "field full" }, "Admin notes (only admins see these)", notes)),
        msg,
        el("div", { class: "dlg-actions" }, el("span", { style: { flex: 1 } }), el("button", { type: "button", class: "btn", onclick: close }, "Cancel"),
          el("button", { type: "submit", class: "btn primary" }, "Save")));
    });
  }
  function editAccess(u) {
    openDialog(close => {
      const fe = featureEditor(u.features);
      const msg = el("div", { class: "hint err" });
      return el("form", { class: "dlg", onsubmit: async e => {
          e.preventDefault();
          try { await rpc("admin_update_user", { p_id: u.id, p: { features: fe.value() } }); close(); toast("Feature access saved for " + u.email); build(); }
          catch (err) { msg.textContent = errText(err); }
        } },
        el("h2", {}, "Feature access: " + u.email),
        el("p", { class: "sub" }, "Locked features show a 🔒 tab that can't be opened. Hidden features don't appear at all. ",
          "The database blocks the data too, so this can't be bypassed. Changes apply the next time the user loads the page."),
        el("div", { class: "form-grid" }, fe.node), msg,
        el("div", { class: "dlg-actions" }, el("span", { style: { flex: 1 } }), el("button", { type: "button", class: "btn", onclick: close }, "Cancel"),
          el("button", { type: "submit", class: "btn primary" }, "Save")));
    });
  }
  function setPassword(u) {
    const gen = () => { const c = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; const a = new Uint32Array(12); crypto.getRandomValues(a); return [...a].map(x => c[x % c.length]).join(""); };
    openDialog(close => {
      const pw = el("input", { type: "text", value: gen(), minlength: 8, required: true, style: { fontFamily: "ui-monospace, monospace" } });
      const msg = el("div", { class: "hint err" });
      return el("form", { class: "dlg", onsubmit: async e => {
          e.preventDefault();
          try { await rpc("admin_set_password", { p_id: u.id, p_password: pw.value }); close();
            openDialog(c2 => el("div", { class: "dlg" }, el("h2", {}, "Temporary password set"),
              el("p", { class: "sub" }, "Send this to " + u.email + ". They'll be asked to choose their own password when they sign in."),
              el("div", { class: "msg-box" }, el("code", { style: { fontSize: "15px" } }, pw.value)),
              el("div", { class: "dlg-actions" }, el("button", { class: "btn", onclick: e2 => copyText(e2.currentTarget, "Sign in at " + location.origin + location.pathname + "\nEmail: " + u.email + "\nTemporary password: " + pw.value) }, "Copy message"),
                el("span", { style: { flex: 1 } }), el("button", { class: "btn primary", onclick: c2 }, "Done"))));
          } catch (err) { msg.textContent = errText(err); }
        } },
        el("h2", {}, "Set a temporary password"),
        el("p", { class: "sub" }, "For " + u.email + ". Use this when someone forgot their password. Their old password stops working."),
        el("label", { class: "field" }, "Temporary password", el("div", { class: "controls" }, pw, el("button", { type: "button", class: "btn small", onclick: () => pw.value = gen() }, "New"))),
        msg,
        el("div", { class: "dlg-actions" }, el("span", { style: { flex: 1 } }), el("button", { type: "button", class: "btn", onclick: close }, "Cancel"),
          el("button", { type: "submit", class: "btn primary" }, "Set password")));
    });
  }
  async function del(u) {
    const ok = await confirmDialog({ title: "Delete " + u.email + "?", danger: true, okText: "Delete user", typeToConfirm: u.email,
      text: "This permanently deletes the account, its favorites, pipeline, notes and seed keywords. It can't be undone. To only block access, use Disable instead." });
    if (!ok) return;
    try { await rpc("admin_delete_user", { p_id: u.id }); toast("Deleted " + u.email); build(); } catch (e) { toast(errText(e)); }
  }

  // ---------------- Invites ----------------
  async function invitesView(body) {
    const [invites, st] = await Promise.all([rpc("admin_list_invites").then(r => r || []), rpc("admin_get_settings")]);
    const fe = featureEditor(st?.default_features, { note: "Applies to these invites (admins always get every feature). The default comes from Settings." });
    const link = email => location.origin + location.pathname + "#signup?email=" + encodeURIComponent(email);
    const emails = el("textarea", { class: "input", rows: 3, placeholder: "name@company.com, another@gmail.com" });
    const role = el("select", {}, el("option", { value: "user" }, "User"), el("option", { value: "admin" }, "Admin"));
    const len = el("select", {}, el("option", { value: "" }, "Never expires"), ...[7, 14, 30, 90, 180, 365].map(n => el("option", { value: n }, n + " days")));
    const note = el("input", { type: "text", placeholder: "e.g. trial, client name" });
    const out = el("div");
    const tb = el("tbody", {}, ...invites.map(i => el("tr", {},
      el("td", {}, el("b", {}, i.email)), el("td", {}, i.role === "admin" ? el("span", { class: "badge blue" }, "Admin") : "User"),
      el("td", {}, accessBadges(i.features, i.role === "admin")),
      el("td", { class: "num" }, i.expires_at ? shortDate(i.expires_at) : el("span", { class: "muted" }, "never")),
      el("td", { class: "muted" }, i.note || ""), el("td", { class: "muted" }, ago(i.created_at)),
      el("td", {}, el("div", { class: "row-actions" },
        el("button", { class: "btn small", onclick: e => copyText(e.currentTarget, "You're invited to " + (ctx.settings?.site_title || "Domain Radar") + ".\nCreate your account here (use this email: " + i.email + "):\n" + link(i.email)) }, "Copy invite message"),
        el("button", { class: "btn small", style: { color: "var(--critical)" }, onclick: async () => { try { await rpc("admin_revoke_invite", { p_email: i.email }); toast("Invite revoked"); build(); } catch (e) { toast(errText(e)); } } }, "Revoke"))))));
    body.replaceChildren(
      el("div", { class: "grid-2" },
        el("section", { class: "card" },
          el("div", { class: "card-head" }, el("h2", {}, "Invite people")),
          el("p", { class: "sub", style: { marginTop: 0 } }, "Invited emails get access as soon as they create their account (no approval needed). Send them the invite message from the list."),
          el("form", { onsubmit: async e => {
              e.preventDefault();
              const list = [...new Set(emails.value.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean))];
              if (!list.length) return;
              const exp = len.value ? new Date(Date.now() + len.value * 86400e3).toISOString() : null;
              const results = [];
              for (const em of list) {
                try { await rpc("admin_invite", { p_email: em, p_role: role.value, p_expires_at: exp, p_note: note.value.trim() || null, p_features: fe.value() }); results.push([em, true]); }
                catch (err) { results.push([em, false, errText(err)]); }
              }
              const ok = results.filter(r => r[1]).length;
              toast("Invited " + ok + " of " + list.length);
              await build();
              const o = $("#ad-body", host).querySelector("[data-out]");
              if (o) o.replaceChildren(...results.filter(r => !r[1]).map(r => el("div", { class: "hint err" }, r[0] + ": " + r[2])));
            }, style: { display: "grid", gap: "10px" } },
            el("label", { class: "field" }, "Email addresses (one or many)", emails),
            el("div", { class: "form-grid" }, el("label", { class: "field" }, "Role", role), el("label", { class: "field" }, "Access length", len),
              el("label", { class: "field full" }, "Note (optional)", note), fe.node),
            el("div", { "data-out": "" }),
            el("div", {}, el("button", { class: "btn primary", type: "submit" }, "Send invites")))),
        el("section", { class: "card" },
          el("div", { class: "card-head" }, el("h2", {}, "How access works")),
          el("ul", { class: "reasons" },
            el("li", {}, el("b", {}, "Invited"), ": create an account with the invited email → instant access."),
            el("li", {}, el("b", {}, "Not invited"), ": " + (ctx.settings?.allow_requests === false ? "sign-up is refused (invite-only mode)." : "the account waits as Pending until you approve it in Users.")),
            el("li", {}, "Turn invite-only mode on or off in ", el("button", { class: "linkbtn", onclick: () => { S.sub = "settings"; save(); build(); } }, "Settings"), "."),
            el("li", {}, "Disable or set an end date for anyone at any time. Blocked users lose access to all data immediately."),
            el("li", {}, el("b", {}, "Feature access"), ": lock or hide Niche Finder, Leads, Research or Daily Files per person (Users → Access).")))),
      el("section", { class: "card", style: { marginTop: "12px" } },
        el("div", { class: "card-head" }, el("h2", {}, "Open invites"), el("span", { class: "muted" }, fmt(invites.length))),
        invites.length ? el("div", { class: "tbl-wrap" }, el("table", { class: "data" },
          el("thead", {}, el("tr", {}, ...["Email", "Role", "Features", "Access until", "Note", "Invited", ""].map(h => el("th", {}, h)))), tb)) : el("div", { class: "empty" }, "No open invites. Used invites disappear from this list.")));
  }

  // ---------------- Activity ----------------
  async function activityView(body) {
    let rows = [], done = false;
    const userSel = el("select", { onchange: e => { S.actUser = e.target.value; save(); reload(); } }, el("option", { value: "" }, "All users"),
      ...users.map(u => el("option", { value: u.id, selected: u.id === S.actUser }, u.email)));
    const actSel = el("select", { onchange: e => { S.actAction = e.target.value; save(); reload(); } }, el("option", { value: "" }, "All actions"),
      ...Object.entries(ACTIONS).map(([k, v]) => el("option", { value: k, selected: k === S.actAction }, v)));
    const table = el("div"), more = el("button", { class: "btn", onclick: () => load(true) }, "Load older");
    const detailText = (a) => {
      const d = a.detail || {};
      if (a.action === "view") return TAB_NAMES[d.tab] || d.tab || "";
      if (a.action === "niche_select") return (d.niches || []).map(n => ctx.meta.get(n)?.name || n).join(", ");
      if (a.action.startsWith("export")) return (d.tab || "") + (d.rows != null ? " · " + fmt(d.rows) + " rows" : "");
      if (a.action === "admin_update_user") return (d.user || "") + " " + JSON.stringify(d.changes || {});
      return Object.entries(d).map(([k, v]) => k + ": " + (typeof v === "object" ? JSON.stringify(v) : v)).join(" · ");
    };
    async function load(older) {
      const before = older && rows.length ? rows[rows.length - 1].at : null;
      const got = (await rpc("admin_activity", { p: { user_id: S.actUser || null, action: S.actAction || null, before, limit: 100 } })) || [];
      rows = older ? rows.concat(got) : got; done = got.length < 100;
      table.replaceChildren(rows.length ? el("div", { class: "tbl-wrap", style: { maxHeight: "680px" } }, el("table", { class: "data" },
        el("thead", {}, el("tr", {}, el("th", {}, "When"), el("th", {}, "User"), el("th", {}, "Action"), el("th", {}, "Details"))),
        el("tbody", {}, ...rows.map(a => el("tr", {}, el("td", { class: "muted num", style: { whiteSpace: "nowrap" } }, dateTime(a.at)),
          el("td", {}, a.email || el("span", { class: "muted" }, "deleted user")), el("td", {}, ACTIONS[a.action] || a.action),
          el("td", { class: "muted", style: { maxWidth: "480px", overflow: "hidden", textOverflow: "ellipsis" } }, detailText(a))))))) : el("div", { class: "empty" }, "No activity yet."));
      more.hidden = done;
    }
    const reload = () => load(false);
    body.replaceChildren(el("div", { class: "filters" }, userSel, actSel, el("span", { style: { flex: 1 } }),
        el("button", { class: "btn", onclick: () => download("activity_" + isoDay() + ".csv", csv(["at", "email", "action", "details"], rows.map(a => [a.at, a.email, ACTIONS[a.action] || a.action, JSON.stringify(a.detail)])), "text/csv") }, "Export CSV")),
      el("section", { class: "card" }, table, el("div", { style: { marginTop: "10px" } }, more)));
    await load(false);
  }

  // ---------------- Data & jobs ----------------
  async function dataView(body) {
    const [runs, st] = await Promise.all([rpc("admin_job_runs", { p_limit: 40 }), stats ? Promise.resolve(stats) : rpc("admin_stats", { p_days: 30 })]);
    stats = st;
    const d = st.data || {};
    const repo = location.hostname.endsWith(".github.io") ? location.hostname.split(".")[0] + "/" + (location.pathname.split("/").filter(Boolean)[0] || location.hostname) : null;
    const dur = r => r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000) + " s" : "running…";
    const ok = runs.filter(r => r.status === "ok").length;
    body.replaceChildren(
      el("div", { class: "tiles" },
        tile("Days stored", fmt(ctx.days.length), ctx.days.length ? ctx.days[0].date + " → " + ctx.days[ctx.days.length - 1].date : ""),
        tile("Leads stored", fmt(d.leads), fmt(d.leads_checked) + " checked · " + fmt(d.leads_hot) + " hot"),
        tile("Storage used", kb(d.storage_bytes), "files · database " + kb(d.db_bytes)),
        tile("Job success", runs.length ? Math.round(ok / runs.length * 100) + "%" : "–", "last " + runs.length + " runs")),
      el("section", { class: "card" },
        el("div", { class: "card-head" }, el("h2", {}, "Daily job runs"),
          repo ? el("a", { class: "btn", href: "https://github.com/" + repo + "/actions", target: "_blank", rel: "noopener" }, "Open GitHub Actions ↗") : el("span", { class: "muted" }, "Runs every 3 hours from GitHub Actions")),
        runs.length ? el("div", { class: "tbl-wrap" }, el("table", { class: "data" },
          el("thead", {}, el("tr", {}, ...["Started", "Took", "Status", "New days", "Leads checked", "Hot", "Owner lookups", "Gap names checked", "Seeds re-run", "Problem"].map(h => el("th", {}, h)))),
          el("tbody", {}, ...runs.map(r => { const s = r.summary || {}; return el("tr", {},
            el("td", { class: "num", style: { whiteSpace: "nowrap" } }, dateTime(r.started_at)), el("td", { class: "num muted" }, dur(r)),
            el("td", {}, el("span", { class: "badge " + (r.status === "ok" ? "ok" : r.status === "error" ? "bad" : "warn") }, r.status)),
            el("td", { class: "num" }, (s.downloaded || s.new_days || []).length ?? "–"), el("td", { class: "num" }, fmt(s.leads?.checked)), el("td", { class: "num" }, fmt(s.leads?.hot)),
            el("td", { class: "num" }, fmt(s.leads?.rdap)), el("td", { class: "num" }, fmt(s.gaps?.checked)), el("td", { class: "num" }, fmt(s.seeds?.reprocessed)),
            el("td", { class: "muted", style: { maxWidth: "360px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: r.error || "" }, r.error || "")); })))) :
          el("div", { class: "empty" }, "The job hasn't run yet. In GitHub open Actions → Daily job → Run workflow.")),
      el("section", { class: "card", style: { marginTop: "12px" } }, el("div", { class: "card-head" }, el("h2", {}, "Free tier limits")),
        el("dl", { class: "kv" }, ...[["Supabase database", kb(d.db_bytes) + " used of 500 MB"], ["Supabase file storage", kb(d.storage_bytes) + " used of 1 GB"],
          ["Old data cleanup", "Leads older than " + (ctx.cfg.leads?.keep_days || 120) + " days (unless tracked), location stats after 400 days, activity after 365 days"],
          ["GitHub Actions", "Free and unlimited for public repositories"]].flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]))));
  }

  // ---------------- Settings ----------------
  async function settingsView(body) {
    const s = await rpc("admin_get_settings");
    const title = el("input", { type: "text", value: s.site_title, maxlength: 60 });
    const allow = el("input", { type: "checkbox", checked: s.allow_requests });
    const exp = el("input", { type: "number", min: 1, value: s.default_expiry_days ?? "", placeholder: "never", style: { width: "110px" } });
    const fe = featureEditor(s.default_features, { note: "Used for new access requests and pre-filled in the invite form. Existing users keep their own settings." });
    const msg = el("div", { class: "hint" });
    body.replaceChildren(el("div", { class: "grid-2" },
      el("section", { class: "card" }, el("div", { class: "card-head" }, el("h2", {}, "Settings")),
        el("form", { style: { display: "grid", gap: "14px" }, onsubmit: async e => {
            e.preventDefault();
            try { await rpc("admin_update_settings", { p: { site_title: title.value.trim(), allow_requests: allow.checked, default_expiry_days: exp.value ? String(+exp.value) : "", default_features: fe.value() } });
              msg.className = "hint"; msg.textContent = "Saved. Reload the page to see a new title."; toast("Settings saved"); }
            catch (err) { msg.className = "hint err"; msg.textContent = errText(err); }
          } },
          el("label", { class: "field" }, "Dashboard name", title),
          el("div", { class: "field" }, "Who can sign up",
            el("label", { class: "toggle" }, allow, "Allow access requests (people who aren't invited can sign up and wait for approval)"),
            el("div", { class: "hint", style: { margin: 0 } }, "Turn this off for invite-only: sign-ups from emails you didn't invite are refused.")),
          el("label", { class: "field" }, "Default access length for approved requests (days, empty = never expires)", exp),
          el("div", { class: "form-grid" }, fe.node),
          el("div", { class: "field" }, "Owner (always admin, can't be removed)", el("code", {}, s.owner_email || "not set")),
          msg, el("div", {}, el("button", { class: "btn primary", type: "submit" }, "Save settings")))),
      el("section", { class: "card" }, el("div", { class: "card-head" }, el("h2", {}, "Security checklist")),
        el("ul", { class: "reasons" },
          el("li", {}, "The ", el("b", {}, "service_role / secret"), " key is only in GitHub → Settings → Secrets → Actions, never in ", el("code", {}, "config.js"), "."),
          el("li", {}, "Supabase → Authentication → Sign In / Providers → Email: ", el("b", {}, "Confirm email"), " can be off (the admin approval is the gate) or on, if you set up custom SMTP."),
          el("li", {}, "All data (leads, files, lists) is readable only by active, non-expired accounts. That's enforced by the database, not just the page."),
          el("li", {}, "Remove people you no longer work with: Users → Disable (keeps their data) or Delete."),
          el("li", {}, "Owner email lives in the database setting ", el("code", {}, "app_settings.owner_email"), ". To change it, edit and re-run ", el("code", {}, "supabase/schema.sql"), ".")))));
  }

  build();
  let shown = false;
  return { show() { if (shown) build(); shown = true; }, redraw() {} };
}
