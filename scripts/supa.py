"""Minimal Supabase client for the daily job (service role key).

Uses Supabase's HTTP APIs directly: PostgREST (/rest/v1) and Storage (/storage/v1).
Works with both key formats: legacy JWT keys (eyJ...) and new secret keys (sb_secret_...).
"""
import json
import time
import urllib.parse

import httpx


class SupaError(RuntimeError):
    pass


class Supa:
    def __init__(self, url, key, timeout=60):
        if not url or not key:
            raise SupaError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (GitHub -> Settings -> Secrets -> Actions)")
        self.url = url.rstrip("/")
        h = {"apikey": key}
        if key.startswith("eyJ"):           # legacy JWT key: also send as bearer token
            h["Authorization"] = "Bearer " + key
        self.http = httpx.Client(headers=h, timeout=timeout)

    # ---------- low level ----------
    def _req(self, method, path, **kw):
        last = None
        for attempt in range(4):
            try:
                r = self.http.request(method, self.url + path, **kw)
            except httpx.HTTPError as e:
                last = e
                time.sleep(2 * (attempt + 1))
                continue
            if r.status_code >= 500 or r.status_code == 429:
                last = SupaError(f"{method} {path}: {r.status_code} {r.text[:300]}")
                time.sleep(2 * (attempt + 1))
                continue
            return r
        raise SupaError(f"{method} {path} failed: {last}")

    def _ok(self, r, what):
        if r.status_code >= 400:
            raise SupaError(f"{what}: HTTP {r.status_code} {r.text[:500]}")
        if not r.content:
            return None
        try:
            return r.json()
        except ValueError:
            return r.content

    # ---------- database ----------
    def rpc(self, fn, **args):
        return self._ok(self._req("POST", f"/rest/v1/rpc/{fn}", json=args), f"rpc {fn}")

    def select(self, table, params=None):
        """params: PostgREST query params, e.g. {"select": "*", "date": "eq.2026-01-01", "order": "score.desc", "limit": 100}"""
        out, offset, page = [], 0, 1000
        params = dict(params or {})
        want = int(params.pop("limit", 0)) or None
        while True:
            p = dict(params, limit=min(page, want - len(out)) if want else page, offset=offset)
            rows = self._ok(self._req("GET", f"/rest/v1/{table}", params=p), f"select {table}") or []
            out += rows
            if len(rows) < p["limit"] or (want and len(out) >= want):
                return out
            offset += len(rows)

    def upsert(self, table, rows, on_conflict=None, ignore_duplicates=False, chunk=500):
        rows = list(rows)
        if not rows:
            return 0
        prefer = "resolution=ignore-duplicates" if ignore_duplicates else "resolution=merge-duplicates"
        params = {"on_conflict": on_conflict} if on_conflict else None
        for i in range(0, len(rows), chunk):
            self._ok(self._req("POST", f"/rest/v1/{table}", params=params, json=rows[i:i + chunk],
                               headers={"Prefer": prefer + ",return=minimal"}), f"upsert {table}")
        return len(rows)

    def insert(self, table, row, returning=True):
        r = self._ok(self._req("POST", f"/rest/v1/{table}", json=row,
                               headers={"Prefer": "return=representation" if returning else "return=minimal"}), f"insert {table}")
        return r[0] if isinstance(r, list) and r else r

    def update(self, table, filters, patch):
        return self._ok(self._req("PATCH", f"/rest/v1/{table}", params=filters, json=patch,
                                  headers={"Prefer": "return=minimal"}), f"update {table}")

    def delete(self, table, filters):
        if not filters:
            raise SupaError("refusing to delete without a filter")
        return self._ok(self._req("DELETE", f"/rest/v1/{table}", params=filters, headers={"Prefer": "return=minimal"}), f"delete {table}")

    # ---------- storage ----------
    def upload(self, bucket, path, data, content_type="application/octet-stream"):
        r = self._req("POST", f"/storage/v1/object/{bucket}/{urllib.parse.quote(path)}", content=data,
                      headers={"Content-Type": content_type, "x-upsert": "true", "Cache-Control": "max-age=60"})
        return self._ok(r, f"upload {path}")

    def download(self, bucket, path):
        r = self._req("GET", f"/storage/v1/object/{bucket}/{urllib.parse.quote(path)}")
        if r.status_code in (400, 404):
            return None
        self._ok(r, f"download {path}")
        return r.content

    def list(self, bucket, prefix=""):
        out, offset = [], 0
        while True:
            rows = self._ok(self._req("POST", f"/storage/v1/object/list/{bucket}",
                                      json={"prefix": prefix, "limit": 1000, "offset": offset, "sortBy": {"column": "name", "order": "asc"}}),
                            f"list {prefix}") or []
            out += [r for r in rows if r.get("id")]   # entries without id are folders
            if len(rows) < 1000:
                return out
            offset += len(rows)

    def remove(self, bucket, paths):
        if paths:
            return self._ok(self._req("DELETE", f"/storage/v1/object/{bucket}", json={"prefixes": list(paths)}), "remove")
