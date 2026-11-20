-- =====================================================================
--  DOMAIN RADAR - Supabase database setup
--  Run this whole file in Supabase -> SQL Editor -> New query -> Run.
--  It is safe to run again later (for example after an update).
--
--  >>> STEP 1: replace the email on the line marked "OWNER EMAIL" with YOUR
--      email. When you sign up with that email you become the admin.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Settings (one row)
-- ---------------------------------------------------------------------
create table if not exists public.app_settings (
  id                  int primary key default 1 check (id = 1),
  owner_email         text,
  site_title          text not null default 'Domain Radar',
  allow_requests      boolean not null default true,   -- false = invite-only
  default_expiry_days int,                             -- null = access never expires
  updated_at          timestamptz not null default now()
);

insert into public.app_settings (id, owner_email)
values (1, lower('YOUR_EMAIL@example.com'))                      -- <<< OWNER EMAIL
on conflict (id) do update
  set owner_email = case when excluded.owner_email <> 'your_email@example.com'
                         then excluded.owner_email else public.app_settings.owner_email end;

-- ---------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id                   uuid primary key references auth.users(id) on delete cascade,
  email                text not null,
  full_name            text,
  role                 text not null default 'user'    check (role in ('admin', 'user')),
  status               text not null default 'pending' check (status in ('pending', 'active', 'disabled')),
  expires_at           timestamptz,
  must_change_password boolean not null default false,
  notes                text,
  created_at           timestamptz not null default now(),
  approved_at          timestamptz,
  approved_by          uuid,
  last_seen_at         timestamptz,
  last_login_at        timestamptz
);
create index if not exists profiles_email_idx on public.profiles (lower(email));

create table if not exists public.invites (
  email      text primary key,
  role       text not null default 'user' check (role in ('admin', 'user')),
  expires_at timestamptz,
  note       text,
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.activity (
  id      bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete set null,
  email   text,
  action  text not null,
  detail  jsonb not null default '{}'::jsonb,
  at      timestamptz not null default now()
);
create index if not exists activity_at_idx on public.activity (at desc);
create index if not exists activity_user_idx on public.activity (user_id, at desc);
create index if not exists activity_action_idx on public.activity (action, at desc);

-- ---------------------------------------------------------------------
-- Per-user data: seed keywords, favorites / discards / CRM pipeline
-- ---------------------------------------------------------------------
create table if not exists public.seeds (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  name          text not null,
  keywords      text[] not null,
  exclude       text[] not null default '{}',
  sig           text,            -- "kw1,kw2|ex1" (sorted) - set by trigger
  processed_sig text,            -- sig the daily job last processed
  processed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists seeds_user_idx on public.seeds (user_id);

create table if not exists public.seed_hits (
  seed_id uuid not null references public.seeds(id) on delete cascade,
  date    date not null,
  domain  text not null,
  kw      text,
  loc     text,
  primary key (seed_id, date, domain)
);
create index if not exists seed_hits_date_idx on public.seed_hits (date);

create table if not exists public.user_leads (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  domain     text not null,
  fav        boolean not null default false,
  discarded  boolean not null default false,
  status     text check (status in ('new', 'contacted', 'replied', 'meeting', 'won', 'lost')),
  note       text,
  follow_up  date,
  found_date date,
  niche_ids  text[],
  kws        text[],
  loc        text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, domain)
);
create index if not exists user_leads_followup_idx on public.user_leads (user_id, follow_up);

-- ---------------------------------------------------------------------
-- Shared data written by the daily job (service role)
-- ---------------------------------------------------------------------
create table if not exists public.leads (
  domain             text primary key,
  found_date         date not null,
  tld                text,
  niche_ids          text[] not null default '{}',
  kws                text[] not null default '{}',
  loc                text,
  us_state           text,
  source             text not null default 'niche',   -- niche | seed | favorite
  has_a              boolean,
  has_mx             boolean,
  mx_provider        text,
  site_state         text not null default 'unchecked',
       -- unchecked | no_site | parked | coming_soon | placeholder | redirect | live | error
  http_status        int,
  final_url          text,
  title              text,
  builder            text,
  phones             text[] not null default '{}',
  emails             text[] not null default '{}',
  socials            text[] not null default '{}',
  registrar          text,
  registrant_org     text,
  registrant_state   text,
  registrant_country text,
  rdap_checked_at    timestamptz,
  score              int not null default 0,
  score_reasons      text[] not null default '{}',
  checks             int not null default 0,
  stage              int not null default 0,
  last_checked_at    timestamptz,
  next_check_at      timestamptz,
  history            jsonb not null default '[]'::jsonb,
  updated_at         timestamptz not null default now()
);
create index if not exists leads_found_idx on public.leads (found_date desc);
create index if not exists leads_score_idx on public.leads (score desc);
create index if not exists leads_state_idx on public.leads (site_state);
create index if not exists leads_niches_idx on public.leads using gin (niche_ids);
create index if not exists leads_next_idx on public.leads (next_check_at) where next_check_at is not null;

create table if not exists public.gaps (
  domain     text primary key,
  niche_id   text not null,
  location   text not null,
  us_state   text,
  term       text,
  pattern    text,
  demand     int not null default 0,   -- registrations in this niche + place, last 30 days
  status     text not null default 'unknown' check (status in ('available', 'taken', 'unknown')),
  checked_at timestamptz not null default now()
);
create index if not exists gaps_demand_idx on public.gaps (status, demand desc);

create table if not exists public.geo_daily (
  date     date not null,
  niche_id text not null,
  loc      text not null,
  us_state text,
  n        int not null,
  primary key (date, niche_id, loc)
);

create table if not exists public.job_runs (
  id          bigint generated always as identity primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running' check (status in ('running', 'ok', 'error')),
  summary     jsonb not null default '{}'::jsonb,
  error       text
);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.status = 'active'
      and (p.expires_at is null or p.expires_at > now()));
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.status = 'active' and p.role = 'admin');
$$;

