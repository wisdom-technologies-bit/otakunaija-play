# OtakuNaija Play

OtakuNaija Play is the service layer that powers episode discovery, metadata enrichment, provider resolution, playback proxying, resync recovery, and export to the OtakuNaija platform.

## How it works

1. **Discovery** checks AniList airing schedules within the active 48-hour window and queues new episodes.
2. **Sync** enriches queued episodes with Jikan and AniList metadata, images, and available providers.
3. **Watch** validates providers in order, returns the first working stream, and remembers successful resolutions.
4. **Proxy routes** keep upstream headers server-side while forwarding manifests, segments, and subtitles through signed short-lived URLs.
5. **Resync** refreshes provider lists for airing anime and episodes flagged after a failed watch attempt.
6. **Export** sends enriched anime and episode records to the OtakuNaija API.

## Project structure

- `app/api/discovery/run` — finds newly airing episodes.
- `app/api/sync/process` — turns queued episodes into playable records.
- `app/api/watch/[playId]` — resolves and caches working streams.
- `app/api/proxy/*` — signed media and subtitle proxy endpoints.
- `app/api/resync/run` — refreshes provider availability.
- `app/api/export/run` — exports records to OtakuNaija.
- `lib/supabase/admin.ts` — shared AniList and Supabase service helpers.

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
