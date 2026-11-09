# OtakuNaija Play

OtakuNaija Play is the service layer that powers episode discovery, metadata enrichment, provider resolution, playback proxying, resync recovery, and export to the OtakuNaija platform.

## How it works

1. **Discovery** checks AniList airing schedules within the active 48-hour window and queues new episodes.
2. **Sync** enriches queued episodes with Jikan and AniList metadata, images, and available providers.
3. **Watch** validates providers in order, returns the first working stream, and remembers successful resolutions.
4. **Proxy routes** keep upstream headers server-side while forwarding manifests, segments, and subtitles through signed short-lived URLs.
5. **Resync** refreshes provider lists for airing anime and episodes flagged after a failed watch attempt.
6. **Export** sends enriched anime and episode records to the OtakuNaija API.
7. **Upcoming discovery** stores anime that have *not* started airing yet as metadata-only placeholders (`anime.is_placeholder = true`), and **placeholder export** pushes them to OtakuNaija with `status: 'upcoming'` before they have a single streamable episode. When the first episode is later resolved, the anime is promoted (`is_placeholder = false`, `status = 'RELEASING'`) and OtakuNaija flips it to `ongoing`.

## Project structure

- `app/api/discovery/run` — finds newly airing episodes.
- `app/api/sync/process` — turns queued episodes into playable records.
- `app/api/watch/[playId]` — resolves and caches working streams.
- `app/api/proxy/*` — signed media and subtitle proxy endpoints.
- `app/api/resync/run` — refreshes provider availability.
- `app/api/export/run` — exports records to OtakuNaija.
- `app/api/discovery/upcoming` — AniList `NOT_YET_RELEASED` sweep into placeholders (no episodes).
- `app/api/export/upcoming` — exports/refreshes placeholders as `status: 'upcoming'`.
- `app/api/discovery/seasonal` — catalogue expansion: queues episodes only for anime Anivexa can already play.
- `app/api/discovery/request` — manual "Import by AniList ID" (`POST`) and its state (`GET`).
- `lib/supabase/admin.ts` — shared AniList and Supabase service helpers.
- `lib/upcoming.ts` — pure normalisation, selection filter, status mapping, payload builder, id parser, merge logic (unit tested).
- `lib/otaku.ts` — OtakuNaija POST helper with the shared retry/backoff rules.
- `lib/placeholder.ts` — placeholder export bookkeeping.
- `lib/auth.ts` — cron/write-route authorization.
- `docs/sql/upcoming-discovery.sql` — idempotent schema change (run manually).

## Local development

Install dependencies with the repository package manager, then start the Next.js development server:

```bash
pnpm install
pnpm dev
```

The service expects its Supabase, OtakuNaija, and proxy signing environment variables to be configured in the project environment. Never commit secrets to the repository.

## API notes

- Proxy URLs are signed with `PROXY_SIGNING_SECRET` and expire after four hours.
- Watch responses only proxy streams when upstream headers are required; subtitle URLs are always signed through the subtitle proxy.
- Failed stream resolutions mark episodes for provider resync without creating new episode rows.


## Upcoming discovery and placeholder export

Anime that have not started airing used to be invisible to OtakuNaija: nothing
queued them, and nothing exported an anime before it had a stream-ready episode.
Four routes now cover that gap.

| Route | What it does | Writes |
| --- | --- | --- |
| `GET /api/discovery/upcoming` | Sweeps AniList `NOT_YET_RELEASED` anime (start date inside the next 9 months, plus TBA titles above `UPCOMING_MIN_POPULARITY`) and stores them as placeholders. AniList data only: no `pending_sync`, no `episodes`, no Jikan/Anivexa calls, and never touches a real (non-placeholder) anime. | `anime` |
| `GET /api/export/upcoming` | Pushes placeholders to `POST /api/play/anime` with `status: 'upcoming'`, `format`, dates, season, popularity, trailer and `isPlaceholder: true`. Re-pushes when AniList changed the start date, cover, trailer, format or episode count. | `anime`, OtakuNaija |
| `GET /api/discovery/seasonal` | Catalogue expansion over the current and previous season (or `?year=` backfill, max 3 seasons per run), popular first: queues episodes 1..N (cap 3) only for anime Anivexa can already play. Finished anime without providers are ignored, no placeholders for them. | `pending_sync` |
| `POST /api/discovery/request` | Manual "Import by AniList ID" for the OtakuNaija admin. `NOT_YET_RELEASED` becomes a placeholder and is exported immediately; anything else is queued for `/api/sync/process`. Idempotent. | `anime`, `pending_sync`, `discovery_requests`, OtakuNaija |
| `GET /api/discovery/request?anilist_id=12345` | Reads the state of one manual import. | nothing |

### Authentication

All five new entry points require `Authorization: Bearer <secret>` and fail
closed (`503 CRON_SECRET_NOT_CONFIGURED`) when no secret is set, because they
write rows and push to OtakuNaija. The secret is `CRON_SECRET`, falling back to
the `EPISODE_CHECK_SECRET` the existing `episodes/check` route already uses, so a
deployment that already has that variable needs no new secret. The existing
`/api/discovery/run`, `/api/export/run`, `/api/sync/process`, `/api/resync/run`,
`/api/watch/*` and `/api/proxy/*` routes are unchanged and stay as public as they
are today.

`dry=1` performs the full read path and writes nothing (no Supabase rows, no
OtakuNaija calls). Without database credentials the upcoming and seasonal routes
still run their AniList (and Anivexa) half and report `"database": "unavailable"`.

### Environment variables

