#!/usr/bin/env python3
"""
LOCAL TEST SERVER - a small stand-in for Supabase, backed by a real PostgreSQL.

It implements just the parts of Supabase's HTTP API this project uses:
  /auth/v1/...     sign up, password login, refresh, get/update user, logout, recover
  /rest/v1/rpc/fn  call database functions (PostgREST style, named arguments)
  /rest/v1/table   select / insert / upsert / update / delete with PostgREST filters
  /storage/v1/...  upload, download, list, delete (bucket files on local disk)
and also serves the dashboard files from the project folder at "/".

Every database call runs as the caller's role (anon / authenticated / service_role)
with the same JWT claims Supabase would set, so the row-level-security rules in
supabase/schema.sql are enforced for real.

Usage (see dev/run_local.sh):
  python dev/mock_supabase.py --dsn "postgresql://postgres@/radar?host=/tmp/pg&port=54329" --port 8800 --root .
Prints the anon + service keys on start. GET /assets/js/config.js is generated so the
dashboard talks to this server.
"""
import argparse
import json
import mimetypes
import os
import re
import secrets
import sys
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jwt  # PyJWT
import psycopg
from psycopg.rows import dict_row

SECRET = "local-dev-jwt-secret-at-least-32-characters-long"
ANON_KEY = jwt.encode({"role": "anon", "iss": "supabase-local", "exp": 4102444800}, SECRET, algorithm="HS256")
SERVICE_KEY = jwt.encode({"role": "service_role", "iss": "supabase-local", "exp": 4102444800}, SECRET, algorithm="HS256")
IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")
REFRESH = {}   # refresh_token -> user id
ARGS = None


def db():
    return psycopg.connect(ARGS.dsn, autocommit=False, row_factory=dict_row)


def jsonable(v):
    if isinstance(v, (list, tuple)): return [jsonable(x) for x in v]
    if isinstance(v, dict): return {k: jsonable(x) for k, x in v.items()}
    if hasattr(v, "isoformat"): return v.isoformat()
    if isinstance(v, uuid.UUID): return str(v)
    if isinstance(v, (bytes, memoryview)): return None
    try:
        import decimal
        if isinstance(v, decimal.Decimal): return float(v)
    except Exception: pass
    return v


def make_session(user):
    now = int(time.time())
    token = jwt.encode({"aud": "authenticated", "exp": now + 3600, "iat": now, "sub": str(user["id"]), "email": user["email"],
                        "role": "authenticated", "session_id": str(uuid.uuid4())}, SECRET, algorithm="HS256")
    rt = secrets.token_urlsafe(24)
    REFRESH[rt] = str(user["id"])
    return {"access_token": token, "token_type": "bearer", "expires_in": 3600, "expires_at": now + 3600,
            "refresh_token": rt, "user": user_json(user)}


