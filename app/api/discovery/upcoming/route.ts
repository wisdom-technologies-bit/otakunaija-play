import { authorizeCron } from '@/lib/auth'
import {
  UPCOMING_DEFAULT_MIN_POPULARITY,
  UPCOMING_TIME_BUDGET_MS,
  UPCOMING_WINDOW_MONTHS,
  createAdminClient,
  fetchAniListWithRetry,
  fetchUpcomingMedia,
  getErrorMessage,
  getRemaining,
  getWaitSeconds,
  parseAniListMediaPage,
  readCursorPage,
  readDiscoveryState,
  shouldPauseBeforeNextPage,
  sleep,
  writeDiscoveryState,
  type AniListMediaPageResponse,
  type UpcomingSort,
} from '@/lib/supabase/admin'
import { insertAnimeRows, type PlaceholderRow } from '@/lib/placeholder'
import {
  MERGEABLE_ANIME_FIELDS,
  changedAnimeFields,
  mergeAnimeMetadata,
  normalizeAniListMedia,
  selectUpcoming,
  toPlaceholderRow,
  type AnimeUpsertRow,
  type NormalizedMedia,
} from '@/lib/upcoming'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PER_PAGE = 50
const DEFAULT_PAGES = 3
const MAX_PAGES_PER_RUN = 8
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 400

type ExistingAnime = PlaceholderRow & Record<string, unknown>

/** Signals "no database configured" without tripping the error counters. */
class SkipDatabasePhase extends Error {}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max)
}

function stateKey(sort: UpcomingSort) {
  return sort === 'POPULARITY_DESC' ? 'upcoming:popularity' : 'upcoming:start_date'
}

/** Load the rows we might need to merge into, in chunks PostgREST accepts. */
async function loadExistingAnime(
  supabase: ReturnType<typeof createAdminClient>,
  anilistIds: number[],
): Promise<Map<number, ExistingAnime>> {
  const found = new Map<number, ExistingAnime>()
  const columns = [
    'anilist_id',
    'is_placeholder',
    'otaku_anime_id',
    'status_synced_to_otaku',
    ...MERGEABLE_ANIME_FIELDS,
  ].join(', ')

  for (let index = 0; index < anilistIds.length; index += 100) {
    const chunk = anilistIds.slice(index, index + 100)
    const { data, error } = await supabase.from('anime').select(columns).in('anilist_id', chunk)
    if (error) throw new Error(`Failed to read existing anime: ${error.message}`)
    for (const row of (data ?? []) as unknown as ExistingAnime[]) {
      found.set(row.anilist_id, row)
    }
  }

  return found
}

/**
 * GET /api/discovery/upcoming
 *
 * Sweeps AniList for anime that have not started airing and stores them as
 * metadata-only placeholders (is_placeholder = true). No pending_sync rows, no
 * episodes, no Jikan/Anivexa calls: AniList data only.
 *
 * Params: dry=1, limit (rows), pages (AniList pages), sort=popularity.
 */