Existing: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OTAKUNAIJA_API_URL`,
`OTAKUNAIJA_API_KEY`, `OTAKUNAIJA_PLAY_API_KEY`, `PROXY_SIGNING_SECRET`,
`EPISODE_CHECK_SECRET`, plus the optional `ANIVEXA_BASE_URL`,
`SHIKIMORI_BASE_URL`, `EPISODE_CHECK_CONCURRENCY`, `ANIVEXA_TIMEOUT_MS`.

New:

- `CRON_SECRET` — required to call the four new routes. Any long random string;
  send it as `Authorization: Bearer <secret>`. If it is absent the routes fall
  back to `EPISODE_CHECK_SECRET`.
- `UPCOMING_MIN_POPULARITY` — optional, default `2000`. Popularity floor for
  upcoming titles without a complete start date (TBA).

### Cron schedule

`vercel.json` already declares 30 cron entries, all `/api/discovery/run?slot=N`.
Those are untouched, and the three new entries were deliberately **not** added to
that file: this change only documents them, so they go into whatever scheduler
you already use (Vercel, cron-job.org, GitHub Actions) without changing how the
existing slots run. Note that `/api/sync/process`, `/api/export/run` and
`/api/resync/run` are not in `vercel.json` either, so they are triggered
somewhere else and that trigger keeps working as today.

| Route | Schedule | Why |
| --- | --- | --- |
| `/api/discovery/upcoming` | every 6 hours | AniList dates and new announcements move slowly; the route keeps its own page cursor in `discovery_state` and resumes where it stopped. |
| `/api/export/upcoming` | every 10 minutes | Placeholders must reach OtakuNaija quickly after discovery, and metadata refreshes should follow AniList closely. |
| `/api/discovery/seasonal?pages=2` | once a day | Catalogue expansion is rate-limit heavy (AniList + Anivexa per anime). |
| `/api/discovery/run`, `/api/sync/process`, `/api/export/run`, `/api/resync/run` | unchanged | Existing behaviour. |

`vercel.json`:

```json
{ "path": "/api/discovery/upcoming", "schedule": "0 */6 * * *" },
{ "path": "/api/export/upcoming", "schedule": "*/10 * * * *" },
{ "path": "/api/discovery/seasonal?pages=2", "schedule": "30 3 * * *" }
```

Manual invocations (shell):

```bash
export PLAY_BASE="https://your-play-deployment.vercel.app"
export CRON_SECRET="...same value as the deployment..."

# upcoming sweep, writes rows
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "$PLAY_BASE/api/discovery/upcoming"

# upcoming sweep, read-only rehearsal
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "$PLAY_BASE/api/discovery/upcoming?dry=1&pages=2&limit=50"

# most popular upcoming first (separate cursor)
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "$PLAY_BASE/api/discovery/upcoming?sort=popularity&pages=2"

# push/refresh placeholders to OtakuNaija
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "$PLAY_BASE/api/export/upcoming?limit=10"

# seasonal catalogue expansion
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "$PLAY_BASE/api/discovery/seasonal?pages=2"

# backfill one year (max 3 seasons per run)
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "$PLAY_BASE/api/discovery/seasonal?year=2024&pages=2"

# manual import: by id, or by AniList url
curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  -H 'content-type: application/json' \
  -d '{"anilistId": 176496}' \
  "$PLAY_BASE/api/discovery/request"

curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  -H 'content-type: application/json' \
  -d '{"url": "https://anilist.co/anime/176496/Some-Title"}' \
  "$PLAY_BASE/api/discovery/request"

# read the state of a manual import
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "$PLAY_BASE/api/discovery/request?anilist_id=176496"
```

### Post-deploy checklist

1. Run `docs/sql/upcoming-discovery.sql` in the Supabase SQL editor (idempotent,
   safe to re-run; it ends with `notify pgrst, 'reload schema'`).
2. Set `CRON_SECRET` on the deployment (or confirm `EPISODE_CHECK_SECRET` is
   already set; the new routes accept either).
3. Add the three cron entries above, then invoke each route once by hand with
   `dry=1` and check the JSON.
4. Invoke `/api/discovery/upcoming` without `dry` for the first real sweep, then
   `/api/export/upcoming?limit=10` and confirm the series appear on OtakuNaija as
   upcoming.
5. Nothing needs backfilling: the existing episode, sync, resync and export
   tables and jobs are untouched apart from the new nullable columns.

### How a placeholder becomes a normal anime

1. `/api/discovery/upcoming` (or a manual import) writes `anime` with
   `is_placeholder = true`, `status = 'NOT_YET_RELEASED'`, `discovery_source =
   'upcoming'`.
2. `/api/export/upcoming` posts it to `/api/play/anime` with `status: 'upcoming'`
   and stores `otaku_anime_id`, `exported_to_otaku = true`,
   `status_synced_to_otaku = 'upcoming'` and a metadata fingerprint.
3. The episode lands from the usual discovery paths. `/api/sync/process` creates
   the first `episodes` row and promotes the anime: `is_placeholder = false`,
   `discovery_source = 'airing'`, `status = 'RELEASING'`. Metadata is merged,
   never blanked, so a failed Jikan lookup cannot wipe a good AniList title or
   cover.
4. `/api/export/run` exports the episode, and if the anime reached OtakuNaija as
   a placeholder it posts the anime once more with `status: 'ongoing'` and stores
   `status_synced_to_otaku = 'ongoing'`.

### Tests

```bash
pnpm test        # vitest: normalisation, selection filter, status mapping,
                 # payload builder, id parser, merge-not-blank, 429/backoff
npx tsc --noEmit
pnpm build
```
