# ani provider (PLAY-2)

OtakuNaija Play now tries **our own ani-api first** and Anivexa second when it
resolves a stream for `GET /api/watch/[playId]`. The idea is the same as the
KumoriTV "ani" provider: a MAL id, a provider-verified HLS master, our own
subtitles.

The switch ships **off**. With `ANI_PROVIDER_ENABLED` unset (or `0`) the
resolver runs exactly the code it ran before this provider existed, and the
response is byte-identical.

- Branch: `ani-provider`
- Calls: `GET /v1/streams/mal/{mal_id}/episode/{n}?audio=sub&quality=best`
- Production base URL: `https://ani-api.kumoritv.top`

## Data flow

```
Browser (otakunaija-main video-player.tsx)
  GET https://play.otakunaija.name.ng/api/watch/<playId>[?exclude=...][&debug=1]
        |
        v
app/api/watch/[playId]/route.ts  (nodejs, CORS *, maxDuration 240)
  1. load the episodes row (play_id, anilist_id, mal_id, episode_number, providers, resolved_*)
  2. tryAni(...)  <-- NEW, and it runs first
       gate: flag, base URL, key, audio path, no "ani:" in exclude, rollout percent
       then: MAL id (episodes.mal_id -> anime.mal_id -> one 3 s Anivexa /map lookup)
       then: GET ani-api with X-API-Key, 10 min cache, single-flight, breaker, limiter
       then: validate (verified stream, same MAL id + episode, hls, allow-listed host,
             playable variant, playable subtitle for sub)
       then: probe the master playlist with the existing probeStream
       ok  -> responseFor(playId, 'sub', 'ani', ...) and return
       miss/fail -> one trace line, fall through
  3. 6 h resolved-provider cache, Anivexa findWinner race, catalog retry  (untouched)
```

On a win the browser gets the **same response shape** it already understands:

```json
{
  "playId": "...", "audio": "sub", "provider": "ani", "server": null,
  "type": "hls", "headers": {},
  "streamUrl": "/api/proxy/manifest?u=...&h=...&e=...&s=...",
  "subtitles": [{ "url": "/api/proxy/subtitle?...", "label": "English (- (Crunchyroll))", "srclang": "en", "default": true, "kind": "full" }],
  "intro": null, "outro": null
}
```

`server: null` matters: the player builds its retry exclusion as
`${provider}:${server ?? 'default'}`, so a failed ani stream becomes
`exclude=ani:default` and the next call skips ani entirely. That already works
with no change to otakunaija-main (checked in `components/episodes/video-player.tsx`).

`streamUrl` is our signed manifest proxy of the **raw** `master_url`. The
ani-api's `proxied_master_url` is never used, so nothing the browser touches
needs the key. `intro`/`outro` are null because those markers come from Anivexa.

### What is deliberately NOT written

When ani wins, the route does **not** write `resolved_provider`,
`resolved_audio`, `resolved_at` and does **not** clear or set `needs_resync`.
Those columns describe Anivexa provider health; an ani stream must not hide a
broken Anivexa provider or mark a healthy one for resync.

## Environment variables