create or replace function public.seed_sig(p_keywords text[], p_exclude text[]) returns text
language sql immutable as $$
  select coalesce((select string_agg(k, ',' order by k collate "C") from unnest(p_keywords) k), '')
      || '|' ||
         coalesce((select string_agg(e, ',' order by e collate "C") from unnest(p_exclude) e), '');
$$;

create or replace function public.seeds_set_sig() returns trigger language plpgsql as $$
begin
  new.sig := public.seed_sig(new.keywords, new.exclude);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists seeds_sig_trg on public.seeds;
create trigger seeds_sig_trg before insert or update of keywords, exclude, name on public.seeds
  for each row execute function public.seeds_set_sig();

-- new sign-up -> profile (admin / invited / pending / refused)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  s   public.app_settings;
  inv public.invites;
  v_email text := lower(new.email);
  v_status text;
begin
  select * into s from public.app_settings where id = 1;
  select * into inv from public.invites where email = v_email;
  if s.owner_email is not null and v_email = s.owner_email then
    insert into public.profiles (id, email, full_name, role, status, approved_at)
    values (new.id, v_email, new.raw_user_meta_data ->> 'full_name', 'admin', 'active', now())
    on conflict (id) do nothing;
    v_status := 'owner';
  elsif inv.email is not null then
    insert into public.profiles (id, email, full_name, role, status, expires_at, approved_at, approved_by)
    values (new.id, v_email, new.raw_user_meta_data ->> 'full_name', inv.role, 'active', inv.expires_at, now(), inv.invited_by)
    on conflict (id) do nothing;
    delete from public.invites where email = v_email;
    v_status := 'invited';
  elsif coalesce(s.allow_requests, true) then
    insert into public.profiles (id, email, full_name, role, status)
    values (new.id, v_email, new.raw_user_meta_data ->> 'full_name', 'user', 'pending')
    on conflict (id) do nothing;
    v_status := 'requested';
  else
    raise exception 'SIGNUP_CLOSED: this tool is invite-only';
  end if;
  insert into public.activity (user_id, email, action, detail)
  values (new.id, v_email, 'signup', jsonb_build_object('how', v_status));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- users that existed before this script ran get a profile too
insert into public.profiles (id, email, role, status, approved_at)
select u.id, lower(u.email),
       case when lower(u.email) = (select owner_email from public.app_settings where id = 1) then 'admin' else 'user' end,
       case when lower(u.email) = (select owner_email from public.app_settings where id = 1) then 'active' else 'pending' end,
       case when lower(u.email) = (select owner_email from public.app_settings where id = 1) then now() end
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- the owner is always an active admin (fixes a mistyped owner email after re-running)
update public.profiles set role = 'admin', status = 'active', expires_at = null
where email = (select owner_email from public.app_settings where id = 1);

-- ---------------------------------------------------------------------
-- Row level security: who can read / write what
-- ---------------------------------------------------------------------
alter table public.app_settings enable row level security;
alter table public.profiles     enable row level security;
alter table public.invites      enable row level security;
alter table public.activity     enable row level security;
alter table public.seeds        enable row level security;
alter table public.seed_hits    enable row level security;
alter table public.user_leads   enable row level security;
alter table public.leads        enable row level security;
alter table public.gaps         enable row level security;
alter table public.geo_daily    enable row level security;
alter table public.job_runs     enable row level security;

drop policy if exists "admin reads settings" on public.app_settings;
create policy "admin reads settings" on public.app_settings for select to authenticated using (public.is_admin());

drop policy if exists "own profile or admin" on public.profiles;
create policy "own profile or admin" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists "admin manages invites" on public.invites;
create policy "admin manages invites" on public.invites for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin reads activity" on public.activity;
create policy "admin reads activity" on public.activity for select to authenticated using (public.is_admin());

drop policy if exists "own seeds" on public.seeds;
create policy "own seeds" on public.seeds for all to authenticated
  using (user_id = auth.uid() and public.is_active_user())
  with check (user_id = auth.uid() and public.is_active_user());