def user_json(u):
    return {"id": str(u["id"]), "aud": "authenticated", "role": "authenticated", "email": u["email"],
            "email_confirmed_at": jsonable(u.get("email_confirmed_at")) or jsonable(u.get("created_at")),
            "app_metadata": {"provider": "email", "providers": ["email"]}, "user_metadata": u.get("raw_user_meta_data") or {},
            "identities": [], "created_at": jsonable(u.get("created_at")), "updated_at": jsonable(u.get("updated_at")),
            "last_sign_in_at": jsonable(u.get("last_sign_in_at"))}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        if ARGS.verbose: sys.stderr.write("%s %s\n" % (self.command, self.path))

    # ---------- plumbing ----------
    def send(self, status, body=None, headers=None, raw=None, ctype="application/json"):
        data = raw if raw is not None else (b"" if body is None else json.dumps(jsonable(body)).encode())
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "Content-Range")
        if data or status != 204: self.send_header("Content-Type", ctype)
        for k, v in (headers or {}).items(): self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if data and self.command != "HEAD": self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def jbody(self):
        b = self.body()
        return json.loads(b) if b else {}

    def claims(self):
        """JWT claims of the caller: user token if present, else the apikey."""
        for raw in [(self.headers.get("Authorization") or "").replace("Bearer ", ""), self.headers.get("apikey") or ""]:
            if not raw: continue
            try:
                return jwt.decode(raw, SECRET, algorithms=["HS256"], audience="authenticated", options={"verify_aud": False})
            except jwt.ExpiredSignatureError:
                return {"_expired": True}
            except Exception:
                continue
        return None

    def do_OPTIONS(self):
        self.send(204)

    def do_GET(self): self.route("GET")
    def do_HEAD(self): self.route("GET")
    def do_POST(self): self.route("POST")
    def do_PUT(self): self.route("PUT")
    def do_PATCH(self): self.route("PATCH")
    def do_DELETE(self): self.route("DELETE")

    def route(self, method):
        u = urllib.parse.urlsplit(self.path)
        path, qs = u.path, urllib.parse.parse_qsl(u.query, keep_blank_values=True)
        try:
            if path.startswith("/auth/v1/"): return self.auth(method, path[9:], dict(qs))
            if path.startswith("/rest/v1/rpc/"): return self.rpc(path[13:])
            if path.startswith("/rest/v1/"): return self.table(method, path[9:], qs)
            if path.startswith("/storage/v1/"): return self.storage(method, path[12:])
            return self.static(path)
        except Exception as e:  # never crash the server
            import traceback; traceback.print_exc()
            return self.send(500, {"message": str(e)})

    # ---------- static files ----------
    def static(self, path):
        if path == "/assets/js/config.js":
            js = (f"export const SUPABASE_URL = 'http://localhost:{ARGS.port}';\n"
                  f"export const SUPABASE_ANON_KEY = '{ANON_KEY}';\n")
            return self.send(200, raw=js.encode(), ctype="text/javascript")
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        full = os.path.realpath(os.path.join(ARGS.root, rel))
        if not full.startswith(os.path.realpath(ARGS.root)) or not os.path.isfile(full):
            return self.send(404, {"message": "not found"})
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".js"): ctype = "text/javascript"
        return self.send(200, raw=open(full, "rb").read(), ctype=ctype, headers={"Cache-Control": "no-store"})

    # ---------- auth ----------
    def auth(self, method, sub, qs):
        if sub == "signup" and method == "POST":
            b = self.jbody()
            email, pw = (b.get("email") or "").strip().lower(), b.get("password") or ""
            if len(pw) < 6:
                return self.send(422, {"code": 422, "error_code": "weak_password", "msg": "Password should be at least 6 characters."})
            with db() as c:
                if c.execute("select 1 from auth.users where lower(email)=%s", [email]).fetchone():
                    return self.send(422, {"code": 422, "error_code": "user_already_exists", "msg": "User already registered"})
                try:
                    u = c.execute("insert into auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at) "
                                  "values (%s, extensions.crypt(%s, extensions.gen_salt('bf')), %s, now()) returning *",
                                  [email, pw, json.dumps(b.get("data") or {})]).fetchone()
                    c.commit()
                except Exception as e:
                    print("signup refused by database:", str(e).split("\n")[0])
                    return self.send(500, {"code": 500, "error_code": "unexpected_failure", "msg": "Database error saving new user"})
            return self.send(200, make_session(u))
        if sub == "token" and method == "POST":
            b = self.jbody()
            if qs.get("grant_type") == "password":
                with db() as c:
                    u = c.execute("select * from auth.users where lower(email)=%s and encrypted_password = extensions.crypt(%s, encrypted_password)",
                                  [(b.get("email") or "").strip().lower(), b.get("password") or ""]).fetchone()
                    if not u:
                        return self.send(400, {"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"})
                    c.execute("update auth.users set last_sign_in_at = now() where id=%s", [u["id"]]); c.commit()
                return self.send(200, make_session(u))
            if qs.get("grant_type") == "refresh_token":
                uid = REFRESH.pop(b.get("refresh_token") or "", None)
                if not uid:
                    return self.send(400, {"code": 400, "error_code": "refresh_token_not_found", "msg": "Invalid Refresh Token: Refresh Token Not Found"})
                with db() as c:
                    u = c.execute("select * from auth.users where id=%s", [uid]).fetchone()
                if not u: return self.send(400, {"code": 400, "error_code": "user_not_found", "msg": "User not found"})
                return self.send(200, make_session(u))
        if sub == "user":
            cl = self.claims()
            if not cl or cl.get("_expired") or cl.get("role") != "authenticated":
                return self.send(401, {"code": 401, "error_code": "bad_jwt", "msg": "invalid JWT"})
            with db() as c:
                if method == "PUT":
                    b = self.jbody()
                    if b.get("password"):
                        if len(b["password"]) < 6:
                            return self.send(422, {"code": 422, "error_code": "weak_password", "msg": "Password should be at least 6 characters."})
                        c.execute("update auth.users set encrypted_password = extensions.crypt(%s, extensions.gen_salt('bf')), updated_at=now() where id=%s",
                                  [b["password"], cl["sub"]])
                    if b.get("data"):
                        c.execute("update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data,'{}') || %s::jsonb where id=%s",
                                  [json.dumps(b["data"]), cl["sub"]])
                    c.commit()
                u = c.execute("select * from auth.users where id=%s", [cl["sub"]]).fetchone()
            if not u: return self.send(404, {"code": 404, "error_code": "user_not_found", "msg": "User not found"})
            return self.send(200, user_json(u))
        if sub.startswith("logout"):
            return self.send(204)
        if sub == "recover":
            b = self.jbody()
            print(f"[mock] password recovery requested for {b.get('email')} (no email is sent locally)")
            return self.send(200, {})
        if sub == "settings":
            return self.send(200, {"external": {"email": True}, "disable_signup": False, "mailer_autoconfirm": True})
        return self.send(404, {"code": 404, "msg": "auth endpoint not implemented in mock: " + sub})

    # ---------- database ----------
    def role_tx(self, c):
        cl = self.claims()
        if cl is None: cl = {"role": "anon"}
        if cl.get("_expired"):
            raise PermissionError("JWT expired")
        role = cl.get("role", "anon")
        if role not in ("anon", "authenticated", "service_role"): role = "anon"
        c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(cl)])
        c.execute(f"set local role {role}")
        return role

    def pg_error(self, e):
        msg = str(getattr(e, "diag", None) and e.diag.message_primary or e).split("\n")[0]
        code = getattr(getattr(e, "diag", None), "sqlstate", None) or ""
        status = 401 if code == "42501" else 400
        if isinstance(e, PermissionError): return self.send(401, {"code": "PGRST301", "message": str(e)})
        return self.send(status, {"code": code, "message": msg, "details": None, "hint": None})

    def rpc(self, fn):
        if not IDENT.match(fn): return self.send(404, {"message": "bad function"})
        args = self.jbody() if self.command == "POST" else {}
        try:
            with db() as c:
                meta = c.execute("""select p.proretset, p.prorettype::regtype::text as rettype, p.proargnames,
                                    (select array_agg(t::regtype::text order by o) from unnest(p.proargtypes) with ordinality x(t, o)) as argtypes
                                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                    where n.nspname = 'public' and p.proname = %s limit 1""", [fn]).fetchone()
                if not meta: return self.send(404, {"code": "PGRST202", "message": f"Could not find the function public.{fn}"})
                names = meta["proargnames"] or []
                types = meta["argtypes"] or []
                parts, vals = [], []
                for i, name in enumerate(names[:len(types)]):
                    if name in args:
                        v, t = args[name], types[i]
                        if t in ("jsonb", "json"): v = json.dumps(v)
                        parts.append(f"{name} => %s::{t}")
                        vals.append(v)
                self.role_tx(c)
                call = f"public.{fn}({', '.join(parts)})"
                if meta["proretset"] or meta["rettype"] == "record":
                    rows = c.execute(f"select * from {call}", vals).fetchall()
                    c.commit()
                    return self.send(200, rows)
                row = c.execute(f"select {call} as r", vals).fetchone()
                c.commit()
                if meta["rettype"] == "void": return self.send(204)
                return self.send(200, row["r"])
        except Exception as e:
            return self.pg_error(e)

    def table(self, method, name, qs):
        if not IDENT.match(name): return self.send(404, {"message": "bad table"})
        select, order, limit, offset, on_conflict, filters = "*", None, None, None, None, []
        for k, v in qs:
            if k == "select": select = v
            elif k == "order": order = v
            elif k == "limit": limit = int(v)
            elif k == "offset": offset = int(v)
            elif k == "on_conflict": on_conflict = v
            elif k == "columns": pass
            else: filters.append((k, v))
        prefer = self.headers.get("Prefer") or ""
        try:
            with db() as c:
                cols = {r["attname"]: r["t"] for r in c.execute(
                    "select attname, format_type(atttypid, atttypmod) t from pg_attribute where attrelid = %s::regclass and attnum > 0 and not attisdropped",
                    [f"public.{name}"]).fetchall()}
                where, vals = self.where(filters, cols)
                if select != "*":
                    sel = [s.strip() for s in select.split(",")]
                    if any(s not in cols for s in sel): return self.send(400, {"message": "unsupported select: " + select})
                    select_sql = ", ".join(sel)
                else:
                    select_sql = "*"
                self.role_tx(c)
                if method == "GET":
                    sql = f"select {select_sql} from public.{name}{where}"
                    if order:
                        parts = []
                        for o in order.split(","):
                            bits = o.split(".")
                            if bits[0] not in cols: return self.send(400, {"message": "bad order"})
                            parts.append(bits[0] + (" desc" if "desc" in bits[1:] else " asc") + (" nulls last" if "nullslast" in bits[1:] else ""))
                        sql += " order by " + ", ".join(parts)
                    if limit is not None: sql += f" limit {int(limit)}"
                    if offset is not None: sql += f" offset {int(offset)}"
                    rows = c.execute(sql, vals).fetchall()
                    c.commit()
                    if "vnd.pgrst.object" in (self.headers.get("Accept") or ""):
                        if len(rows) != 1: return self.send(406, {"code": "PGRST116", "message": "JSON object requested, multiple (or no) rows returned"})
                        return self.send(200, rows[0])
                    return self.send(200, rows)
                if method == "POST":
                    data = self.jbody()
                    rows = data if isinstance(data, list) else [data]
                    if not rows: return self.send(201, [])
                    keys = list(rows[0].keys())
                    if any(k not in cols for k in keys): return self.send(400, {"message": "unknown column"})
                    collist = ", ".join(keys)
                    sql = f"insert into public.{name} ({collist}) select {collist} from jsonb_populate_recordset(null::public.{name}, %s::jsonb)"
                    if "resolution=merge-duplicates" in prefer or "resolution=ignore-duplicates" in prefer:
                        conf = on_conflict or c.execute("""select string_agg(a.attname, ',') k from pg_index i join pg_attribute a
                                 on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = %s::regclass and i.indisprimary""",
                                                        [f"public.{name}"]).fetchone()["k"]
                        if "ignore-duplicates" in prefer:
                            sql += f" on conflict ({conf}) do nothing"
                        else:
                            upd = ", ".join(f"{k} = excluded.{k}" for k in keys if k not in conf.split(","))
                            sql += f" on conflict ({conf}) do " + (f"update set {upd}" if upd else "nothing")
                    sql += " returning *"
                    out = c.execute(sql, [json.dumps(rows)]).fetchall()
                    c.commit()
                    return self.send(201, out if "return=representation" in prefer else None)
                if method == "PATCH":
                    data = self.jbody()
                    if not where: return self.send(400, {"message": "PATCH needs a filter"})
                    keys = [k for k in data if k in cols]
                    sets = ", ".join(f"{k} = r.{k}" for k in keys)
                    where_t, vals_t = self.where(filters, cols, alias="t")
                    sql = f"update public.{name} t set {sets} from jsonb_populate_record(null::public.{name}, %s::jsonb) r{where_t} returning t.*"
                    out = c.execute(sql, [json.dumps(data)] + vals_t).fetchall()
                    c.commit()
                    return self.send(200, out if "return=representation" in prefer else None)
                if method == "DELETE":
                    if not where: return self.send(400, {"message": "DELETE needs a filter"})
                    out = c.execute(f"delete from public.{name}{where} returning *", vals).fetchall()
                    c.commit()
                    return self.send(200, out if "return=representation" in prefer else None)
        except Exception as e:
            return self.pg_error(e)
        return self.send(405, {"message": "method not allowed"})

    def where(self, filters, cols, alias=None):
        parts, vals = [], []
        for col, expr in filters:
            if col not in cols: raise ValueError("unknown column " + col)
            neg = expr.startswith("not.")
            if neg: expr = expr[4:]
            op, _, val = expr.partition(".")
            t = cols[col]
            q = f"{alias}.{col}" if alias else col
            col_ = col; col = q
            if op in ("eq", "neq", "gt", "gte", "lt", "lte"):
                sym = {"eq": "=", "neq": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
                p, v = f"{col} {sym} %s::{t}", [val]
            elif op == "in":
                items = [x.strip().strip('"') for x in val.strip("()").split(",") if x.strip()]
                p, v = f"{col} = any(%s::{t}[])", [items]
            elif op == "is":
                p, v = f"{col} is {dict(null='null', true='true', false='false')[val]}", []
            elif op in ("like", "ilike"):
                p, v = f"{col}::text {op} %s", [val.replace("*", "%")]
            elif op in ("cs", "ov"):
                p, v = f"{col} {'@>' if op == 'cs' else '&&'} %s::{t}", [val]
            else:
                raise ValueError("unsupported filter " + op)
            parts.append(("not " if neg else "") + p)
            vals += v
            col = col_
        return ((" where " + " and ".join(parts)) if parts else ""), vals

    # ---------- storage ----------
    def storage(self, method, sub):
        cl = self.claims() or {"role": "anon"}
        role = cl.get("role", "anon")
        m = re.match(r"^object/list/([a-z0-9_-]+)$", sub)
        if m and method == "POST":
            if role != "service_role": return self.send(403, {"message": "mock: list is for the service role only"})
            b = self.jbody()
            prefix = (b.get("prefix") or "").strip("/")
            with db() as c:
                rows = c.execute("select name, id, metadata, updated_at, created_at from storage.objects where bucket_id=%s and name like %s order by name",
                                 [m.group(1), (prefix + "/" if prefix else "") + "%"]).fetchall()
            out = []
            for r in rows:
                rel = r["name"][len(prefix) + 1:] if prefix else r["name"]
                if "/" in rel: continue
                out.append({"name": rel, "id": r["id"], "metadata": r["metadata"], "updated_at": r["updated_at"], "created_at": r["created_at"]})
            lim, off = int(b.get("limit") or 100), int(b.get("offset") or 0)
            return self.send(200, out[off:off + lim])
        m = re.match(r"^object/([a-z0-9_-]+)$", sub)
        if m and method == "DELETE":
            if role != "service_role": return self.send(403, {"message": "mock: delete is for the service role only"})
            names = self.jbody().get("prefixes") or []
            with db() as c:
                for n in names:
                    c.execute("delete from storage.objects where bucket_id=%s and name=%s", [m.group(1), n])
                    fp = os.path.join(ARGS.storage, m.group(1), n)
                    if os.path.exists(fp): os.remove(fp)
                c.commit()
            return self.send(200, [{"name": n} for n in names])
        m = re.match(r"^object/(?:authenticated/)?([a-z0-9_-]+)/(.+)$", sub)
        if not m: return self.send(404, {"message": "storage endpoint not implemented in mock: " + sub})
        bucket, name = m.group(1), urllib.parse.unquote(m.group(2))
        fp = os.path.join(ARGS.storage, bucket, name)
        if method in ("POST", "PUT"):
            if role != "service_role": return self.send(403, {"statusCode": "403", "error": "Unauthorized", "message": "new row violates row-level security policy"})
            data = self.body()
            os.makedirs(os.path.dirname(fp), exist_ok=True)
            with open(fp, "wb") as f: f.write(data)
            with db() as c:
                c.execute("""insert into storage.objects (bucket_id, name, metadata) values (%s, %s, %s)
                             on conflict (bucket_id, name) do update set metadata = excluded.metadata, updated_at = now()""",
                          [bucket, name, json.dumps({"size": len(data), "mimetype": self.headers.get("Content-Type")})])
                c.commit()
            return self.send(200, {"Key": f"{bucket}/{name}"})
        if method == "GET":
            if role != "service_role":
                try:
                    with db() as c:
                        self.role_tx(c)
                        ok = c.execute("select 1 from storage.objects where bucket_id=%s and name=%s", [bucket, name]).fetchone()
                        c.commit()
                except PermissionError:
                    ok = None
                if not ok:
                    return self.send(400, {"statusCode": "404", "error": "not_found", "message": "Object not found"})
            if not os.path.exists(fp):
                return self.send(400, {"statusCode": "404", "error": "not_found", "message": "Object not found"})
            ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
            return self.send(200, raw=open(fp, "rb").read(), ctype=ctype)
        return self.send(405, {"message": "method not allowed"})


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", default="postgresql://postgres@/radar?host=/tmp/pg&port=54329")
    ap.add_argument("--port", type=int, default=8800)
    ap.add_argument("--root", default=os.path.join(os.path.dirname(__file__), ".."))
    ap.add_argument("--storage", default="/tmp/mock_storage")
    ap.add_argument("--verbose", action="store_true")
    ARGS = ap.parse_args()
    ARGS.root = os.path.abspath(ARGS.root)
    os.makedirs(ARGS.storage, exist_ok=True)
    print(f"Mock Supabase on http://localhost:{ARGS.port}  (dashboard at /)")
    print(f"ANON_KEY={ANON_KEY}\nSERVICE_KEY={SERVICE_KEY}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", ARGS.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
