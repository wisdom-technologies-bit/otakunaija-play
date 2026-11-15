# ani provider (PLAY-3)

OtakuNaija Play tries **our own ani-api first** and Anivexa second when it
resolves a stream for `GET /api/watch/[playId]`. The idea is the same as the
KumoriTV "ani" provider: a MAL id, a provider-verified HLS master, our own
subtitles.

The switch ships **off**. With `ANI_PROVIDER_ENABLED` unset (or `0`) the
resolver runs exactly the code it ran before this provider existed, and the
response is byte-identical.

- Branch: `ani-provider` (PLAY-2 at `afd3a7b`, PLAY-3 on top)
- Calls: `GET /v1/streams/mal/{mal_id}/episode/{n}?audio=sub&quality=best`
- Production base URL: `https://ani-api.kumoritv.top`
- First source today: **AniKoto** (`provider: "anikoto"`), ZokoAnime as fallback

## What PLAY-3 changed

Two defects found in review of `afd3a7b`, both of which broke playback on real
streams, plus support for AniKoto now being the API's first source:

1. **Subtitles that need no conversion were signed from the wrong URL.** Every
   vtt track was built from `track.proxied_url ?? track.url`, and `proxied_url`
   is a **relative** ani-api path (`/v1/subtitles/<token>.vtt`) that only works
   with the API key. The browser was handed a signed `/api/proxy/subtitle` URL
   pointing at a path the proxy cannot fetch. Now a track that needs no
   conversion is signed from its **raw, absolute** `track.url` (public CDN) with
   the subtitle `Referer`, and only a track that needs conversion goes through
   `/api/proxy/ani-subtitle`. Covered by
   `tests/ani-anikoto.test.ts` › *DEFECT 1*.
2. **The success log line logged `input.malId`**, which is `null` whenever the
   MAL id came from the lookup, so a working cold episode logged `mal_id: null`.
   It now logs the resolved id.

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
       then: GET ani-api with X-API-Key, cache (10 min), single-flight, breaker, limiter
       then: validate (verified stream, same MAL id + episode, hls, allow-listed host,
             playable variant, playable subtitle for sub)
       then: dub guard (a dub whose master_url equals the sub's is refused)
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
  "subtitles": [
    { "url": "/api/proxy/subtitle?...", "label": "Portuguese (- Portuguese(Brazil))", "srclang": "pt", "default": true, "kind": "full" },
    { "url": "/api/proxy/subtitle?...", "label": "Spanish (- Spanish(Latin America))", "srclang": "es", "default": false, "kind": "full" }
  ],
  "intro": { "start": 31, "end": 111 },
  "outro": { "start": 1376, "end": 1447 }
}
```

`intro` / `outro` are the **same two fields, in the same `{start, end}` shape**
Anivexa already fills, so the player reads them with no change. They are
`null` when the provider does not know (see [AniKoto](#anikoto-the-new-first-source)).

`server: null` matters: the player builds its retry exclusion as
`${provider}:${server ?? 'default'}`, so a failed ani stream becomes
`exclude=ani:default` and the next call skips ani entirely. That already works
with no change to otakunaija-main (checked in `components/episodes/video-player.tsx`).

`streamUrl` is our signed manifest proxy of the **raw** `master_url`. The
ani-api's `proxied_master_url` is never used, so nothing the browser touches
needs the key.

### What is deliberately NOT written

When ani wins, the route does **not** write `resolved_provider`,
`resolved_audio`, `resolved_at` and does **not** clear or set `needs_resync`.
Those columns describe Anivexa provider health; an ani stream must not hide a
broken Anivexa provider or mark a healthy one for resync.

## AniKoto, the new first source

All of this is from real `curl` output on 2026-11-15, not from docs.

| Fact | Value | Why it matters |
|---|---|---|
| `provider` | `"anikoto"` first, ZokoAnime as fallback | the same endpoint now answers with a different source |
| `master_url` host | `fetch.nexabloom.top` | had to be added to the master allow-list |
| `headers_required.master_playlist.Referer` | `https://megaplay.buzz/` | required for the playlist |
| `headers_required.subtitles.Referer` | `https://megaplay.buzz/` | required for every subtitle file |
| `headers_required.segments` | `{}` | **wrong**: segments also need that Referer |
| segment hosts | rotate: `*.twilightharbor.space`, `*.shadownest.top`, `*.mistyhorizon.space`, `*.silverorbit.top`, `*.eclipseharbor.space`, `*.oakhorizon.space` | no segment allow-list is possible |
| segment names | `seg-N-v1-a1.jpg`, `Content-Type: image/jpeg` | they are **real MPEG-TS**, first byte `0x47` |
| subtitle `url` | absolute, `*.mysubsplay.com` | this is the file to serve |
| subtitle `proxied_url` | relative, `/v1/subtitles/<token>.vtt` | **needs the key**, must never be signed for the browser |
| subtitle `language` | `"en"` on **every** track | the field is useless here; `srclang` comes from the label |
| `url_lifetime` | absent (`expiry_known: false`) | nothing may be cached longer than 10 minutes |
| `intro` / `outro` | `[31, 111]` / `[1376, 1447]` for One Piece ep 1; `[0, 0]` or null when unknown | real markers, no longer hard-coded to null |
| cold resolve | 2-10 s | the 12 s timeout stays |