export async function GET(request: Request) {
  const unauthorized = authorizeCron(request)
  if (unauthorized) return unauthorized

  const startedAt = Date.now()
  const url = new URL(request.url)
  const dry = url.searchParams.get('dry') === '1'
  const pagesToFetch = clamp(Number(url.searchParams.get('pages') ?? DEFAULT_PAGES), 1, MAX_PAGES_PER_RUN)
  const limit = clamp(Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT), 1, MAX_LIMIT)
  const sort: UpcomingSort = url.searchParams.get('sort') === 'popularity' ? 'POPULARITY_DESC' : 'START_DATE'
  const minPopularity = clamp(
    Number(process.env.UPCOMING_MIN_POPULARITY ?? UPCOMING_DEFAULT_MIN_POPULARITY),
    0,
    Number.MAX_SAFE_INTEGER,
  )

  const errors: string[] = []
  const key = stateKey(sort)

  // A dry run is also the way to smoke-test AniList connectivity from a laptop
  // without database credentials, so a missing client degrades instead of 500s.
  let supabase: ReturnType<typeof createAdminClient> | null = null
  try {
    supabase = createAdminClient()
  } catch (error) {
    errors.push(`database unavailable: ${getErrorMessage(error)}`)
  }

  let pagesFetched = 0
  let fetched = 0
  let rateLimited = 0
  let remaining: number | null = null
  let startPage = 1
  let nextPage = 1
  let cursorReachedEnd = false

  if (supabase) {
    try {
      const state = await readDiscoveryState(key).catch((error) => {
        errors.push(`discovery_state: ${getErrorMessage(error)}`)
        return null
      })
      startPage = readCursorPage(state)
    } catch (error) {
      errors.push(getErrorMessage(error))
    }
  }

  const collected: NormalizedMedia[] = []
  let page = startPage

  for (let index = 0; index < pagesToFetch; index += 1) {
    if (Date.now() - startedAt >= UPCOMING_TIME_BUDGET_MS) break
    if (collected.length >= limit) break

    const result = await fetchAniListWithRetry(
      () => fetchUpcomingMedia(page, { perPage: PER_PAGE, sort }),
      (payload) => parseAniListMediaPage(payload as AniListMediaPageResponse),
      { deadline: startedAt + UPCOMING_TIME_BUDGET_MS },
    )

    if (!result.ok) {
      if (result.rateLimited) rateLimited += 1
      errors.push(`page ${page}: ${result.error}`)
      // Keep the cursor on the failed page so the next run retries it.
      nextPage = page
      break
    }

    pagesFetched += 1
    fetched += result.parsed.media.length
    remaining = getRemaining(result.headers) ?? remaining

    for (const media of result.parsed.media) {
      if (collected.length >= limit) break
      const normalized = normalizeAniListMedia(media)
      if (normalized) collected.push(normalized)
    }

    if (!result.parsed.hasNextPage) {
      // Wrap around: the sweep restarts from page 1 next run.
      cursorReachedEnd = true
      nextPage = 1
      page = 1
      break
    }

    page += 1
    nextPage = page

    if (shouldPauseBeforeNextPage(result.headers)) {
      const waitSeconds = getWaitSeconds(result.headers)
      if (Date.now() + waitSeconds * 1000 < startedAt + UPCOMING_TIME_BUDGET_MS) {
        await sleep(waitSeconds)
      } else {
        break
      }
    }
  }

  // De-duplicate by id (AniList can repeat a title across pages under a sort tie).
  const byId = new Map<number, NormalizedMedia>()
  for (const item of collected) if (!byId.has(item.anilist_id)) byId.set(item.anilist_id, item)
  const unique = [...byId.values()]

  const selection = selectUpcoming(unique, {
    minPopularity,
    windowMonths: UPCOMING_WINDOW_MONTHS,
  })

  let inserted = 0
  let updated = 0
  let unchanged = 0
  let skippedExisting = 0
  let writeErrors = 0

  try {
    if (!supabase) {
      // No database: report what a real run would insert.
      inserted = selection.accepted.length
      throw new SkipDatabasePhase()
    }

    const existing = await loadExistingAnime(
      supabase,
      selection.accepted.map((item) => item.anilist_id),
    )

    const toInsert: AnimeUpsertRow[] = []
    const toUpdate: Array<{ anilist_id: number; patch: Record<string, unknown> }> = []

    for (const item of selection.accepted) {
      const current = existing.get(item.anilist_id)

      // A real anime already owns this row: never overwrite its metadata.
      if (current && current.is_placeholder !== true) {
        skippedExisting += 1
        continue
      }

      if (!current) {
        toInsert.push(toPlaceholderRow(item, { discoverySource: 'upcoming' }))
        continue
      }

      // Placeholder refresh: dates/trailer/popularity change often, but a null
      // from AniList must never blank a value we already have.
      const merged = mergeAnimeMetadata(current, item)
      const changed = changedAnimeFields(current, merged)
      if (!changed.length) {
        unchanged += 1
        continue
      }

      const now = new Date().toISOString()
      toUpdate.push({
        anilist_id: item.anilist_id,
        patch: {
          ...merged,
          anilist_synced_at: now,
          upcoming_checked_at: now,
          updated_at: now,
        },
      })
    }

    if (!dry) {
      inserted = await insertAnimeRows(supabase, toInsert)

      for (const entry of toUpdate) {
        const { data, error } = await supabase
          .from('anime')
          .update(entry.patch)
          .eq('anilist_id', entry.anilist_id)
          // Guards a race with sync/process promoting the row mid-run.
          .eq('is_placeholder', true)
          .select('anilist_id')

        if (error) {
          writeErrors += 1
          errors.push(`update ${entry.anilist_id}: ${error.message}`)
          continue
        }
        updated += data?.length ?? 0
      }
    } else {
      inserted = toInsert.length
      updated = toUpdate.length
    }
  } catch (error) {
    if (!(error instanceof SkipDatabasePhase)) {
      writeErrors += 1
      errors.push(`database: ${getErrorMessage(error)}`)
    }
  }

  if (!dry && supabase) {
    try {
      await writeDiscoveryState(key, {
        next_page: nextPage,
        pages_fetched: pagesFetched,
        last_run_at: new Date().toISOString(),
        reached_end: cursorReachedEnd,
      })
    } catch (error) {
      errors.push(`discovery_state write: ${getErrorMessage(error)}`)
    }
  }

  return Response.json({
    fetched,
    inserted,
    updated,
    skippedExisting,
    skippedAdult: selection.skippedAdult,
    skippedNoCover: selection.skippedNoCover,
    rateLimited,
    remaining,
    ms: Date.now() - startedAt,
    errors,
    dry,
    // extras: useful in the dry run transcript, harmless for the cron
    skippedFormat: selection.skippedFormat,
    skippedOutOfWindow: selection.skippedOutOfWindow,
    skippedLowPopularity: selection.skippedLowPopularity,
    unchanged,
    database: supabase ? 'ok' : 'unavailable',
    writeErrors,
    pagesFetched,
    pageFrom: startPage,
    nextPage,
    reachedEnd: cursorReachedEnd,
    sort,
    minPopularity,
    windowMonths: UPCOMING_WINDOW_MONTHS,
    skippedSample: selection.reasons.slice(0, 20),
    acceptedSample: selection.accepted.slice(0, 10).map((item) => ({
      anilistId: item.anilist_id,
      title: item.title,
      format: item.format,
      startDate: item.start_date,
      season: item.season,
      seasonYear: item.season_year,
      popularity: item.popularity,
    })),
  })
}
