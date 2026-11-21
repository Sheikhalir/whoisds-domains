#!/usr/bin/env python3
"""Security + function tests for supabase/schema.sql on a local PostgreSQL.

    python dev/test_database.py "postgresql://postgres@/radar?host=/tmp/pg&port=54329"

The database must already have dev/supabase_shim.sql and supabase/schema.sql
loaded (dev/run_local.sh does this). Each check prints PASS/FAIL.
"""
import json
import sys
import uuid

import psycopg

DSN = sys.argv[1] if len(sys.argv) > 1 else "postgresql://postgres@/radar?host=/tmp/pg&port=54329"
conn = psycopg.connect(DSN, autocommit=True)
fails = 0


def check(name, ok, info=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + (f"  ({info})" if info and not ok else ""))
    fails += 0 if ok else 1


def as_role(role, uid=None):
    """Context: run statements as anon/authenticated/service_role with JWT claims, like PostgREST does."""
    class Ctx:
        def __enter__(self):
            self.tx = conn.transaction(); self.tx.__enter__()
            self.cur = conn.cursor()
            claims = {"role": role}
            if uid: claims["sub"] = str(uid)
            self.cur.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(claims)])
            self.cur.execute(f"set local role {role}")
            return self.cur
        def __exit__(self, et, ev, tb):
            self.tx.__exit__(et, ev, tb)
            return False
    return Ctx()


def try_sql(role, uid, sql, args=None):
    try:
        with as_role(role, uid) as cur:
            cur.execute(sql, args or [])
            return ("ok", cur.fetchall() if cur.description else None)
    except Exception as e:
        return ("err", str(e).split("\n")[0])


def signup(email, name=None):
    try:
        with conn.cursor() as cur:
            cur.execute("insert into auth.users (email, encrypted_password, raw_user_meta_data) values (%s, extensions.crypt('pass1234', extensions.gen_salt('bf')), %s) returning id",
                        [email, json.dumps({"full_name": name or email.split("@")[0]})])
            return cur.fetchone()[0]
    except Exception as e:
        return "ERR:" + str(e).split("\n")[0]


def q1(sql, args=None):
    with conn.cursor() as cur:
        cur.execute(sql, args or [])
        return cur.fetchone()


# clean slate
with conn.cursor() as c:
    c.execute("delete from auth.users; delete from public.invites; delete from public.leads; delete from public.gaps; delete from public.activity;"
              "update public.app_settings set allow_requests = true, default_expiry_days = null;")

owner = signup("owner@test.com", "Owner")
check("owner sign-up becomes active admin", q1("select role, status from profiles where id=%s", [owner]) == ("admin", "active"))
req = signup("random@test.com")
check("unknown sign-up is pending", q1("select status from profiles where id=%s", [req])[0] == "pending")

st, _ = try_sql("authenticated", owner, "select public.admin_invite('Friend@Test.com', 'user', now() + interval '30 days', 'trial')")
check("admin can invite", st == "ok", _)
friend = signup("friend@test.com")
row = q1("select status, role, expires_at is not null from profiles where id=%s", [friend])
check("invited sign-up is active immediately with expiry", row == ("active", "user", True), row)
check("invite is consumed", q1("select count(*) from invites")[0] == 0)

st, _ = try_sql("authenticated", req, "select public.admin_invite('x@test.com')")
check("pending user cannot invite", st == "err" and "ADMIN_ONLY" in _, _)

with conn.cursor() as c: c.execute("update app_settings set allow_requests=false")
blocked = signup("stranger@test.com")
check("invite-only mode refuses unknown sign-ups", str(blocked).startswith("ERR:") and "SIGNUP_CLOSED" in blocked, blocked)
with conn.cursor() as c: c.execute("update app_settings set allow_requests=true")

# shared data
with conn.cursor() as c:
    c.execute("insert into leads (domain, found_date, niche_ids, loc, us_state, site_state, has_mx, score, phones) values "
              "('dallasroofing.com', current_date-1, '{roofing}', 'Dallas, TX', 'TX', 'no_site', true, 80, '{}'),"
              "('miamiplumbers.com', current_date-2, '{plumbing}', 'Miami, FL', 'FL', 'live', true, 40, '{+13055550100}'),"
              "('oldtree.com', current_date-50, '{tree}', null, null, 'parked', false, 20, '{}')")
    c.execute("insert into storage.objects (bucket_id, name, metadata) values ('daily', 'index.json', '{\"size\": 10}') on conflict do nothing")
    c.execute("insert into gaps (domain, niche_id, location, us_state, demand, status) values ('dallasroofer.com','roofing','Dallas, TX','TX',12,'available'),('dallasroof.com','roofing','Dallas, TX','TX',12,'taken')")

