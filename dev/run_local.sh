#!/usr/bin/env bash
# =====================================================================
#  Local test environment - no Supabase account or internet needed.
#    1. PostgreSQL (local) with dev/supabase_shim.sql + supabase/schema.sql
#    2. dev/mock_supabase.py on http://localhost:$MOCK_PORT (also serves the dashboard)
#    3. fake WhoisDS data + the real daily job (offline network fakes)
#    4. optionally the test suites:  ./dev/run_local.sh test
#
#  Test logins (password pass1234): owner@test.com (admin), ann@test.com (user)
#  Needs: PostgreSQL 14+ server binaries, Python 3.10+, pip install psycopg[binary] PyJWT httpx dnspython
#         for "test": pip install playwright && playwright install chromium, and npm i @supabase/supabase-js jszip
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BIN=${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
PGDIR=${PGDIR:-/tmp/pg}
PGPORT=${PGPORT:-54329}
MOCK_PORT=${MOCK_PORT:-8800}
CACHE=${CACHE:-/tmp/dr_cache}
DSN="postgresql://postgres@/radar?host=$PGDIR&port=$PGPORT"
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else bash -c "$*"; fi; }

echo "== PostgreSQL ($PGDIR:$PGPORT)"
if ! "$PG_BIN/pg_isready" -h "$PGDIR" -p "$PGPORT" -q 2>/dev/null; then
  mkdir -p "$PGDIR"; [ "$(id -u)" = 0 ] && chown postgres "$PGDIR"
  [ -f "$PGDIR/data/PG_VERSION" ] || as_pg "$PG_BIN/initdb -D $PGDIR/data -A trust -U postgres >/dev/null"
  as_pg "$PG_BIN/pg_ctl -D $PGDIR/data -o '-p $PGPORT -k $PGDIR' -l $PGDIR/log start >/dev/null"
  sleep 2
fi
export PGHOST=$PGDIR PGPORT PGUSER=postgres
dropdb --if-exists radar; createdb radar
psql -d radar -q -v ON_ERROR_STOP=1 -f dev/supabase_shim.sql 2>/dev/null
sed "s/YOUR_EMAIL@example.com/owner@test.com/" supabase/schema.sql | psql -d radar -q -v ON_ERROR_STOP=1 -f - 2>&1 | grep -v NOTICE | grep -v "^$" | tail -2
psql -d radar -q -c "insert into auth.users (email, encrypted_password) values
  ('owner@test.com', extensions.crypt('pass1234', extensions.gen_salt('bf'))),
  ('ann@test.com',   extensions.crypt('pass1234', extensions.gen_salt('bf')));
  update profiles set status = 'active' where email = 'ann@test.com';
  insert into seeds (user_id, name, keywords) select id, 'Chimney', '{chimney,flue}' from profiles where email = 'ann@test.com';"

echo "== mock Supabase on :$MOCK_PORT"
pkill -f "mock_supabase.py.*--port $MOCK_PORT" 2>/dev/null || true
rm -rf /tmp/mock_storage
python3 dev/mock_supabase.py --dsn "$DSN" --port "$MOCK_PORT" --root . > /tmp/mock_supabase.log 2>&1 &
sleep 1.5
export SUPABASE_URL="http://localhost:$MOCK_PORT"
export SUPABASE_SERVICE_KEY=$(grep SERVICE_KEY /tmp/mock_supabase.log | cut -d= -f2)

echo "== sample data + daily job"
rm -rf "$CACHE"; mkdir -p "$CACHE/zip"
python3 dev/make_sample_data.py --out "$CACHE/zip" --days "${DAYS:-10}" | tail -1
python3 scripts/run_daily.py --data "$CACHE" --skip-download --fake-network --max-checks "${MAX_CHECKS:-1500}" | grep -v "check failed" | tail -9

if [ "${1:-}" = "test" ]; then
  echo "== tests"
  python3 dev/test_database.py "$DSN" | tail -1
  # test_database wipes users; rebuild the web environment for the browser test
  "$0"
  python3 dev/test_leads.py | tail -1
  python3 dev/e2e_test.py --base "http://localhost:$MOCK_PORT" --shots /tmp/shots
  exit $?
fi
echo
echo "Open http://localhost:$MOCK_PORT  -  owner@test.com / pass1234 (admin), ann@test.com / pass1234"
