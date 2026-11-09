# Upcoming discovery: local verification

Run on 2026-11-09 from a sandbox with **no** Supabase or OtakuNaija credentials.
The AniList and Anivexa halves therefore ran against the real APIs while every
database write was skipped, so the numbers below are what the routes *would*
write. Where the JSON says `"database": "unavailable"` the rows were counted, not
stored.

Commands (dev server on port 3111, `CRON_SECRET=local-test-secret`):

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "http://127.0.0.1:3111/api/discovery/upcoming?dry=1&pages=2&limit=40"
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "http://127.0.0.1:3111/api/discovery/seasonal?dry=1&pages=1"
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "http://127.0.0.1:3111/api/export/upcoming?dry=1&limit=5"
curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" -H 'content-type: application/json' \
  -d '{"url":"https://anilist.co/anime/126016/AKIRA-Shin-Anime"}' \
  "http://127.0.0.1:3111/api/discovery/request"
```

## GET /api/discovery/upcoming?dry=1&pages=2&limit=40

```json
{
  "fetched": 50,
  "inserted": 25,
  "updated": 0,
  "skippedExisting": 0,
  "skippedAdult": 0,
  "skippedNoCover": 0,
  "rateLimited": 0,
  "remaining": 29,
  "ms": 149,
  "errors": [
    "database unavailable: Supabase server credentials are not configured"
  ],
  "dry": true,
  "skippedFormat": 0,
  "skippedOutOfWindow": 0,
  "skippedLowPopularity": 15,
  "unchanged": 0,
  "database": "unavailable",
  "writeErrors": 0,
  "pagesFetched": 1,
  "pageFrom": 1,
  "nextPage": 2,
  "reachedEnd": false,
  "sort": "START_DATE",
  "minPopularity": 2000,
  "windowMonths": 9,
  "skippedSample": [
    {
      "anilistId": 115006,
      "title": "Top wo Nerae 3! (Provisional Title)",
      "reason": "low_popularity_tba"
    },
    {
      "anilistId": 194456,
      "title": "Ninja Kamui Season 3",
      "reason": "low_popularity_tba"
    },
    {
      "anilistId": 212507,
      "title": "Gekkakoku Kiiden",
      "reason": "low_popularity_tba"
    }
  ],
  "acceptedSample": [
    {
      "anilistId": 126016,
      "title": "AKIRA (Shin Anime)",
      "format": "TV",
      "startDate": null,
      "season": null,
      "seasonYear": null,
      "popularity": 14583
    },
    {
      "anilistId": 165523,
      "title": "BORUTO: NARUTO NEXT GENERATIONS Part 2",
      "format": "TV",
      "startDate": null,
      "season": null,
      "seasonYear": null,
      "popularity": 10301
    },
    {
      "anilistId": 217136,
      "title": "Grand Blue Season 4",
      "format": "TV",
      "startDate": null,
      "season": null,
      "seasonYear": null,
      "popularity": 9448
    },
    {
      "anilistId": 87497,
      "title": "MEKAKUCITY RELOAD",
      "format": "TV",
      "startDate": null,
      "season": null,
      "seasonYear": null,
      "popularity": 7828
    }
  ]
}
```

## GET /api/discovery/seasonal?dry=1&pages=1

```json
{
  "dry": true,
  "seasons": [
    {
      "season": "FALL",
      "year": 2026
    },
    {
      "season": "SUMMER",
      "year": 2026
    }
  ],
  "pagesFetched": 2,
  "mediaSeen": 100,
  "candidates": 100,
  "alreadyKnown": 0,
  "skippedAdultOrNoCover": 0,
  "anivexaChecked": 8,
  "queuedAnime": 8,
  "pendingSyncInserted": 0,
  "queuedInDryRun": 8,
  "noProviders": 0,
  "anivexaErrors": 0,
  "budgetExhausted": true,
  "database": "unavailable",
  "rateLimited": 0,
  "remaining": 24,
  "ms": 31740,
  "errors": [
    "database unavailable: Supabase server credentials are not configured"
  ],
  "queuedSample": [
    {
      "anilistId": 195539,
      "title": "Cyberpunk: Edgerunners 2",
      "episodes": [
        1,
        2,
        3
      ]
    },
    {
      "anilistId": 195516,
      "title": "The Apothecary Diaries Season 3",
      "episodes": [
        1,
        2,
        3
      ]
    },
    {
      "anilistId": 195604,
      "title": "Black Clover Season 2",
      "episodes": [
        1,
        2,
        3
      ]
    }
  ]
}
```

## GET /api/export/upcoming?dry=1&limit=5

Without database credentials the route cannot select placeholders, so it reports
the configuration problem instead of pretending to work:

```json
{
  "error": "SUPABASE_NOT_CONFIGURED",
  "message": "Supabase server credentials are not configured",
  "dry": true
}
```

## POST /api/discovery/request

Both calls reached AniList and computed the mode; neither stored anything
because the database client could not be created.

```json
{
  "error": "SUPABASE_NOT_CONFIGURED",
  "message": "Supabase server credentials are not configured",
  "anilistId": 126016,
  "title": "AKIRA (Shin Anime)",
  "mode": "placeholder",
  "status": "NOT_YET_RELEASED",
  "otakuAnimeId": null,
  "database": "unavailable"
}
```

```json
{
  "error": "SUPABASE_NOT_CONFIGURED",
  "message": "Supabase server credentials are not configured",
  "anilistId": 21,
  "title": "ONE PIECE",
  "mode": "queued",
  "status": "RELEASING",
  "otakuAnimeId": null,
  "database": "unavailable"
}
```

## Placeholder export payload (real AniList data)

`LIVE_ANILIST=1 npx vitest run tests/live-upcoming.test.ts` fetches AniList id
126016, normalises it, builds the placeholder row and prints the exact body the
export route POSTs to OtakuNaija:

```json
{
  "anilistId": 126016,
  "title": "AKIRA (Shin Anime)",
  "description": "Announced at Anime Expo 2019, the project is meant to be a complete adaptation of Ootomo Katsuhiro's post-apocalyptic cyberpunk manga AKIRA.",
  "coverUrl": "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx126016-9PaIQHxFyyho.png",
  "genres": ["Action", "Drama", "Horror", "Psychological", "Sci-Fi", "Supernatural"],
  "status": "upcoming",
  "releaseYear": null,
  "studioName": "Sunrise",
  "posterUrl": "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx126016-9PaIQHxFyyho.png",
  "bannerUrl": null,
  "format": "TV",
  "startDate": null,
  "startYear": null,
  "season": null,
  "seasonYear": null,
  "popularity": 14583,
  "trailerSite": null,
  "trailerId": null,
  "episodesTotal": null,
  "durationMinutes": null,
  "source": "MANGA",
  "isPlaceholder": true
}
```

## Not covered locally

- Supabase writes: `anime` inserts/updates, `pending_sync` inserts,
  `discovery_state` cursors and `discovery_requests` rows. The SQL and the row
  shapes are unit tested; the PostgREST calls themselves need a deployment.
- OtakuNaija export: `POST /api/play/anime` responses, `otaku_anime_id` capture
  and the status flips.
