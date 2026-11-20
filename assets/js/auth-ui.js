// Login portal screens: sign in, create account / request access, waiting for approval,
// blocked (disabled / expired), forced password change, and "not configured yet".
import { el, $, errText } from "./core.js";
import { sb, rpc, logEvent } from "./api.js";

const shell = (title, ...body) => el("div", { class: "auth-wrap" },
  el("div", { class: "auth-card" }, el("div", { class: "logo" }, "DR"), el("h1", {}, title), ...body));

const field = (label, attrs) => el("label", { class: "field" }, label, el("input", attrs));

function friendlyAuthError(e) {
  const m = (e?.message || "").toLowerCase();
  if (m.includes("invalid login")) return "Wrong email or password.";
  if (m.includes("database error saving new user")) return "This tool is invite-only. Ask the admin to invite your email address first.";
  if (m.includes("already registered") || m.includes("already exists")) return "That email already has an account. Sign in instead.";
  if (m.includes("rate limit")) return "Too many attempts. Wait a minute and try again.";
  if (m.includes("password")) return e.message;
  if (m.includes("email not confirmed")) return "Your email isn't confirmed yet. Check your inbox, or ask the admin to turn off email confirmation.";
  return errText(e);
}

export function notConfigured(root) {
  root.replaceChildren(shell("Almost ready",
    el("p", { class: "sub" }, "The dashboard isn't connected to Supabase yet."),
    el("ol", { class: "steps" },
      el("li", {}, "Open ", el("code", {}, "assets/js/config.js"), " in your GitHub repository and click the ✏️ pencil."),
      el("li", {}, "Paste your Supabase ", el("b", {}, "Project URL"), " and ", el("b", {}, "anon / publishable key"), " (Supabase → Project Settings → API)."),
      el("li", {}, "Commit, wait a minute, and reload this page.")),
    el("p", { class: "hint" }, "Full steps: docs/SETUP.md")));
}

export function loginScreen(root, settings, { initialTab = "signin", prefillEmail = "" } = {}) {
  let tab = initialTab;
  const title = settings?.site_title || "Domain Radar";
  const render = () => {
    const msg = el("div", { class: "msg-box", hidden: true });
    const show = (text, kind = "err") => { msg.className = "msg-box " + kind; msg.textContent = text; msg.hidden = false; };
    const tabs = el("div", { class: "auth-tabs" },
      el("button", { "aria-selected": String(tab === "signin"), onclick: () => { tab = "signin"; render(); } }, "Sign in"),
      el("button", { "aria-selected": String(tab === "signup"), onclick: () => { tab = "signup"; render(); } }, settings?.allow_requests === false ? "I have an invite" : "Create account"));
    let form;
    if (tab === "signin") {
      const email = field("Email", { type: "email", name: "email", required: true, autocomplete: "email", value: prefillEmail });
      const pass = field("Password", { type: "password", name: "password", required: true, autocomplete: "current-password" });
      form = el("form", { onsubmit: async e => {
          e.preventDefault(); msg.hidden = true;
          const b = form.querySelector("button[type=submit]"); b.disabled = true; b.textContent = "Signing in…";
          const { error } = await sb.auth.signInWithPassword({ email: email.querySelector("input").value.trim(), password: pass.querySelector("input").value });
          b.disabled = false; b.textContent = "Sign in";
          if (error) return show(friendlyAuthError(error));
          sessionStorage.setItem("dr_fresh_login", "1");
        } },
        email, pass, msg,
        el("button", { class: "btn primary", type: "submit" }, "Sign in"),
        el("button", { class: "linkbtn", type: "button", onclick: () => forgot(email.querySelector("input").value.trim(), show) }, "Forgot password?"));
    } else {
      const name = field("Your name", { type: "text", name: "name", autocomplete: "name" });
      const email = field("Email", { type: "email", name: "email", required: true, autocomplete: "email", value: prefillEmail });
      const pass = field("Password (at least 8 characters)", { type: "password", name: "password", required: true, minlength: 8, autocomplete: "new-password" });
      const pass2 = field("Repeat password", { type: "password", name: "password2", required: true, minlength: 8, autocomplete: "new-password" });
      form = el("form", { onsubmit: async e => {
          e.preventDefault(); msg.hidden = true;
          const pw = pass.querySelector("input").value;
          if (pw.length < 8) return show("Use at least 8 characters.");
          if (pw !== pass2.querySelector("input").value) return show("The two passwords don't match.");
          const b = form.querySelector("button[type=submit]"); b.disabled = true; b.textContent = "Creating account…";
          const { data, error } = await sb.auth.signUp({ email: email.querySelector("input").value.trim(), password: pw,
            options: { data: { full_name: name.querySelector("input").value.trim() } } });
          b.disabled = false; b.textContent = "Create account";
          if (error) return show(friendlyAuthError(error));
          if (!data.session) return show("Account created. Check your email to confirm it, then sign in.", "ok");
          sessionStorage.setItem("dr_fresh_login", "1");
        } },
        el("p", { class: "hint", style: { margin: 0 } }, settings?.allow_requests === false
          ? "Use the email address the admin invited."
          : "If the admin invited you, you get access right away. Otherwise your request waits for approval."),
        name, email, pass, pass2, msg,
        el("button", { class: "btn primary", type: "submit" }, "Create account"));
    }
    root.replaceChildren(shell(title, el("p", { class: "sub" }, "Private dashboard. Authorized users only."), tabs, form));
    form.querySelector("input")?.focus();
  };
  render();
}