### Every byte needs the Referer, so every byte is proxied

Segments return **403** to a request without `Referer: https://megaplay.buzz/`
and **403** with any other Referer. A browser sends the site's own URL, so it can
never fetch them itself. Because of that the manifest rewrite keeps proxying
media URIs whenever the signed headers contain a `Referer`, **regardless of
`DIRECT_SEGMENT_HOSTS`**:

- `DIRECT_SEGMENT_HOSTS` still works exactly as before for a stream whose signed
  headers carry no Referer (today: ZokoAnime, when the owner enables it).
- For an AniKoto stream it is ignored, because handing such a segment to the
  browser would 403 on a host the owner enabled for a different provider.
- Tests: `tests/segment-direct.test.ts` › *when the signed headers carry a
  Referer*.

### Segment content type: sniffed, not trusted

AniKoto serves MPEG-TS under `image/jpeg` with a `.jpg` name. `hls.js` will not
demux that if it trusts the header, so `/api/proxy/segment` sniffs the body:

- first byte `0x47` → served as `video/mp2t`, whatever the upstream called it;
- an HTML error page (`text/html`, or a body starting with `<`) → **502**, so the
  player retries and then excludes the provider instead of feeding markup to the
  demuxer;
- anything else keeps its upstream content type;
- only a *suspicious* content type is sniffed at all (missing, `image/*`,
  `text/html`, `application/octet-stream`, `binary/octet-stream`, `text/plain`):
  a known length up to 2 MB is buffered, anything larger or chunked is decided
  from the first 64 KB and the rest keeps streaming;
- a `Range` request that does not start at byte 0 is streamed through untouched,
  because its first byte is not a sync byte and sniffing it would prove nothing.

### intro / outro

`intro` and `outro` are `[start, end]` in seconds. **Valid** means both numbers
are finite and `end > start`; `[0, 0]`, `[111, 31]`, a missing field and a null
all become `null`. The numbers are turned into `{start, end}` in
`lib/ani/resolve.ts` and returned in the fields the player already reads.

## Environment variables

