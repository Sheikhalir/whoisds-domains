// Everything that talks to Supabase lives here: auth, database functions (RPC),
// private file storage, usage logging, and the per-user stores (lists + seeds).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { bus, seedSig, store } from "./core.js";

export const configured = !!(SUPABASE_URL && SUPABASE_ANON_KEY && !SUPABASE_URL.includes("YOUR-PROJECT") && !SUPABASE_ANON_KEY.includes("YOUR-"));
export const sb = configured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
}) : null;

export async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data;
}

// ---------- usage analytics (admin Overview) ----------
const lastView = {};
export function logEvent(action, detail = {}) {
  if (!sb) return;
  if (action === "view") {               // one page-view per tab per 10 minutes
    const k = detail.tab; if (lastView[k] && Date.now() - lastView[k] < 600000) return;
    lastView[k] = Date.now();
  }
  sb.rpc("log_event", { p_action: action, p_detail: detail }).then(() => {}, () => {});
}

// ---------- private storage (bucket "daily") ----------
const fileCache = new Map();
export async function storageFile(path, as = "json") {
  const key = path + "|" + as;
  if (fileCache.has(key)) return fileCache.get(key);
  const p = (async () => {
    const { data, error } = await sb.storage.from("daily").download(path);
    if (error || !data) throw new Error(error?.message || "file not found: " + path);
    return as === "json" ? JSON.parse(await data.text()) : as === "text" ? data.text() : data.arrayBuffer();
  })();
  fileCache.set(key, p);
  p.catch(() => fileCache.delete(key));
  return p;
}
const domainCache = new Map();
export async function dayDomains(date) {
  if (domainCache.has(date)) return domainCache.get(date);
  const p = (async () => {
    const buf = await storageFile("zip/" + date + ".zip", "buffer");
    const zip = await window.JSZip.loadAsync(buf);
    const files = Object.values(zip.files).filter(f => !f.dir);
    const text = (await Promise.all(files.map(f => f.async("string")))).join("\n");
    return [...new Set(text.split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean))];
  })();
  domainCache.set(date, p);
  p.catch(() => domainCache.delete(date));
  return p;
}

// ---------- favorites / discards / CRM (table user_leads, one row per user + domain) ----------
export const Lists = (() => {
  let rows = new Map();
  const api = {
    async load() { rows = new Map(((await rpc("my_lists")) || []).map(r => [r.domain, r])); bus.emit("lists"); },
    get: d => rows.get(d),
    isFav: d => !!rows.get(d)?.fav,
    isDis: d => !!rows.get(d)?.discarded,
    favs: () => [...rows.values()].filter(r => r.fav),
    diss: () => [...rows.values()].filter(r => r.discarded),
    favCount: () => api.favs().length,
    disCount: () => api.diss().length,
    // patch: {fav, discarded, status, note, follow_up}; meta: {found_date, niche_ids, kws, loc} (saved once, for leads without a lead row)
    async set(domains, patch, meta = {}) {
      domains = [...new Set(domains)];
      const before = domains.map(d => [d, rows.get(d) ? { ...rows.get(d) } : null]);
      for (const d of domains) {
        const r = rows.get(d) || { domain: d, fav: false, discarded: false, status: null, note: null, follow_up: null };
        Object.assign(r, patch);
        if (patch.discarded) r.fav = false;
        for (const k of ["found_date", "niche_ids", "kws", "loc"]) if (meta[k] != null && r[k] == null) r[k] = meta[k];
        if (!r.fav && !r.discarded && !r.status && !r.note && !r.follow_up) rows.delete(d); else rows.set(d, r);
      }
      bus.emit("lists");
      try {
        for (let i = 0; i < domains.length; i += 500) await rpc("set_my_leads", { p_domains: domains.slice(i, i + 500), p: { ...meta, ...patch } });
      } catch (e) {
        for (const [d, r] of before) r ? rows.set(d, r) : rows.delete(d);   // undo local change
        bus.emit("lists");
        throw e;
      }
      return before;
    },
    async restore(before) {
      for (const [d, r] of before) {
        const p = r ? { fav: r.fav, discarded: r.discarded, status: r.status, note: r.note, follow_up: r.follow_up } : { fav: false, discarded: false, status: null, note: null, follow_up: null };
        await api.set([d], p);
      }
    },
    async toggleFav(r) {
      const on = !api.isFav(r.d || r.domain);
      await api.set([r.d || r.domain], { fav: on }, { found_date: r.date || r.found_date, niche_ids: r.ids || r.niche_ids, kws: r.kws, loc: r.loc || null });
      return on;
    }
  };
  return api;
})();

// ---------- seed keywords (table seeds, per user) ----------
export const Seeds = (() => {
  let list = [];
  const clean = w => w.toLowerCase().replace(/[^a-z0-9]/g, "");
  return {
    async load() { list = (await rpc("list_my_seeds")) || []; bus.emit("seeds"); return list; },
    list: () => list,
    processed: s => s.processed_sig && s.processed_sig === s.sig && s.sig === seedSig(s),
    parse(text) {
      const out = [];
      for (let line of text.split(/\r?\n/)) {
        line = line.trim(); if (!line || line.startsWith("#")) continue;
        let name, words; const c = line.indexOf(":");
        if (c > 0) { name = line.slice(0, c).trim(); words = line.slice(c + 1); } else words = line;
        const parts = words.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
        const keywords = [...new Set(parts.filter(p => !p.startsWith("-")).map(clean).filter(w => w.length >= 3))];
        const exclude = [...new Set(parts.filter(p => p.startsWith("-")).map(p => clean(p.slice(1))).filter(Boolean))];
        if (!keywords.length) continue;
        name = (name || parts.filter(p => !p.startsWith("-"))[0]).slice(0, 80);
        const prev = list.find(s => s.name.toLowerCase() === name.toLowerCase());
        out.push({ id: prev?.id, name, keywords, exclude });
      }
      return out;
    },
    toText: () => list.map(s => {
      const words = [...s.keywords, ...(s.exclude || []).map(e => "-" + e)].join(", ");
      return s.keywords.length === 1 && !(s.exclude || []).length && clean(s.name) === s.keywords[0] ? s.keywords[0] : s.name + ": " + words;
    }).join("\n"),
    async save(items) { list = (await rpc("save_my_seeds", { p: items })) || []; bus.emit("seeds"); return list; }
  };
})();

export const prefs = { get: (k, d) => store.get("dr_" + k, d), set: (k, v) => store.set("dr_" + k, v) };