async function forgot(email, show) {
  if (!email) return show("Type your email above first, then click “Forgot password?” again.", "err");
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  show(error ? "Couldn't send the email. Ask your admin to set a temporary password for you."
             : "If email sending is set up, a reset link is on its way. If nothing arrives in a few minutes, ask your admin to set a temporary password for you.", error ? "err" : "ok");
}

export function waitingScreen(root, profile, onRefresh) {
  root.replaceChildren(shell("Waiting for approval",
    el("p", { class: "sub" }, "Thanks, " + (profile.full_name || profile.email) + ". Your request was sent to the admin. You'll get access as soon as it's approved."),
    el("div", { class: "msg-box" }, "Signed in as ", el("b", {}, profile.email)),
    el("div", { class: "controls", style: { marginTop: "16px" } },
      el("button", { class: "btn primary", onclick: onRefresh }, "Check again"),
      el("button", { class: "btn", onclick: () => sb.auth.signOut() }, "Sign out"))));
}

export function blockedScreen(root, profile) {
  const expired = profile.is_expired;
  root.replaceChildren(shell(expired ? "Your access has expired" : "Your account is disabled",
    el("p", { class: "sub" }, expired ? "Your access period ended on " + new Date(profile.expires_at).toLocaleDateString() + ". Contact the admin to extend it."
                                       : "The admin has turned off access for this account. Contact them if you think this is a mistake."),
    el("div", { class: "msg-box" }, "Signed in as ", el("b", {}, profile.email)),
    el("div", { class: "controls", style: { marginTop: "16px" } }, el("button", { class: "btn", onclick: () => sb.auth.signOut() }, "Sign out"))));
}

export function noProfileScreen(root, email) {
  root.replaceChildren(shell("Account not set up",
    el("p", { class: "sub" }, "You're signed in as " + email + ", but no profile exists for this account. The database setup (supabase/schema.sql) may not have been run, or the account was created before it."),
    el("p", { class: "hint" }, "Admin: run supabase/schema.sql again in the Supabase SQL Editor. It creates missing profiles."),
    el("button", { class: "btn", onclick: () => sb.auth.signOut() }, "Sign out")));
}

export function changePasswordScreen(root, profile, { reason, onDone }) {
  const msg = el("div", { class: "msg-box", hidden: true });
  const show = (t, k = "err") => { msg.className = "msg-box " + k; msg.textContent = t; msg.hidden = false; };
  const p1 = field("New password (at least 8 characters)", { type: "password", required: true, minlength: 8, autocomplete: "new-password" });
  const p2 = field("Repeat new password", { type: "password", required: true, minlength: 8, autocomplete: "new-password" });
  const form = el("form", { onsubmit: async e => {
      e.preventDefault();
      const pw = p1.querySelector("input").value;
      if (pw.length < 8) return show("Use at least 8 characters.");
      if (pw !== p2.querySelector("input").value) return show("The two passwords don't match.");
      const { error } = await sb.auth.updateUser({ password: pw });
      if (error) return show(friendlyAuthError(error));
      try { await rpc("password_changed"); } catch {}
      logEvent("password_changed_self");
      onDone();
    } }, p1, p2, msg, el("button", { class: "btn primary", type: "submit" }, "Save new password"),
    el("button", { class: "linkbtn", type: "button", onclick: () => sb.auth.signOut() }, "Sign out"));
  root.replaceChildren(shell("Choose a new password", el("p", { class: "sub" }, reason), form));
  form.querySelector("input").focus();
}