st, _ = try_sql("anon", None, "select count(*) from leads")
check("anon cannot read leads", st == "err" and "permission denied" in _, _)
st, r = try_sql("anon", None, "select public.get_public_settings()")
check("anon can read public settings", st == "ok" and r[0][0]["allow_requests"] is True, r)
st, _ = try_sql("anon", None, "select count(*) from storage.objects")
check("anon cannot see stored files", st == "ok" and _[0][0] == 0 or st == "err", _)
st, _ = try_sql("anon", None, "select public.search_leads('{}')")
check("anon cannot search leads", st == "err", _)

st, r = try_sql("authenticated", req, "select count(*) from leads")
check("pending user sees no leads", st == "ok" and r[0][0] == 0, r)
st, r = try_sql("authenticated", req, "select count(*) from storage.objects")
check("pending user sees no files", st == "ok" and r[0][0] == 0, r)
st, r = try_sql("authenticated", req, "select public.my_profile()")
check("pending user can read own profile", st == "ok" and r[0][0]["status"] == "pending" and r[0][0]["is_active"] is False, r)
st, _ = try_sql("authenticated", req, "select public.set_my_leads(array['a.com'], '{\"fav\": true}')")
check("pending user cannot save favorites", st == "err" and "NOT_ACTIVE" in _, _)

st, r = try_sql("authenticated", friend, "select count(*) from leads")
check("active user reads leads", st == "ok" and r[0][0] == 3, r)
st, r = try_sql("authenticated", friend, "select count(*) from storage.objects")
check("active user reads files", st == "ok" and r[0][0] >= 1, r)
st, _ = try_sql("authenticated", friend, "update profiles set role='admin' where id=auth.uid()")
check("user cannot make themselves admin", st == "err" and "permission denied" in _, _)
st, _ = try_sql("authenticated", friend, "insert into leads (domain, found_date) values ('x.com', current_date)")
check("user cannot write shared leads", st == "err", _)
st, r = try_sql("authenticated", friend, "select count(*) from profiles")
check("user sees only own profile", st == "ok" and r[0][0] == 1, r)
st, _ = try_sql("authenticated", friend, "select public.admin_list_users()")
check("user cannot list users", st == "err" and "ADMIN_ONLY" in _, _)
st, _ = try_sql("authenticated", friend, "select * from public.job_active_seeds()")
check("user cannot call job functions", st == "err" and "permission denied" in _, _)
st, _ = try_sql("authenticated", friend, "select count(*) from activity")
check("user cannot read the activity log", st == "ok" and _[0][0] == 0, _)

# favorites / CRM
st, _ = try_sql("authenticated", friend, "select public.set_my_leads(array['dallasroofing.com'], '{\"fav\": true, \"status\": \"contacted\", \"note\": \"called\", \"follow_up\": \"2000-01-01\"}')")
check("user saves favorite + CRM", st == "ok", _)
st, _ = try_sql("authenticated", friend, "select public.set_my_leads(array['oldtree.com'], '{\"discarded\": true}')")
st, r = try_sql("authenticated", friend, "select public.search_leads('{\"view\": \"all\"}')")
res = r[0][0] if st == "ok" else {}
check("search hides discarded, sorts by score", st == "ok" and [x["domain"] for x in res["rows"]] == ["dallasroofing.com", "miamiplumbers.com"], res)
check("search joins my CRM status", st == "ok" and res["rows"][0]["status"] == "contacted" and res["rows"][0]["fav"] is True, res.get("rows"))
check("search counts follow-ups due + need-site", st == "ok" and res["followups_due"] == 1 and res["need_site"] == 1, res)
st, r = try_sql("authenticated", friend, "select public.search_leads('{\"view\": \"pipeline\"}')")
check("pipeline view = tracked only", st == "ok" and r[0][0]["total"] == 1, r)
st, r = try_sql("authenticated", friend, "select public.search_leads('{\"site_states\": [\"live\"], \"has_contact\": true}')")
check("filters site state + contact", st == "ok" and [x["domain"] for x in r[0][0]["rows"]] == ["miamiplumbers.com"], r)
st, r = try_sql("authenticated", owner, "select public.search_leads('{\"view\": \"pipeline\"}')")
check("other users don't see my pipeline", st == "ok" and r[0][0]["total"] == 0, r)
st, _ = try_sql("authenticated", friend, "select public.set_my_leads(array['dallasroofing.com'], '{\"fav\": false, \"status\": null, \"note\": null, \"follow_up\": null}')")
check("clearing everything removes the row", q1("select count(*) from user_leads where domain='dallasroofing.com'")[0] == 0)