All read at request time (the existing edge proxy inlines them at build time,
see [Direct segments](#direct-segments)). None has a `NEXT_PUBLIC_` prefix.

| Variable | Default | Meaning |
|---|---|---|
| `ANI_API_BASE_URL` | *(none)* | Base URL of the ani-api. Unset = provider off. |
| `ANI_API_KEY` | *(none)* | Play's own key, sent as `X-API-Key`. Unset = provider off. |
| `ANI_PROVIDER_ENABLED` | `0` | `1`/`true`/`yes`/`on` turns the provider on. |
| `ANI_PROVIDER_PERCENT` | `100` | 0-100 rollout, stable FNV-1a bucket of `anilist_id`. |
| `ANI_DUB_ENABLED` | `0` | Dub through ani. Off because the API never verifies audio language. |
| `ANI_REQUIRE_SUBTITLE` | `1` | A sub stream needs one playable subtitle track, like Anivexa sub providers. |
| `ANI_API_TIMEOUT_MS` | `12000` | Per-request timeout. |
| `ANI_MAX_CONCURRENCY` | `3` | In-flight resolves per instance. Saturated = skip, never queue a viewer. |
| `ANI_RATE_PER_MIN` | `30` | Requests/minute per instance. The real ceiling is the API's **60/min per key**. |
| `DIRECT_SEGMENT_HOSTS` | `none` | Media hosts the browser may load directly. See below. |

`ANI_RATE_PER_MIN` is a per-instance politeness budget, not the account limit:
Vercel runs several instances and each keeps its own counter. Play uses a
**separate key** from KumoriTV so the two never share the 60/min budget and can
be revoked independently.

## Deploying (owner, on Vercel)

1. **Create a separate key for Play** on the ani-api. `ANI_API_KEYS` is a
   comma-separated list, so add a second value and redeploy the API; keep
   KumoriTV's key untouched.
2. Set these variables on the `otakunaija-play` Vercel project:

   ```
   ANI_API_BASE_URL=https://ani-api.kumoritv.top
   ANI_API_KEY=<the new Play key>
   ANI_PROVIDER_ENABLED=0
   ANI_PROVIDER_PERCENT=10
   ANI_DUB_ENABLED=0
   ANI_REQUIRE_SUBTITLE=1
   ANI_API_TIMEOUT_MS=12000
   DIRECT_SEGMENT_HOSTS=none
   ```

   Leave `ANI_MAX_CONCURRENCY` and `ANI_RATE_PER_MIN` at their defaults unless
   you have a reason.
3. Redeploy. With the flag at `0` nothing changes.

### Rollout

1. Set `ANI_PROVIDER_ENABLED=1` with `ANI_PROVIDER_PERCENT=10`. Redeploy.
2. Watch `GET /api/admin/ani-status` (see below): `ok` should dominate
   `lastOutcomes`, `breaker.open` should stay false.
3. Raise to 25, then 50, then 100, one redeploy each, with the same check.
4. Compare a handful of episodes: `curl "https://play.otakunaija.name.ng/api/watch/<playId>?debug=1"`
   and read `provider` (`ani` vs an Anivexa provider) and `trace[0]`.

### Instant disable

Set `ANI_PROVIDER_ENABLED=0` and redeploy. That is the whole switch: no cache to
flush, because the ani caches live in the instance and the route re-reads the
flag per request. Setting `ANI_PROVIDER_PERCENT=0` isolates a bad rollout to
nothing without touching the flag, and `ANI_API_KEY=` (empty) disables the
provider too.

### Key rotation

Set the new key in `ANI_API_KEY`, redeploy Play, then remove the old value from
`ANI_API_KEYS` on the API. The 10 minute cache means up to 10 minutes of
already-resolved streams keep working from memory; nothing else is stored.

## Failure and fallback rules

The resolver falls through to Anivexa, unchanged, on **any** of:

| Trigger | Trace reason |
|---|---|
| flag off / no base URL / no key | `ANI_DISABLED`, `ANI_NOT_CONFIGURED` |
| no MAL id on the episode, the anime, or Anivexa `/map` | `ANI_NO_MAL_ID` |
| `exclude` contains an `ani:` entry | `ANI_EXCLUDED` |
| AniList id outside the rollout percentage | `ANI_OUT_OF_PERCENT` |
| dub requested and `ANI_DUB_ENABLED=0` | `ANI_DUB_DISABLED` |
| `MAL_NOT_FOUND`, `MAL_NOT_MAPPED`, `MAL_MAPPING_AMBIGUOUS`, `MAL_EPISODE_NOT_FOUND`, `MAL_EPISODE_MISMATCH` | the code itself |
| `stream_verified !== true` | `ANI_NOT_VERIFIED` |
| not `hls` / `master_url` off the allow-list | `ANI_BAD_STREAM_TYPE`, `ANI_HOST_NOT_ALLOWED` |
| no playable variant | `ANI_NO_VARIANT` |
| no playable subtitle while `ANI_REQUIRE_SUBTITLE=1` | `ANI_NO_SUBTITLE` |
| timeout / network / 5xx after one retry | `ANI_TIMEOUT`, `ANI_NETWORK`, `ANI_HTTP_ERROR` |
| 401/403 | `ANI_UNAUTHORIZED` |
| 429 | `ANI_RATE_LIMITED` (also pauses calls for `Retry-After`) |
| breaker open (5 failures in 60 s -> 60 s open) | `ANI_BREAKER_OPEN` |
| rate/concurrency budget spent | `ANI_SATURATED` |
| the master playlist does not answer | `ANI_PROBE_FAILED` |
| payload is not JSON | `ANI_BAD_JSON` |

Order is deliberate: identity before shape, shape before host, host before
"is there anything to play". A stream is never served on a guess.

## Subtitles

Every playable track the provider lists is returned, not just the first:

- ordered **default first, then English, then the provider's order**;
- `signs`/`forced` tracks are dropped only when a full track exists (a
  signs-only episode stays watchable);
- `label` is the provider's label **verbatim**;
- `srclang` is the track language, and is omitted when the API reports `und`
  (the player falls back to `en` exactly as before);
- `kind` is passed through (`full`, `signs`, `forced`, `dubtitle`).

Two delivery paths:

| Track | Route | Why |
|---|---|---|
| `format: "vtt"`, `converted: false` | existing signed `/api/proxy/subtitle` with `{Referer}` | the provider already serves WebVTT |
| `converted: true` or `format !== "vtt"` | new signed `/api/proxy/ani-subtitle` | needs real WebVTT |

`/api/proxy/ani-subtitle` (nodejs) holds the key. Its token carries only
`{mal, ep, audio, trackId}`, signed with the same HMAC as the other proxies and
expiring after 4 h. The route re-resolves the track through the ani cache (so it
works after a cold start), fetches the ani-api `proxied_url` server-side with
`X-API-Key` and the subtitle `Referer`, and answers `text/vtt; charset=utf-8`
with the same CORS headers as the other proxies and a 1 h cache. The browser
never receives an ani-api URL, an ani-api token, or the key.

The label -> `srclang` correction also learned compound labels: `Portuguese -
Brazil` -> `pt`, `Spanish (Latin America)` -> `es`, `Chinese - Chinese
(Simplified)` -> `zh-Hans`. It only fills a gap: a track that already states its
own `srclang` keeps it, and the exact-label map is unchanged.

## Direct segments

Every segment currently round-trips through Vercel's edge proxy, which is real
bandwidth. `DIRECT_SEGMENT_HOSTS` lets a playlist hand matching **media** URIs to
the browser as absolute URLs:

```
DIRECT_SEGMENT_HOSTS=hls1.drama1.cfd
```

- Matches the exact host and its subdomains.
- Playlists, `#EXT-X-KEY` and `#EXT-X-MAP` are **always** proxied.
- `none|off|0|false` (and unset) disable it; that is the default, so this
  deploy changes nothing.
- The list is honoured by the shared rewrite in `lib/proxy-signing.ts`, imported
  by `app/api/proxy/manifest/route.ts`, so the two cannot drift.
- The existing proxy routes run on the edge runtime, where Next.js inlines
  `process.env` at build time: **changing the variable takes a redeploy**, which
  matches every other switch here.

Before turning it on, play one episode through in a real browser and watch the
network panel:

1. Segments should request `https://hls1.drama1.cfd/...` directly and return
   `200`/`206` with `video/mp2t`.
2. No CORS error in the console. Segments come from a public CDN that answers
   `Access-Control-Allow-Origin: *`; the browser will send the site's `Referer`,
   which has **not** been verified against that CDN, so this is exactly what the
   manual test is for.
3. Seek, pause and resume once.

If anything fails, set `DIRECT_SEGMENT_HOSTS=none` and redeploy; the proxy path
is unchanged and always available.

## Observability

`GET /api/admin/ani-status` (nodejs, `Authorization: Bearer $CRON_SECRET`,
falling back to `EPISODE_CHECK_SECRET`; **503** when neither is set):

```json
{
  "enabled": true, "percent": 10, "dubEnabled": false, "requireSubtitle": true,
  "configured": true,
  "breaker": { "open": false, "opensInMs": 0, "recentFailures": 0 },
  "paused": { "paused": false, "resumesInMs": 0 },
  "limiter": { "windowRequests": 2, "ratePerMin": 30, "active": 0, "maxConcurrency": 3 },
  "cacheSize": 7, "negativeCacheSize": 1,
  "lastOutcomes": [{ "at": "...", "anilistId": 21, "malId": 21, "episode": 1, "audio": "sub", "outcome": "ok", "reason": null, "ms": 812 }],
  "counters": { "requests": 9, "cacheHits": 22, "cacheMisses": 9, "negativeHits": 1, "ok": 8, "failures": 1, "retries": 0, "byCode": { "MAL_NOT_MAPPED": 1 } },
  "scope": "per serverless instance"
}
```

No secrets, no URLs, no tokens. **Counters and caches are per serverless
instance**: Vercel runs several, so this is a sample, not a fleet total.

Each attempt also writes one line to the Vercel log:

```
ani_outcome {"anilist_id":21,"mal_id":21,"episode":1,"audio":"sub","outcome":"ok","reason":null,"ms":812}
```

Search the logs for `ani_outcome`. Cheap gate skips are only logged once the
provider is on, so a disabled deployment stays as quiet as it was.

## Security

- The key lives in `ANI_API_KEY` only, in the node runtime. `lib/ani/*` is
  imported exclusively by `runtime = 'nodejs'` route handlers; a test fails the
  suite if an edge route ever imports it.
- Signed handles (`streamUrl`, subtitle URLs, the ani-subtitle token) are
  **signed, not encrypted**, exactly like the existing proxy tokens: they carry
  the upstream URL and headers, never the key. Tests decode every one of them
  and assert the key, `X-API-Key` and the ani-api host are absent.
- `master_url` must be `https` on `dramahot.top` / `drama1.cfd` (subdomains
  allowed). Anything else is refused.
- `pnpm build` with a sentinel `ANI_API_KEY` followed by
  `ANI_KEY_SENTINEL=<value> pnpm test` greps `.next` for the sentinel and fails
  if it ever reaches the build output.
- Errors and trace lines carry codes only: no key, no request URL, no upstream
  URL.

## Known limitations

- **Streams live about 28 minutes.** An episode paused longer than that may need
  the player's retry, which excludes `ani:default` and correctly falls back to
  Anivexa. The 10 minute cache is capped below that on purpose.
- **ani-api cannot create episodes.** An episode Anivexa does not list never
  enters Play, so ani can only serve episodes that already exist here.
- **No intro/outro markers** when ani wins: those come from Anivexa.
- **Audio language is unverified** for both sub and dub, so dub through ani
  stays off until the owner has listened to a dub stream by ear.
- **Dub is resolved by Anivexa**, as before. The route makes a single ani
  attempt on the sub path; `ANI_DUB_ENABLED` is wired into the module and tested,
  but flipping it does not add a dub call site to this resolver.
- AniList -> MAL discovery costs one 3 s Anivexa `/map` call the first time; the
  answer is saved to `anime.mal_id`.

## Testing one episode

```bash
# what the resolver did for one episode
curl -s "https://play.otakunaija.name.ng/api/watch/<playId>?debug=1" | jq '{provider, audio, server, trace}'
```

`provider: "ani"` plus `trace[0]` starting with `ani: ok` means ani won.
`trace[0]` starting with `ani: skipped` / `ani: failed` tells you why it did not.

Then open the same episode on `https://otakunaija.name.ng`, press play, and check
in the browser devtools that `api/watch` returned `provider: "ani"` and that the
`/api/proxy/manifest` request answered `200` with a playlist. If the video plays
and subtitles appear in the menu, the provider works end to end.

## Local checks

```bash
pnpm test                                   # offline: fixtures, no network
pnpm build                                  # with a sentinel ANI_API_KEY
ANI_KEY_SENTINEL=<that value> pnpm test     # greps .next for the sentinel
ANI_API_BASE_URL=... ANI_API_KEY=... node scripts/ani-live-check.mjs
```

`scripts/ani-live-check.mjs` prints `stream_verified`, the variants and every
subtitle label for MAL 21, 52299 and 16498 episode 1. It never prints the key.