drop policy if exists "own seed hits" on public.seed_hits;
create policy "own seed hits" on public.seed_hits for select to authenticated
  using (public.is_active_user() and exists (select 1 from public.seeds s where s.id = seed_id and s.user_id = auth.uid()));

drop policy if exists "own lists" on public.user_leads;
create policy "own lists" on public.user_leads for all to authenticated
  using (user_id = auth.uid() and public.is_active_user())
  with check (user_id = auth.uid() and public.is_active_user());

drop policy if exists "active users read leads" on public.leads;
create policy "active users read leads" on public.leads for select to authenticated using (public.is_active_user());
drop policy if exists "active users read gaps" on public.gaps;
create policy "active users read gaps" on public.gaps for select to authenticated using (public.is_active_user());
drop policy if exists "active users read geo" on public.geo_daily;
create policy "active users read geo" on public.geo_daily for select to authenticated using (public.is_active_user());
drop policy if exists "admin reads job runs" on public.job_runs;
create policy "admin reads job runs" on public.job_runs for select to authenticated using (public.is_admin());

-- explicit table grants (new Supabase projects may not grant API access to new tables automatically);
-- RLS policies and the revokes below still decide what each role can actually do
grant usage on schema public to anon, authenticated, service_role;
grant all on public.app_settings, public.profiles, public.invites, public.activity, public.seeds, public.seed_hits,
              public.user_leads, public.leads, public.gaps, public.geo_daily, public.job_runs to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- nothing is readable without logging in
revoke all on public.app_settings, public.profiles, public.invites, public.activity, public.seeds, public.seed_hits,
              public.user_leads, public.leads, public.gaps, public.geo_daily, public.job_runs from anon;
-- shared data is written only by the daily job (service role); users change their own rows through functions
revoke insert, update, delete on public.app_settings, public.profiles, public.activity, public.leads, public.gaps,
              public.geo_daily, public.job_runs, public.seed_hits from authenticated;

-- ---------------------------------------------------------------------
-- Private file storage for the daily files (zip + niche lists + index)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('daily', 'daily', false)
on conflict (id) do update set public = false;

drop policy if exists "active users read daily files" on storage.objects;
create policy "active users read daily files" on storage.objects for select to authenticated
  using (bucket_id = 'daily' and public.is_active_user());

-- =====================================================================
-- Functions used by the dashboard
-- =====================================================================

-- shown on the login page (no login needed)
create or replace function public.get_public_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('site_title', site_title, 'allow_requests', allow_requests)
  from public.app_settings where id = 1;
$$;

create or replace function public.my_profile() returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(p) || jsonb_build_object(
           'is_active', public.is_active_user(),
           'is_expired', p.expires_at is not null and p.expires_at <= now())
  from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.update_my_profile(p_full_name text) returns void
language sql security definer set search_path = public as $$
  update public.profiles set full_name = left(nullif(trim(p_full_name), ''), 120) where id = auth.uid();
$$;

create or replace function public.password_changed() returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set must_change_password = false where id = auth.uid();
  insert into public.activity (user_id, email, action) select id, email, 'password_changed' from public.profiles where id = auth.uid();
end $$;