# gaps + geo
st, r = try_sql("authenticated", friend, "select count(*) from public.get_gaps('{}')")
check("gap finder returns available only by default", st == "ok" and r[0][0] == 1, r)

# seeds
st, r = try_sql("authenticated", friend, "select name, keywords, exclude, sig from public.save_my_seeds(%s)",
                [json.dumps([{"name": "Chimney", "keywords": ["Chimney", "flue sweep", "ab"], "exclude": ["-x"]}, {"keywords": ["stucco"]}])])
check("save seeds cleans keywords + builds signature", st == "ok" and r[0][1] == ["chimney", "fluesweep"] and r[0][3] == "chimney,fluesweep|x" and r[1][0] == "stucco", r)
sid = q1("select id from seeds where name='Chimney'")[0]
with conn.cursor() as c:
    c.execute("insert into seed_hits (seed_id, date, domain, kw) values (%s, current_date, 'chimneyguys.com', 'chimney')", [sid])
st, r = try_sql("authenticated", friend, "select count(*) from public.my_seed_hits(current_date-7, current_date)")
check("seed hits hidden until processed with current keywords", st == "ok" and r[0][0] == 0, r)
with conn.cursor() as c: c.execute("update seeds set processed_sig = sig where id=%s", [sid])
st, r = try_sql("authenticated", friend, "select count(*) from public.my_seed_hits(current_date-7, current_date)")
check("seed hits visible after processing", st == "ok" and r[0][0] == 1, r)
st, r = try_sql("authenticated", owner, "select count(*) from seed_hits")
check("other users cannot see my seed hits", st == "ok" and r[0][0] == 0, r)
st, r = try_sql("authenticated", friend, "select id, name from public.save_my_seeds(%s)", [json.dumps([{"id": str(sid), "name": "Chimney", "keywords": ["chimney", "fluesweep"], "exclude": ["x"]}])])
check("re-saving keeps seed id, removes dropped seeds", st == "ok" and len(r) == 1 and r[0][0] == sid, r)

# admin management
st, _ = try_sql("authenticated", owner, "select public.admin_update_user(%s, '{\"role\": \"user\"}')", [owner])
check("admin cannot demote self", st == "err" and "CANNOT_CHANGE_SELF" in _, _)
st, _ = try_sql("authenticated", owner, "select public.admin_update_user(%s, '{\"status\": \"active\"}')", [req])
check("admin approves pending user", st == "ok" and q1("select status, approved_by from profiles where id=%s", [req]) == ("active", owner), _)
with conn.cursor() as c: c.execute("update app_settings set default_expiry_days = 14")
second = signup("second@test.com")
st, _ = try_sql("authenticated", owner, "select public.admin_update_user(%s, '{\"status\": \"active\"}')", [second])
days = q1("select round(extract(epoch from expires_at - now())/86400) from profiles where id=%s", [second])[0]
check("approval applies default access length", st == "ok" and days == 14, days)
st, _ = try_sql("authenticated", owner, "select public.admin_update_user(%s, '{\"expires_at\": \"2000-01-01T00:00:00Z\"}')", [friend])
st2, r = try_sql("authenticated", friend, "select count(*) from leads")
check("expired user loses access", st == "ok" and st2 == "ok" and r[0][0] == 0, (st, r))
st, r = try_sql("authenticated", friend, "select public.my_profile()")
check("expired user sees is_expired", r[0][0]["is_expired"] is True, r)
try_sql("authenticated", owner, "select public.admin_update_user(%s, '{\"expires_at\": null, \"status\": \"disabled\"}')", [friend])
st, r = try_sql("authenticated", friend, "select count(*) from leads")
check("disabled user loses access", r[0][0] == 0, r)
try_sql("authenticated", owner, "select public.admin_update_user(%s, '{\"status\": \"active\", \"role\": \"admin\"}')", [friend])
st, _ = try_sql("authenticated", friend, "select public.admin_update_user(%s, '{\"status\": \"disabled\"}')", [owner])
check("owner cannot be disabled by another admin", st == "err" and "OWNER_PROTECTED" in _, _)
try_sql("authenticated", owner, "select public.admin_update_user(%s, '{\"role\": \"user\"}')", [friend])

