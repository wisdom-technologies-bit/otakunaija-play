-- Upcoming discovery (PROMPT PLAY-1)
-- Idempotent: safe to run more than once. Run manually in the Supabase SQL editor.
--
-- Adds the metadata columns that let OtakuNaija show UPCOMING anime before they
-- have any streamable episode, plus the small tables the new routes use for
-- manual imports, cursors and bookkeeping.

-- ---------------------------------------------------------------------------
-- 1. anime: upcoming metadata + export bookkeeping
-- ---------------------------------------------------------------------------

alter table if exists public.anime
  add column if not exists start_date date,
  add column if not exists start_year int,
  add column if not exists start_month int,
  add column if not exists start_day int,
  add column if not exists season text,
  add column if not exists season_year int,
  add column if not exists popularity int,
  add column if not exists trailer_site text,
  add column if not exists trailer_id text,
  add column if not exists episodes_total int,
  add column if not exists duration_minutes int,
  add column if not exists source text,
  add column if not exists is_placeholder boolean not null default false,
  add column if not exists discovery_source text,
  add column if not exists upcoming_checked_at timestamptz,
  add column if not exists status_synced_to_otaku text,
  add column if not exists anilist_synced_at timestamptz;

-- Export bookkeeping for the placeholder -> OtakuNaija sync.
-- upcoming_exported_at: when the placeholder was last pushed.
-- upcoming_export_fingerprint: the metadata that was pushed, so a changed
-- start date / cover / trailer can be re-pushed without guessing.
alter table if exists public.anime
  add column if not exists upcoming_exported_at timestamptz,
  add column if not exists upcoming_export_fingerprint text;

comment on column public.anime.is_placeholder is
  'true = AniList metadata only, no episodes resolved or exported yet';
comment on column public.anime.discovery_source is
  'airing | catalog | upcoming | seasonal | manual';
comment on column public.anime.status_synced_to_otaku is
  'last status pushed to OtakuNaija: upcoming | ongoing | completed';
comment on column public.anime.upcoming_export_fingerprint is
  'metadata snapshot last pushed for a placeholder, used to detect drift';

-- Partial index: the placeholder export route scans only unexported placeholders.
create index if not exists anime_placeholder_unexported_idx
  on public.anime (exported_to_otaku)
  where is_placeholder is true;

-- Partial index: the export route also looks for placeholders whose status drifted.
create index if not exists anime_placeholder_status_idx
  on public.anime (status_synced_to_otaku)
  where is_placeholder is true;

-- Upcoming ordering / window filters.
create index if not exists anime_start_date_idx
  on public.anime (start_date);

-- ---------------------------------------------------------------------------
-- 2. discovery_requests: manual "Import by AniList ID" from the OtakuNaija admin
-- ---------------------------------------------------------------------------

create table if not exists public.discovery_requests (
  id bigserial primary key,
  anilist_id int not null unique,
  requested_by text,
  status text not null default 'pending',
  error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

comment on table public.discovery_requests is
  'One row per manual import request; status is placeholder | queued | failed';

create index if not exists discovery_requests_created_at_idx
  on public.discovery_requests (created_at desc);

-- ---------------------------------------------------------------------------
-- 3. discovery_state: paging cursors for the AniList sweeps
-- ---------------------------------------------------------------------------

create table if not exists public.discovery_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.discovery_state is
  'Small key/value cursors, e.g. upcoming:start_date -> {"next_page": 4}';

-- ---------------------------------------------------------------------------
-- 4. pending_sync: which discovery source queued the episode
-- ---------------------------------------------------------------------------

alter table if exists public.pending_sync
  add column if not exists discovery_source text;

comment on column public.pending_sync.discovery_source is
  'airing | catalog | seasonal | manual | null for legacy rows';

-- ---------------------------------------------------------------------------
-- 5. Let PostgREST pick up the new columns immediately
-- ---------------------------------------------------------------------------

notify pgrst, 'reload schema';
