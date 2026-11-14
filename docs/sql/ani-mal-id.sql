-- ani provider MAL ids (PROMPT PLAY-2)
-- Idempotent: safe to run more than once. Run manually in Play's Supabase SQL editor.
--
-- The watch resolver tries our own ani-api FIRST, and that API is addressed by
-- MAL id. Play rows already carry anilist_id; mal_id is what the ani-api needs.
-- /api/sync/process fills mal_id from Anivexa `mappings.malId`, and the watch
-- resolver now also discovers it through Anivexa `/map/{anilist_id}` on a miss
-- and saves it here, so the lookup happens once per anime.

-- ---------------------------------------------------------------------------
-- 1. anime: MAL id
-- ---------------------------------------------------------------------------

alter table if exists public.anime
  add column if not exists mal_id int;

comment on column public.anime.mal_id is
  'MyAnimeList id. Set by /api/sync/process (Anivexa mappings.malId) or discovered once by the watch resolver via Anivexa /map/{anilist_id} for the ani-api provider.';

create index if not exists anime_mal_id_idx
  on public.anime (mal_id)
  where mal_id is not null;

-- ---------------------------------------------------------------------------
-- 2. episodes: per-episode MAL id override (usually null; anime.mal_id is enough)
-- ---------------------------------------------------------------------------

alter table if exists public.episodes
  add column if not exists mal_id int;

comment on column public.episodes.mal_id is
  'Optional per-episode MAL id. The resolver reads episodes.mal_id ?? anime.mal_id; leave null unless one anime maps to several MAL entries.';

create index if not exists episodes_mal_id_idx
  on public.episodes (mal_id)
  where mal_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Coverage report (read-only, run any time)
-- ---------------------------------------------------------------------------

-- select
--   count(*)                                             as anime_total,
--   count(mal_id)                                        as anime_with_mal_id,
--   round(100.0 * count(mal_id) / nullif(count(*), 0), 1) as percent_with_mal_id
-- from public.anime;

-- Episodes the resolver can serve through ani right now:
-- select count(*) as episodes_ani_can_address
-- from public.episodes e
-- join public.anime a on a.anilist_id = e.anilist_id
-- where coalesce(e.mal_id, a.mal_id) is not null;