-- usage analytics: the dashboard records logins, page views, exports, ...
create or replace function public.log_event(p_action text, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
  if auth.uid() is null then return; end if;
  select email into v_email from public.profiles where id = auth.uid();
  if v_email is null then return; end if;
  insert into public.activity (user_id, email, action, detail)
  values (auth.uid(), v_email, left(p_action, 40),
          case when length(coalesce(p_detail, '{}'::jsonb)::text) > 2000 then '{}'::jsonb else coalesce(p_detail, '{}'::jsonb) end);
  update public.profiles
     set last_seen_at = now(),
         last_login_at = case when p_action = 'login' then now() else last_login_at end
   where id = auth.uid();
end $$;

-- ---- seed keywords ----
create or replace function public.list_my_seeds() returns setof public.seeds
language sql stable security invoker set search_path = public as $$
  select * from public.seeds where user_id = auth.uid() order by created_at, name;
$$;

-- replaces the user's whole seed list. p = [{id?, name, keywords:[], exclude:[]}, ...]
create or replace function public.save_my_seeds(p jsonb) returns setof public.seeds
language plpgsql security invoker set search_path = public as $$
declare item jsonb; keep uuid[] := '{}'; v_id uuid; v_kw text[]; v_ex text[];
begin
  if not public.is_active_user() then raise exception 'NOT_ACTIVE'; end if;
  for item in select * from jsonb_array_elements(coalesce(p, '[]'::jsonb)) loop
    select coalesce(array_agg(lower(regexp_replace(x, '[^a-zA-Z0-9]', '', 'g'))) filter (where length(regexp_replace(x, '[^a-zA-Z0-9]', '', 'g')) >= 3), '{}')
      into v_kw from jsonb_array_elements_text(coalesce(item -> 'keywords', '[]'::jsonb)) x;
    select coalesce(array_agg(lower(regexp_replace(x, '[^a-zA-Z0-9]', '', 'g'))) filter (where length(regexp_replace(x, '[^a-zA-Z0-9]', '', 'g')) >= 1), '{}')
      into v_ex from jsonb_array_elements_text(coalesce(item -> 'exclude', '[]'::jsonb)) x;
    if cardinality(v_kw) = 0 then continue; end if;
    v_id := null;
    if item ? 'id' and item ->> 'id' ~ '^[0-9a-f-]{36}$' then
      update public.seeds set name = left(item ->> 'name', 80), keywords = v_kw, exclude = v_ex
       where id = (item ->> 'id')::uuid and user_id = auth.uid() returning id into v_id;
    end if;
    if v_id is null then
      insert into public.seeds (user_id, name, keywords, exclude)
      values (auth.uid(), left(coalesce(nullif(item ->> 'name', ''), v_kw[1]), 80), v_kw, v_ex) returning id into v_id;
    end if;
    keep := keep || v_id;
  end loop;
  delete from public.seeds where user_id = auth.uid() and not (id = any (keep));
  perform public.log_event('seeds_saved', jsonb_build_object('count', cardinality(keep)));
  return query select * from public.seeds where user_id = auth.uid() order by created_at, name;
end $$;

create or replace function public.my_seed_hits(p_from date, p_to date) returns table (seed_id uuid, date date, domain text, kw text, loc text)
language sql stable security invoker set search_path = public as $$
  select h.seed_id, h.date, h.domain, h.kw, h.loc
  from public.seed_hits h join public.seeds s on s.id = h.seed_id
  where s.user_id = auth.uid() and h.date between p_from and p_to and h.seed_id = s.id and s.processed_sig = s.sig;
$$;

create or replace function public.seed_daily_counts(p_from date, p_to date) returns table (seed_id uuid, date date, n bigint)
language sql stable security invoker set search_path = public as $$
  select h.seed_id, h.date, count(*) from public.seed_hits h join public.seeds s on s.id = h.seed_id
  where s.user_id = auth.uid() and h.date between p_from and p_to group by 1, 2;
$$;

-- ---- favorites / discards / CRM ----
create or replace function public.my_lists() returns setof public.user_leads
language sql stable security invoker set search_path = public as $$
  select * from public.user_leads where user_id = auth.uid();
$$;

-- p: any of {fav, discarded, status, note, follow_up, found_date, niche_ids, kws, loc}; keys left out are unchanged
create or replace function public.set_my_leads(p_domains text[], p jsonb) returns int
language plpgsql security invoker set search_path = public as $$
declare d text; n int := 0;
begin
  if not public.is_active_user() then raise exception 'NOT_ACTIVE'; end if;
  if cardinality(p_domains) > 1000 then raise exception 'TOO_MANY'; end if;
  foreach d in array p_domains loop
    d := lower(trim(d));
    if d = '' then continue; end if;
    insert into public.user_leads (user_id, domain) values (auth.uid(), d) on conflict do nothing;
    update public.user_leads u set
      fav        = case when p ? 'fav'        then coalesce((p ->> 'fav')::boolean, false)       else u.fav end,
      discarded  = case when p ? 'discarded'  then coalesce((p ->> 'discarded')::boolean, false) else u.discarded end,
      status     = case when p ? 'status'     then nullif(p ->> 'status', '')                    else u.status end,
      note       = case when p ? 'note'       then left(nullif(p ->> 'note', ''), 2000)           else u.note end,
      follow_up  = case when p ? 'follow_up'  then nullif(p ->> 'follow_up', '')::date            else u.follow_up end,
      found_date = case when p ? 'found_date' and u.found_date is null then nullif(p ->> 'found_date', '')::date else u.found_date end,
      niche_ids  = case when p ? 'niche_ids'  and u.niche_ids is null then array(select jsonb_array_elements_text(p -> 'niche_ids')) else u.niche_ids end,
      kws        = case when p ? 'kws'        and u.kws is null then array(select jsonb_array_elements_text(p -> 'kws')) else u.kws end,
      loc        = case when p ? 'loc'        and u.loc is null then nullif(p ->> 'loc', '') else u.loc end,
      updated_at = now()
    where u.user_id = auth.uid() and u.domain = d;
    -- discarding a domain also removes it from favorites
    if p ? 'discarded' and (p ->> 'discarded')::boolean then
      update public.user_leads set fav = false where user_id = auth.uid() and domain = d;
    end if;
    delete from public.user_leads where user_id = auth.uid() and domain = d
      and not fav and not discarded and status is null and note is null and follow_up is null;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---- leads ----
-- p: {from, to, niches[], site_states[], us_state, loc, min_score, has_mx, has_contact, q, view, statuses[], sort, limit, offset}
--    view: all | pipeline (favorites + anything with a CRM status) | followups (follow-up date today or earlier)
create or replace function public.search_leads(p jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_from date := nullif(p ->> 'from', '')::date;
  v_to date := nullif(p ->> 'to', '')::date;
  v_niches text[] := case when jsonb_typeof(p -> 'niches') = 'array' and jsonb_array_length(p -> 'niches') > 0 then array(select jsonb_array_elements_text(p -> 'niches')) end;
  v_states text[] := case when jsonb_typeof(p -> 'site_states') = 'array' and jsonb_array_length(p -> 'site_states') > 0 then array(select jsonb_array_elements_text(p -> 'site_states')) end;
  v_crm text[] := case when jsonb_typeof(p -> 'statuses') = 'array' and jsonb_array_length(p -> 'statuses') > 0 then array(select jsonb_array_elements_text(p -> 'statuses')) end;
  v_us text := nullif(p ->> 'us_state', '');
  v_loc text := nullif(p ->> 'loc', '');
  v_min int := coalesce(nullif(p ->> 'min_score', '')::int, 0);
  v_mx boolean := nullif(p ->> 'has_mx', '')::boolean;
  v_contact boolean := nullif(p ->> 'has_contact', '')::boolean;
  v_q text := nullif(lower(trim(p ->> 'q')), '');
  v_view text := coalesce(nullif(p ->> 'view', ''), 'all');
  v_sort text := coalesce(nullif(p ->> 'sort', ''), 'score');
  v_limit int := least(coalesce(nullif(p ->> 'limit', '')::int, 100), 500);
  v_offset int := greatest(coalesce(nullif(p ->> 'offset', '')::int, 0), 0);
  result jsonb;
begin
  if not public.is_active_user() then raise exception 'NOT_ACTIVE'; end if;
  with base as (
    select coalesce(l.domain, u.domain) as domain,
           coalesce(l.found_date, u.found_date) as found_date,
           coalesce(l.niche_ids, u.niche_ids, '{}') as niche_ids,
           coalesce(l.kws, u.kws, '{}') as kws,
           coalesce(l.loc, u.loc) as loc,
           l.us_state, l.tld, coalesce(l.site_state, 'unchecked') as site_state, l.has_a, l.has_mx, l.mx_provider,
           l.http_status, l.final_url, l.title, l.builder, coalesce(l.phones, '{}') as phones, coalesce(l.emails, '{}') as emails,
           coalesce(l.socials, '{}') as socials, l.registrar, l.registrant_org, l.registrant_state, l.registrant_country,
           coalesce(l.score, 0) as score, coalesce(l.score_reasons, '{}') as score_reasons, l.checks, l.last_checked_at,
           l.next_check_at, coalesce(l.history, '[]'::jsonb) as history, l.source,
           coalesce(u.fav, false) as fav, coalesce(u.discarded, false) as discarded, u.status, u.note, u.follow_up, u.updated_at as my_updated_at
    from public.leads l
    full outer join (select * from public.user_leads where user_id = auth.uid()) u on u.domain = l.domain
    where (l.domain is not null or v_view <> 'all')
  ), f as (
    select * from base b
    where not b.discarded
      and (v_view = 'all' or (v_view = 'pipeline' and (b.fav or b.status is not null or b.note is not null or b.follow_up is not null))
                          or (v_view = 'followups' and b.follow_up is not null and b.follow_up <= current_date))
      and (v_from is null or b.found_date >= v_from)
      and (v_to is null or b.found_date <= v_to)
      and (v_niches is null or b.niche_ids && v_niches)
      and (v_us is null or b.us_state = v_us)
      and (v_loc is null or b.loc = v_loc)
      and b.score >= v_min
      and (v_mx is null or coalesce(b.has_mx, false) = v_mx)
      and (v_contact is null or ((cardinality(b.phones) + cardinality(b.emails) > 0) = v_contact))
      and (v_crm is null or b.status = any (v_crm) or ('none' = any (v_crm) and b.status is null))
      and (v_q is null or b.domain like '%' || v_q || '%' or lower(coalesce(b.title, '')) like '%' || v_q || '%' or lower(coalesce(b.loc, '')) like '%' || v_q || '%')
  ), fs as (
    select * from f where v_states is null or f.site_state = any (v_states)
  )
  select jsonb_build_object(
    'total', (select count(*) from fs),
    'by_state', (select coalesce(jsonb_object_agg(site_state, n), '{}'::jsonb) from (select site_state, count(*) n from f group by 1) x),
    'hot', (select count(*) from fs where score >= 70),
    'need_site', (select count(*) from fs where has_mx and site_state in ('no_site', 'parked', 'coming_soon', 'placeholder')),
    'with_contact', (select count(*) from fs where cardinality(phones) + cardinality(emails) > 0),
    'followups_due', (select count(*) from public.user_leads where user_id = auth.uid() and follow_up <= current_date and not discarded),
    'crm', (select coalesce(jsonb_object_agg(coalesce(status, 'none'), n), '{}'::jsonb) from (select status, count(*) n from base where (fav or status is not null) and not discarded group by 1) y),
    'rows', (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (
        select * from fs
        order by case when v_sort = 'score' then fs.score end desc nulls last,
                 case when v_sort = 'found' then fs.found_date end desc nulls last,
                 case when v_sort = 'followup' then fs.follow_up end asc nulls last,
                 case when v_sort = 'updated' then fs.my_updated_at end desc nulls last,
                 fs.score desc, fs.domain
        limit v_limit offset v_offset) r)
  ) into result;
  return result;
end $$;

-- p: {niches[], us_state, status ('available' default | 'all'), min_demand, limit}
create or replace function public.get_gaps(p jsonb) returns setof public.gaps
language sql stable security invoker set search_path = public as $$
  select * from public.gaps g
  where (coalesce(p ->> 'status', 'available') = 'all' or g.status = coalesce(p ->> 'status', 'available'))
    and (coalesce(jsonb_typeof(p -> 'niches'), 'null') <> 'array' or jsonb_array_length(p -> 'niches') = 0
         or g.niche_id = any (array(select jsonb_array_elements_text(p -> 'niches'))))
    and (nullif(p ->> 'us_state', '') is null or g.us_state = p ->> 'us_state')
    and g.demand >= coalesce(nullif(p ->> 'min_demand', '')::int, 0)
  order by g.demand desc, g.domain
  limit least(coalesce(nullif(p ->> 'limit', '')::int, 300), 1000);
$$;

-- ---- research ----
create or replace function public.geo_summary(p_from date, p_to date, p_niches text[] default null)
returns table (loc text, us_state text, niche_id text, n bigint)
language sql stable security invoker set search_path = public as $$
  select g.loc, max(g.us_state), g.niche_id, sum(g.n)::bigint
  from public.geo_daily g
  where g.date between p_from and p_to and (p_niches is null or cardinality(p_niches) = 0 or g.niche_id = any (p_niches))
  group by g.loc, g.niche_id;
$$;

-- =====================================================================
-- Admin functions (each checks is_admin())
-- =====================================================================
create or replace function public.admin_guard() returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_ONLY'; end if;
end $$;

create or replace function public.admin_list_users() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_guard();
  return (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) from (
    select p.*, (p.expires_at is not null and p.expires_at <= now()) as is_expired,
      (select count(*) from public.activity a where a.user_id = p.id and a.at > now() - interval '30 days') as events_30d,
      (select count(*) from public.activity a where a.user_id = p.id and a.action = 'login' and a.at > now() - interval '30 days') as logins_30d,
      (select count(*) from public.activity a where a.user_id = p.id and a.action like 'export%' and a.at > now() - interval '30 days') as exports_30d,
      (select count(*) from public.user_leads u where u.user_id = p.id and u.fav) as favorites,
      (select count(*) from public.user_leads u where u.user_id = p.id and u.status is not null) as pipeline,
      (select count(*) from public.seeds s where s.user_id = p.id) as seeds
    from public.profiles p) x);
end $$;

-- p: any of {role, status, expires_at (null = never), notes, full_name}
create or replace function public.admin_update_user(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare old public.profiles; admins int;
begin
  perform public.admin_guard();
  select * into old from public.profiles where id = p_id;
  if old.id is null then raise exception 'NO_SUCH_USER'; end if;
  if p_id = auth.uid() and ((p ? 'role' and p ->> 'role' <> 'admin') or (p ? 'status' and p ->> 'status' <> 'active') or (p ? 'expires_at' and p ->> 'expires_at' is not null)) then
    raise exception 'CANNOT_CHANGE_SELF: you cannot remove your own admin access';
  end if;
  if old.email = (select owner_email from public.app_settings where id = 1) and p_id <> auth.uid()
     and ((p ? 'role' and p ->> 'role' <> 'admin') or (p ? 'status' and p ->> 'status' <> 'active')) then
    raise exception 'OWNER_PROTECTED: the owner account cannot be demoted or disabled';
  end if;
  update public.profiles set
    role        = case when p ? 'role' then p ->> 'role' else role end,
    status      = case when p ? 'status' then p ->> 'status' else status end,
    expires_at  = case when p ? 'expires_at' then nullif(p ->> 'expires_at', '')::timestamptz else expires_at end,
    notes       = case when p ? 'notes' then left(nullif(p ->> 'notes', ''), 2000) else notes end,
    full_name   = case when p ? 'full_name' then left(nullif(p ->> 'full_name', ''), 120) else full_name end,
    approved_at = case when p ->> 'status' = 'active' and old.status = 'pending' then now() else approved_at end,
    approved_by = case when p ->> 'status' = 'active' and old.status = 'pending' then auth.uid() else approved_by end
  where id = p_id;
  -- approving a request applies the default access length, if one is set
  if p ->> 'status' = 'active' and old.status = 'pending' and not (p ? 'expires_at') then
    update public.profiles set expires_at = now() + make_interval(days => s.default_expiry_days)
    from public.app_settings s where s.id = 1 and s.default_expiry_days is not null and profiles.id = p_id;
  end if;
  select count(*) into admins from public.profiles where role = 'admin' and status = 'active';
  if admins = 0 then raise exception 'LAST_ADMIN: at least one active admin is required'; end if;
  perform public.log_event('admin_update_user', jsonb_build_object('user', old.email, 'changes', p));
  return (select to_jsonb(x) from public.profiles x where id = p_id);
end $$;

create or replace function public.admin_set_password(p_id uuid, p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_email text;
begin
  perform public.admin_guard();
  if length(coalesce(p_password, '')) < 8 then raise exception 'PASSWORD_TOO_SHORT: use at least 8 characters'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
  where id = p_id returning email into v_email;
  if v_email is null then raise exception 'NO_SUCH_USER'; end if;
  update public.profiles set must_change_password = (p_id <> auth.uid()) where id = p_id;
  perform public.log_event('admin_set_password', jsonb_build_object('user', lower(v_email)));
end $$;

create or replace function public.admin_delete_user(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
  perform public.admin_guard();
  if p_id = auth.uid() then raise exception 'CANNOT_DELETE_SELF'; end if;
  select email into v_email from public.profiles where id = p_id;
  if v_email = (select owner_email from public.app_settings where id = 1) then raise exception 'OWNER_PROTECTED: the owner account cannot be deleted'; end if;
  delete from auth.users where id = p_id;
  perform public.log_event('admin_delete_user', jsonb_build_object('user', v_email));
end $$;

create or replace function public.admin_invite(p_email text, p_role text default 'user', p_expires_at timestamptz default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(p_email)); r public.invites;
begin
  perform public.admin_guard();
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'BAD_EMAIL: %', p_email; end if;
  if exists (select 1 from public.profiles where email = v_email) then
    raise exception 'ALREADY_USER: % already has an account - change it under Users', v_email;
  end if;
  insert into public.invites (email, role, expires_at, note, invited_by)
  values (v_email, coalesce(p_role, 'user'), p_expires_at, nullif(p_note, ''), auth.uid())
  on conflict (email) do update set role = excluded.role, expires_at = excluded.expires_at, note = excluded.note, invited_by = excluded.invited_by, created_at = now()
  returning * into r;
  perform public.log_event('admin_invite', jsonb_build_object('email', v_email, 'role', r.role));
  return to_jsonb(r);
end $$;

create or replace function public.admin_list_invites() returns setof public.invites
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_guard();
  return query select * from public.invites order by created_at desc;
end $$;

create or replace function public.admin_revoke_invite(p_email text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_guard();
  delete from public.invites where email = lower(trim(p_email));
  perform public.log_event('admin_revoke_invite', jsonb_build_object('email', lower(trim(p_email))));
end $$;

create or replace function public.admin_get_settings() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_guard();
  return (select to_jsonb(s) from public.app_settings s where id = 1);
end $$;

create or replace function public.admin_update_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_guard();
  update public.app_settings set
    site_title          = case when p ? 'site_title' then coalesce(nullif(left(p ->> 'site_title', 60), ''), site_title) else site_title end,
    allow_requests      = case when p ? 'allow_requests' then (p ->> 'allow_requests')::boolean else allow_requests end,
    default_expiry_days = case when p ? 'default_expiry_days' then nullif(p ->> 'default_expiry_days', '')::int else default_expiry_days end,
    updated_at = now()
  where id = 1;
  perform public.log_event('admin_update_settings', p);
  return (select to_jsonb(s) from public.app_settings s where id = 1);
end $$;

-- p: {user_id, action, before (timestamp), limit}
create or replace function public.admin_activity(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_guard();
  return (select coalesce(jsonb_agg(to_jsonb(a) order by a.at desc), '[]'::jsonb) from (
    select * from public.activity
    where (nullif(p ->> 'user_id', '') is null or user_id = (p ->> 'user_id')::uuid)
      and (nullif(p ->> 'action', '') is null or action = p ->> 'action')
      and (nullif(p ->> 'before', '') is null or at < (p ->> 'before')::timestamptz)
    order by at desc limit least(coalesce(nullif(p ->> 'limit', '')::int, 100), 500)) a);
end $$;

create or replace function public.admin_stats(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare since timestamptz := now() - make_interval(days => greatest(p_days, 1));
begin
  perform public.admin_guard();
  return jsonb_build_object(
    'users', (select jsonb_build_object(
        'total', count(*),
        'active', count(*) filter (where status = 'active' and (expires_at is null or expires_at > now())),
        'pending', count(*) filter (where status = 'pending'),
        'disabled', count(*) filter (where status = 'disabled'),
        'expired', count(*) filter (where status = 'active' and expires_at <= now()),
        'admins', count(*) filter (where role = 'admin'),
        'expiring_7d', count(*) filter (where status = 'active' and expires_at > now() and expires_at <= now() + interval '7 days'),
        'new_in_period', count(*) filter (where created_at >= since))
      from public.profiles),
    'invites', (select count(*) from public.invites),
    'active_1d', (select count(distinct user_id) from public.activity where at > now() - interval '1 day'),
    'active_7d', (select count(distinct user_id) from public.activity where at > now() - interval '7 days'),
    'active_30d', (select count(distinct user_id) from public.activity where at > now() - interval '30 days'),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object('date', d, 'users', u, 'events', e, 'logins', l, 'exports', x) order by d), '[]'::jsonb) from (
        select gs::date d,
               (select count(distinct user_id) from public.activity a where a.at::date = gs::date) u,
               (select count(*) from public.activity a where a.at::date = gs::date) e,
               (select count(*) from public.activity a where a.at::date = gs::date and a.action = 'login') l,
               (select count(*) from public.activity a where a.at::date = gs::date and a.action like 'export%') x
        from generate_series(since::date, current_date, interval '1 day') gs) t),
    'actions', (select coalesce(jsonb_agg(jsonb_build_object('action', action, 'n', n) order by n desc), '[]'::jsonb) from (
        select action, count(*) n from public.activity where at >= since group by 1) t),
    'top_users', (select coalesce(jsonb_agg(jsonb_build_object('email', email, 'n', n, 'last', last) order by n desc), '[]'::jsonb) from (
        select email, count(*) n, max(at) last from public.activity where at >= since and user_id is not null group by 1 order by 2 desc limit 10) t),
    'tabs', (select coalesce(jsonb_agg(jsonb_build_object('tab', tab, 'n', n) order by n desc), '[]'::jsonb) from (
        select detail ->> 'tab' tab, count(*) n from public.activity where at >= since and action = 'view' group by 1) t),
    'niches', (select coalesce(jsonb_agg(jsonb_build_object('niche', niche, 'n', n) order by n desc), '[]'::jsonb) from (
        select x niche, count(*) n from public.activity, jsonb_array_elements_text(coalesce(detail -> 'niches', '[]'::jsonb)) x
        where at >= since and action = 'niche_select' group by 1 order by 2 desc limit 15) t),
    'exports', (select coalesce(sum((detail ->> 'rows')::int) filter (where detail ? 'rows'), 0) from public.activity where at >= since and action like 'export%'),
    'data', jsonb_build_object(
        'leads', (select count(*) from public.leads),
        'leads_checked', (select count(*) from public.leads where checks > 0),
        'leads_hot', (select count(*) from public.leads where score >= 70),
        'by_site_state', (select coalesce(jsonb_object_agg(site_state, n), '{}'::jsonb) from (select site_state, count(*) n from public.leads group by 1) t),
        'gaps_available', (select count(*) from public.gaps where status = 'available'),
        'seeds', (select count(*) from public.seeds),
        'seed_hits', (select count(*) from public.seed_hits),
        'favorites', (select count(*) from public.user_leads where fav),
        'pipeline', (select count(*) from public.user_leads where status is not null),
        'db_bytes', pg_database_size(current_database()),
        'storage_bytes', (select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects where bucket_id = 'daily'),
        'storage_files', (select count(*) from storage.objects where bucket_id = 'daily')),
    'last_job', (select to_jsonb(j) from public.job_runs j order by started_at desc limit 1)
  );
end $$;

create or replace function public.admin_job_runs(p_limit int default 30) returns setof public.job_runs
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_guard();
  return query select * from public.job_runs order by started_at desc limit least(p_limit, 200);
end $$;

-- =====================================================================
-- Functions for the daily job only (service role key)
-- =====================================================================
create or replace function public.job_active_seeds() returns setof public.seeds
language sql stable security definer set search_path = public as $$
  select s.* from public.seeds s join public.profiles p on p.id = s.user_id
  where p.status = 'active' and (p.expires_at is null or p.expires_at > now());
$$;

create or replace function public.job_tracked_domains() returns table (domain text, found_date date, niche_ids text[], kws text[], loc text)
language sql stable security definer set search_path = public as $$
  select u.domain, min(u.found_date),
         (select u2.niche_ids from public.user_leads u2 where u2.domain = u.domain and u2.niche_ids is not null limit 1),
         (select u2.kws from public.user_leads u2 where u2.domain = u.domain and u2.kws is not null limit 1),
         max(u.loc)
  from public.user_leads u join public.profiles p on p.id = u.user_id
  where (u.fav or u.status is not null) and not u.discarded and p.status = 'active'
  group by u.domain;
$$;

create or replace function public.job_prune(p_lead_days int default 120, p_geo_days int default 400, p_activity_days int default 365) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; d int;
begin
  delete from public.leads l where l.found_date < current_date - p_lead_days
    and not exists (select 1 from public.user_leads u where u.domain = l.domain and (u.fav or u.status is not null));
  get diagnostics a = row_count;
  delete from public.geo_daily where date < current_date - p_geo_days; get diagnostics b = row_count;
  delete from public.activity where at < now() - make_interval(days => p_activity_days); get diagnostics c = row_count;
  delete from public.job_runs where started_at < now() - interval '180 days'; get diagnostics d = row_count;
  return jsonb_build_object('leads', a, 'geo', b, 'activity', c, 'job_runs', d);
end $$;

-- ---------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
grant execute on function public.get_public_settings() to anon;
revoke execute on function public.job_active_seeds(), public.job_tracked_domains(), public.job_prune(int, int, int) from authenticated;

-- done
select 'Domain Radar database is ready. Owner email: ' || coalesce(owner_email, '(not set!)') as result
from public.app_settings where id = 1;
