-- Resolved-stream cache for /api/watch/<playId>.
--
-- A cold resolve is a live scrape (ani-api, then Anivexa) and costs seconds;
-- the payload it produces is what the player needs, and it expires on its own
-- because every URL inside it is signed. Caching it makes a repeat watch
-- sub-second for every user and every instance.
--
-- lib/stream-cache.ts degrades to "no cache" when this table is absent, so the
-- route works before and after this migration is applied.

create table if not exists public.stream_cache (
  play_id    text        not null,
  audio      text        not null check (audio in ('sub', 'dub')),
  payload    jsonb       not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (play_id, audio)
);

-- A read is always by (play_id, audio) and then checked against expires_at.
create index if not exists stream_cache_expires_at_idx on public.stream_cache (expires_at);

alter table public.stream_cache enable row level security;

-- The route uses the service key, which bypasses RLS; no policy is needed for
-- that. RLS with no policy keeps the table closed to anon and authenticated
-- callers, which is what we want for a server-only cache.

-- Housekeeping: expired rows are dead weight. Run from cron, or replace with a
-- pg_cron schedule if the project has it enabled.
--   delete from public.stream_cache where expires_at < now();