st, _ = try_sql("authenticated", owner, "select public.admin_set_password(%s, 'newpass99')", [req])
ok_pw = q1("select encrypted_password = extensions.crypt('newpass99', encrypted_password) from auth.users where id=%s", [req])[0]
check("admin sets temporary password (bcrypt) + forces change", st == "ok" and ok_pw and q1("select must_change_password from profiles where id=%s", [req])[0], _)
try_sql("authenticated", req, "select public.password_changed()")
check("user clears the change-password flag", not q1("select must_change_password from profiles where id=%s", [req])[0])

st, r = try_sql("authenticated", owner, "select public.admin_list_users()")
check("admin lists users with stats", st == "ok" and len(r[0][0]) == 4 and "events_30d" in r[0][0][0], r if st != "ok" else "")
try_sql("authenticated", friend, "select public.log_event('login', '{}')")
try_sql("authenticated", friend, "select public.log_event('view', '{\"tab\": \"leads\"}')")
try_sql("authenticated", friend, "select public.log_event('export_csv', '{\"rows\": 25}')")
try_sql("authenticated", friend, "select public.log_event('niche_select', '{\"niches\": [\"roofing\"]}')")
st, r = try_sql("authenticated", owner, "select public.admin_stats(30)")
s = r[0][0] if st == "ok" else {}
check("admin stats", st == "ok" and s["users"]["total"] == 4 and s["active_7d"] >= 1 and s["exports"] == 25 and s["tabs"][0]["tab"] == "leads"
      and s["niches"][0]["niche"] == "roofing" and s["data"]["leads"] == 3, s)
st, r = try_sql("authenticated", owner, "select public.admin_activity('{\"action\": \"login\"}')")
check("admin reads activity log", st == "ok" and len(r[0][0]) == 1 and r[0][0][0]["email"] == "friend@test.com", r)
check("last_seen / last_login updated", q1("select last_seen_at is not null and last_login_at is not null from profiles where id=%s", [friend])[0])

st, _ = try_sql("authenticated", owner, "select public.admin_delete_user(%s)", [owner])
check("admin cannot delete self", st == "err", _)
st, _ = try_sql("authenticated", owner, "select public.admin_delete_user(%s)", [second])
check("admin deletes user (auth + profile)", st == "ok" and q1("select count(*) from auth.users where id=%s", [second])[0] == 0
      and q1("select count(*) from profiles where id=%s", [second])[0] == 0, _)
st, _ = try_sql("authenticated", owner, "select public.admin_invite('friend@test.com')")
check("cannot invite an existing user", st == "err" and "ALREADY_USER" in _, _)
st, r = try_sql("authenticated", owner, "select public.admin_update_settings('{\"site_title\": \"My Radar\", \"allow_requests\": false, \"default_expiry_days\": \"\"}')")
check("admin updates settings", st == "ok" and r[0][0]["site_title"] == "My Radar" and r[0][0]["default_expiry_days"] is None, r)

# feature access (per user: hidden / locked, enforced by RLS + functions)
with conn.cursor() as c:
    c.execute("insert into storage.objects (bucket_id, name, metadata) values ('daily', 'zip/2026-01-01.zip', '{}'), ('daily', 'niches/2026-01-01.json', '{}') on conflict do nothing")
    c.execute("insert into geo_daily (date, niche_id, loc, us_state, n) values (current_date, 'roofing', 'Dallas, TX', 'TX', 5) on conflict do nothing")
st, _ = try_sql("authenticated", owner, "select public.admin_invite('limited@test.com', 'user', null, null, %s)",
                [json.dumps({"leads": "hidden", "daily": "locked", "bogus": "hidden", "niche": "weird"})])