All read at request time except the edge proxies, which inline them at build
time (see [Direct segments](#direct-segments)). None has a `NEXT_PUBLIC_` prefix.

| Variable | Default | Meaning |
|---|---|---|
| `ANI_API_BASE_URL` | *(none)* | Base URL of the ani-api. Unset = provider off. |
| `ANI_API_KEY` | *(none)* | Play's own key, sent as `X-API-Key`. Unset = provider off. |
| `ANI_PROVIDER_ENABLED` | `0` | `1`/`true`/`yes`/`on` turns the provider on. |
| `ANI_PROVIDER_PERCENT` | `100` | 0-100 rollout, stable FNV-1a bucket of `anilist_id`. Start at `10`. |
| `ANI_DUB_ENABLED` | `0` | Dub through ani. Off because the API never verifies audio language. |
| `ANI_REQUIRE_SUBTITLE` | `1` | A sub stream needs one playable subtitle track, like Anivexa sub providers. |
| `ANI_ANIKOTO_REQUIRE_SUBTITLE` | `1` | Same rule for **AniKoto only**. Set `0` to let a zero-subtitle episode play. |
| `ANI_MASTER_HOSTS` | `nexabloom.top,dramahot.top,drama1.cfd` | Comma-separated master hosts, subdomains included. **Replaces** the list. |
| `ANI_API_TIMEOUT_MS` | `12000` | Per-request timeout. Cold AniKoto resolves take 2-10 s. |
| `ANI_MAX_CONCURRENCY` | `3` | In-flight resolves per instance. Saturated = skip, never queue a viewer. |
| `ANI_RATE_PER_MIN` | `30` | Requests/minute per instance. The real ceiling is the API's **60/min per key**. |
| `DIRECT_SEGMENT_HOSTS` | `none` | Media hosts the browser may load directly. Ignored for any stream with a `Referer`. |

`ANI_RATE_PER_MIN` is a per-instance politeness budget, not the account limit:
Vercel runs several instances and each keeps its own counter. Play uses a
**separate key** from KumoriTV so the two never share the 60/min budget and can
be revoked independently.

### Request budget

`maxDuration` is 240 s and the ani attempt cannot eat it:

- 3 s MAL lookup (once per title, saved to `anime.mal_id`)
- 12 s ani-api timeout, retried **once** on timeout/5xx → 24 s worst case
- 4 s playlist probe

≈31 s worst case before the Anivexa race starts, which leaves ~200 s for the
Anivexa providers and the catalog retry they need. No change to `maxDuration`.

## Bandwidth and cost (read this before raising the percentage)

With AniKoto **all media goes through Vercel**: the playlist, every subtitle and
every segment, because each one needs `Referer: https://megaplay.buzz/`. A
10-minute episode is roughly 200-600 MB, and Vercel bills the edge request time
and the bandwidth for all of it. That is a real cost the ZokoAnime path mostly
avoided by allowing direct CDN segments.

`/api/proxy/segment` sniffs only a suspicious content type and then reads at most
64 KB of it (or buffers 2 MB when the length is known and small); every properly
typed segment and mp4 is streamed straight through, so this shared route adds no
buffering cost to a stream that is not ani's.

So: start at `ANI_PROVIDER_PERCENT=10`, watch Vercel → Usage → *Edge Requests*,
*Data Transfer* and *Function/Edge execution time*, and raise it in steps only
while the numbers stay comfortable. The `/api/proxy/*` edge routes are unchanged
and keep doing the work they did before; there is no second proxy layer.

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
   ANI_ANIKOTO_REQUIRE_SUBTITLE=1
   ANI_MASTER_HOSTS=nexabloom.top,dramahot.top,drama1.cfd
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
3. Keep an eye on Vercel usage in the same window (see above).
4. Raise to 25, then 50, then 100, one redeploy each, with the same check.
5. Compare a handful of episodes: `curl "https://play.otakunaija.name.ng/api/watch/<playId>?debug=1"`
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
| dub payload's `master_url` equals the sub payload's | `ANI_DUB_SAME_AS_SUB` |
| `MAL_NOT_FOUND`, `MAL_NOT_MAPPED`, `MAL_MAPPING_AMBIGUOUS`, `MAL_EPISODE_NOT_FOUND`, `MAL_EPISODE_MISMATCH` | the code itself |
| `stream_verified !== true` | `ANI_NOT_VERIFIED` |
| not `hls` / `master_url` off the allow-list | `ANI_BAD_STREAM_TYPE`, `ANI_HOST_NOT_ALLOWED` |
| no playable variant | `ANI_NO_VARIANT` |
| no playable subtitle while the provider's require-subtitle switch is on | `ANI_NO_SUBTITLE` |
| timeout / network / 5xx after one retry | `ANI_TIMEOUT`, `ANI_NETWORK`, `ANI_HTTP_ERROR` |
| 401/403 | `ANI_UNAUTHORIZED` |
| 429 | `ANI_RATE_LIMITED` (also pauses calls for `Retry-After`) |
| breaker open (5 failures in 60 s -> 60 s open) | `ANI_BREAKER_OPEN` |
| rate/concurrency budget spent | `ANI_SATURATED` |
| the master playlist does not answer | `ANI_PROBE_FAILED` |
| payload is not JSON | `ANI_BAD_JSON` |

Order is deliberate: identity before shape, shape before host, host before
"is there anything to play". A stream is never served on a guess.

### The dub guard

Dubs stay off (`ANI_DUB_ENABLED=0`) because the API does not verify the audio
language. On top of that, a dub payload is now **refused** when its `master_url`
is identical to the sub payload's for the same episode: for MAL 52299 episode 1
the two are byte-for-byte the same URL, so the "dub" really is the sub. That
case answers `ANI_DUB_SAME_AS_SUB` and falls through to Anivexa. The guard costs
one cached sub resolve and only runs on the dub path.

## Subtitles

Every playable track the provider lists is returned, not just the first:

- ordered **default first, then English, then the provider's order**;
- `signs`/`forced` tracks are dropped only when a full track exists (a
  signs-only episode stays watchable);
- `label` is the provider's label **verbatim**;
- `kind` is passed through (`full`, `signs`, `forced`, `dubtitle`).

Two delivery paths, decided **per track**:

| Track | Route | Token carries |
|---|---|---|
| `format: "vtt"`, `converted: false` | existing `/api/proxy/subtitle`, signed from the **raw absolute `url`** with `{Referer: headers_required.subtitles.Referer}` | the CDN url + the Referer |
| `converted: true`, `format !== "vtt"`, or no absolute `url` at all | `/api/proxy/ani-subtitle` | `{mal, ep, audio, trackId}` only |

The first row is the PLAY-3 fix. `proxied_url` is **never** signed for the
browser: it is a relative ani-api path that needs `X-API-Key`.

`/api/proxy/ani-subtitle` (nodejs) holds the key. Its token is signed with the
same HMAC as the other proxies and expires after 4 h. The route re-resolves the
track through the ani cache (so it works after a cold start), fetches the
ani-api `proxied_url` server-side with `X-API-Key` and the subtitle `Referer`,
and answers `text/vtt; charset=utf-8` with the same CORS headers as the other
proxies and a 1 h cache.

### `srclang`

- **AniKoto**: the `language` field is `"en"` on every track it returns, so it is
  never used. `srclang` is derived from the label's leading word:
  `Portuguese (- Portuguese(Brazil))` → `pt`, `Spanish (- Spanish(Latin America))`
  → `es`, `Arabic` → `ar`, `Thai` → `th`. Unknown labels get no `srclang` and the
  player falls back to `en`, exactly as before.
- **Every other provider (including ZokoAnime)**: unchanged. The declared
  language is used, and omitted when the API says `und`. The watch route's
  label-correction pass is also unchanged (it only fills a missing `srclang`).

The mapping lives in `lib/subtitle-language.ts`, shared by the watch route and
`lib/ani/resolve.ts`, so the two cannot drift.

## Direct segments

Every segment currently round-trips through Vercel's edge proxy, which is real
bandwidth. `DIRECT_SEGMENT_HOSTS` lets a playlist hand matching **media** URIs to
the browser as absolute URLs:

```
DIRECT_SEGMENT_HOSTS=hls1.drama1.cfd
```

- Matches the exact host and its subdomains.
- Playlists, `#EXT-X-KEY` and `#EXT-X-MAP` are **always** proxied.
- **A stream whose signed headers contain a `Referer` is never affected**: every
  media URI keeps being proxied, whatever the variable says. AniKoto is exactly
  that case (`Referer: https://megaplay.buzz/`, 403 to everything else).
- `none|off|0|false` (and unset) disable it; that is the default, so this
  deploy changes nothing.
- The list is honoured by the shared rewrite in `lib/proxy-signing.ts`, imported
  by `app/api/proxy/manifest/route.ts`, so the two cannot drift.
- The existing proxy routes run on the edge runtime, where Next.js inlines
  `process.env` at build time: **changing this variable takes a redeploy**.

Before turning it on, play one episode through in a real browser and watch the
network panel:

1. Segments should request `https://hls1.drama1.cfd/...` directly and return
   `200`/`206` with `video/mp2t`.
2. No CORS error in the console. That CDN answers `Access-Control-Allow-Origin: *`
   but only allows `Origin: https://zokoanime.video`, so browser-direct segments
   fail in hls.js for every other site. This is exactly what the manual test is
   for, and why the default stays `none`.
3. Seek, pause and resume once.

If anything fails, set `DIRECT_SEGMENT_HOSTS=none` and redeploy; the proxy path
is unchanged and always available.

## Downloads (documented only, no UI)

The ani-api exposes download links:

```
GET /v1/downloads/mal/{mal_id}/episode/{n}
```

Kiwi (via nekostream) returns landing-page URLs, not direct files, and the
endpoint needs the same `X-API-Key`. **Play does not call it and adds no
download UI**: the player lives in otakunaija-main, so any download button is
that project's decision. Recorded here so a later prompt does not have to
rediscover it.

## Observability

`GET /api/admin/ani-status` (nodejs, `Authorization: Bearer $CRON_SECRET`,
falling back to `EPISODE_CHECK_SECRET`; **503** when neither is set):

```json
{
  "enabled": true, "percent": 10, "dubEnabled": false,
  "requireSubtitle": true, "anikotoRequireSubtitle": true,
  "masterHosts": ["nexabloom.top", "dramahot.top", "drama1.cfd"],
  "configured": true,
  "breaker": { "open": false, "opensInMs": 0, "recentFailures": 0 },
  "paused": { "paused": false, "resumesInMs": 0 },
  "limiter": { "windowRequests": 2, "ratePerMin": 30, "active": 0, "maxConcurrency": 3 },
  "cacheSize": 7, "negativeCacheSize": 1,
  "lastOutcomes": [{ "at": "...", "anilistId": 21, "malId": 21, "episode": 1, "audio": "sub", "outcome": "ok", "reason": null, "ms": 4812 }],
  "counters": { "requests": 9, "cacheHits": 22, "cacheMisses": 9, "negativeHits": 1, "ok": 8, "failures": 1, "retries": 0, "byCode": { "MAL_NOT_MAPPED": 1 } },
  "scope": "per serverless instance"
}
```

No secrets, no URLs, no tokens. **Counters and caches are per serverless
instance**: Vercel runs several, so this is a sample, not a fleet total.

Each attempt also writes one line to the Vercel log, now with the **resolved**
MAL id:

```
ani_outcome {"anilist_id":21,"mal_id":21,"episode":1,"audio":"sub","outcome":"ok","reason":null,"ms":4812}
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
  and assert the key, `X-API-Key`, the ani-api host and `/v1/subtitles` are
  absent.
- `master_url` must be `https` on `nexabloom.top`, `dramahot.top` or
  `drama1.cfd` (subdomains allowed), or on whatever `ANI_MASTER_HOSTS` lists.
- **No segment host allow-list on purpose.** AniKoto's segment hosts rotate
  (`*.twilightharbor.space`, `*.shadownest.top`, …), so a list would be a
  maintenance trap. The guard is the signature instead: the segment proxy only
  ever fetches a URL this deployment signed, with the headers it signed.
- `pnpm build` with a sentinel `ANI_API_KEY` followed by
  `ANI_KEY_SENTINEL=<value> pnpm test` greps `.next` for the sentinel and fails
  if it ever reaches the build output.
- Errors and trace lines carry codes only: no key, no request URL, no upstream
  URL.

## Known limitations

- **Streams live about 10 minutes in cache and ~28 minutes upstream.** AniKoto
  publishes no lifetime at all (`expiry_known: false`), so its cache entry is
  capped at 10 minutes and never extended. An episode paused longer than the URL
  lives may need the player's retry, which excludes `ani:default` and correctly
  falls back to Anivexa.
- **All AniKoto media costs Vercel bandwidth** (Referer required), see above.
- **Segment hosts rotate**, so nothing about them can be pre-approved; a blocked
  host shows up as an `UPSTREAM_FETCH_FAILED` 502 from `/api/proxy/segment`.
- **Zero-subtitle episodes**: AniKoto sometimes returns no tracks (hard-sub or
  no subs, the API does not say). With `ANI_ANIKOTO_REQUIRE_SUBTITLE=1` those
  fall through to Anivexa; the owner flips it to `0` after checking by eye.
- **Subtitle `language` is untrustworthy for AniKoto** (always `"en"`), hence the
  label mapping. A label the map does not know gets no `srclang`.
- **Audio language is unverified** for both sub and dub, so dub through ani
  stays off until the owner has listened to a dub stream by ear. The dub guard
  only rejects a dub that is literally the sub.
- **Dub is resolved by Anivexa**, as before. The route makes a single ani
  attempt on the sub path; `ANI_DUB_ENABLED` and the dub guard are wired into
  the module and tested, but flipping the flag does not add a dub call site.
- **ani-api cannot create episodes.** An episode Anivexa does not list never
  enters Play, so ani can only serve episodes that already exist here.
- **Downloads are documented, not implemented** (see above).
- AniList -> MAL discovery costs one 3 s Anivexa `/map` call the first time; the
  answer is saved to `anime.mal_id`.

## Testing one episode

```bash
# what the resolver did for one episode
curl -s "https://play.otakunaija.name.ng/api/watch/<playId>?debug=1" \
  | jq '{provider, audio, server, intro, outro, trace}'

# and what the browser is actually handed for the subtitles
curl -s "https://play.otakunaija.name.ng/api/watch/<playId>?debug=1" \
  | jq -r '.subtitles[] | "\(.label) \(.srclang) \(.url[0:40])"'
```

With `?debug=1` you get:

- `trace[0]` starting `ani: ok <n>ms` → ani won, and `mal_id` is now the
  **resolved** id in the log line (not `null` when it came from the lookup);
- `trace[0]` starting `ani: skipped …` / `ani: failed …` → the reason, e.g.
  `ANI_NO_SUBTITLE` (zero-track AniKoto episode with the strict rule on),
  `ANI_DUB_SAME_AS_SUB`, `ANI_HOST_NOT_ALLOWED`, `ANI_PROBE_FAILED`;
- `provider: "ani"`, `intro`/`outro` objects (or `null`), and one subtitle entry
  per track with a `srclang` derived from its label.

Then open the same episode on `https://otakunaija.name.ng` and check in devtools
that:

1. `api/watch` returned `provider: "ani"`;
2. `/api/proxy/manifest` answered `200` with a playlist;
3. `/api/proxy/segment` requests answer `200` with `video/mp2t` (not
   `image/jpeg`) and the playlist shows proxied segment URLs even if
   `DIRECT_SEGMENT_HOSTS` is set;
4. `/api/proxy/subtitle` answers `200 text/vtt` for every track and the file is
   real WebVTT, not `INVALID_OR_EXPIRED_SIGNATURE` and not a 502;
5. the intro "skip" marker appears where the provider reported one.

## Local checks

```bash
pnpm test                                   # offline: fixtures, no network
pnpm build                                  # with a sentinel ANI_API_KEY
ANI_KEY_SENTINEL=<that value> pnpm test     # greps .next for the sentinel
ANI_API_BASE_URL=... ANI_API_KEY=... node scripts/ani-live-check.mjs
```

`scripts/ani-live-check.mjs` prints the provider, `stream_verified`, the
variants, the intro/outro markers and every subtitle label with its `language`
and `format` for MAL 21, 52299 and 16498 episode 1. It never prints the key.

**Not covered by these tests** (they need the real service or a browser): real
playback through hls.js, a real keyed API run, and whether a rotating segment
host is reachable from the edge at any given moment.