check("admin invites with feature restrictions", st == "ok", _)
limited = signup("limited@test.com")
check("invite features applied + cleaned", q1("select features from profiles where id=%s", [limited])[0] == {"leads": "hidden", "daily": "locked"},
      q1("select features from profiles where id=%s", [limited]))
st, r = try_sql("authenticated", limited, "select public.my_profile() -> 'features'")
check("user sees own features in my_profile", st == "ok" and r[0][0] == {"leads": "hidden", "daily": "locked"}, r)
st, r = try_sql("authenticated", limited, "select count(*) from leads")
check("no Leads access: leads table empty", st == "ok" and r[0][0] == 0, r)
st, _ = try_sql("authenticated", limited, "select public.search_leads('{}')")
check("no Leads access: search_leads refused", st == "err" and "NO_ACCESS" in _, _)
st, r = try_sql("authenticated", limited, "select count(*) from public.get_gaps('{\"status\": \"all\"}')")
check("no Leads access: gap finder empty", st == "ok" and r[0][0] == 0, r)
st, r = try_sql("authenticated", limited, "select array_agg(name order by name) from storage.objects")
folders = lambda names: sorted({n.split("/")[0] if "/" in n else n for n in names or []})
check("no Daily Files access: zips hidden, index + niche files readable", st == "ok" and folders(r[0][0]) == ["index.json", "niches"], r)
st, r = try_sql("authenticated", limited, "select count(*) from public.geo_summary(current_date - 1, current_date)")
check("Research still allowed", st == "ok" and r[0][0] == 1, r)
st, _ = try_sql("authenticated", limited, "update profiles set features = '{}' where id = auth.uid()")
check("user cannot clear own restrictions", st == "err" and "permission denied" in _, _)
st, _ = try_sql("authenticated", limited, "select public.admin_update_user(%s, '{\"features\": {}}')", [limited])
check("user cannot call admin_update_user", st == "err" and "ADMIN_ONLY" in _, _)
st, r = try_sql("authenticated", owner, "select public.admin_update_user(%s, %s)", [limited, json.dumps({"features": {"research": "locked", "niche": "hidden"}})])
check("admin changes feature access", st == "ok" and r[0][0]["features"] == {"research": "locked", "niche": "hidden"}, r)
st, r = try_sql("authenticated", limited, "select count(*) from leads")
st2, r2 = try_sql("authenticated", limited, "select count(*) from public.geo_summary(current_date - 1, current_date)")
st3, r3 = try_sql("authenticated", limited, "select array_agg(name order by name) from storage.objects")
check("new access applies immediately (leads on, research + niche off)", st == "ok" and r[0][0] > 0 and st2 == "ok" and r2[0][0] == 0
      and st3 == "ok" and folders(r3[0][0]) == ["index.json", "zip"], (r, r2, r3))
st, r = try_sql("authenticated", limited, "select count(*) from public.seed_daily_counts(current_date - 30, current_date)")
check("no Research access: seed_daily_counts empty", st == "ok" and r[0][0] == 0, r)
with conn.cursor() as c: c.execute("update profiles set features = '{\"leads\": \"hidden\"}' where id = %s", [owner])
st, r = try_sql("authenticated", owner, "select count(*) from leads")
check("admins always have every feature", st == "ok" and r[0][0] > 0, r)
with conn.cursor() as c: c.execute("update profiles set features = '{}' where id = %s", [owner])
st, r = try_sql("authenticated", owner, "select public.admin_update_settings(%s)", [json.dumps({"allow_requests": True, "default_features": {"daily": "hidden", "x": "y"}})])
check("admin sets default feature access", st == "ok" and r[0][0]["default_features"] == {"daily": "hidden"}, r)
req2 = signup("asker@test.com")
check("access requests get the default features", q1("select status, features from profiles where id=%s", [req2]) == ("pending", {"daily": "hidden"}),
      q1("select status, features from profiles where id=%s", [req2]))

# job (service role)
st, r = try_sql("service_role", None, "select count(*) from public.job_active_seeds()")
check("job reads active users' seeds", st == "ok" and r[0][0] == 1, r)
st, r = try_sql("service_role", None, "select public.job_prune(30)")
check("job prune (keeps recent, drops old untracked)", st == "ok" and r[0][0]["leads"] == 1, r)

print("\n" + ("ALL PASSED" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
