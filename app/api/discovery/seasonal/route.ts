import { authorizeCron } from '@/lib/auth'
import { fetchAnivexaAvailability, lowestPlayableEpisode } from '@/lib/anivexa'
import {
  UPCOMING_TIME_BUDGET_MS,
  createAdminClient,
  fetchAniListWithRetry,
  fetchSeasonalMedia,
  getErrorMessage,
  getRemaining,
  getWaitSeconds,
  insertPendingSyncWithSource,
  parseAniListMediaPage,
  shouldPauseBeforeNextPage,
  sleep,
  type AniListMediaPageResponse,
} from '@/lib/supabase/admin'
import {
  episodesToQueue,
  normalizeAniListMedia,
  seasonalTargets,
  type AniListMedia,
  type NormalizedMedia,
} from '@/lib/upcoming'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PER_PAGE = 50
const DEFAULT_PAGES = 2
const MAX_PAGES = 4
const MAX_SEASONS = 3
const MAX_ANIVEXA_CHECKS = 30
const ANIVEXA_CONCURRENCY = 4
// Anivexa is slow (20 s+ from cold regions), so the timeout must be generous:
// a 12 s cutoff rejected almost every call. Override with ANIVEXA_TIMEOUT_MS.
const ANIVEXA_TIMEOUT_MS = Number(process.env.ANIVEXA_TIMEOUT_MS ?? 20_000)
// Never start an Anivexa call that cannot finish inside the route's maxDuration.
const START_GUARD_MS = ANIVEXA_TIMEOUT_MS + 2_000
const EPISODES_PER_ANIME_CAP = 3

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max)
}

async function loadKnownAnime(
  supabase: ReturnType<typeof createAdminClient>,
  anilistIds: number[],
): Promise<Set<number>> {
  const known = new Set<number>()
  for (let index = 0; index < anilistIds.length; index += 100) {
    const chunk = anilistIds.slice(index, index + 100)
    const { data, error } = await supabase.from('anime').select('anilist_id').in('anilist_id', chunk)
    if (error) throw new Error(`Failed to read known anime: ${error.message}`)
    for (const row of data ?? []) known.add(row.anilist_id as number)
  }
  return known
}

/**
 * GET /api/discovery/seasonal
 *
 * Catalogue expansion: walks the current and previous season (or a ?year=
 * backfill, max 3 seasons per run, popular first) and queues episodes only for
 * anime Anivexa can actually play. Finished anime without providers are
 * ignored: no placeholders for them.
 *
 * Params: dry=1, pages, season, year.
 */
export async function GET(request: Request) {
  const unauthorized = authorizeCron(request)
  if (unauthorized) return unauthorized

  const startedAt = Date.now()
  const url = new URL(request.url)
  const dry = url.searchParams.get('dry') === '1'
  const pages = clamp(Number(url.searchParams.get('pages') ?? DEFAULT_PAGES), 1, MAX_PAGES)
  const yearParam = Number(url.searchParams.get('year'))
  const year = Number.isInteger(yearParam) && yearParam >= 1950 ? yearParam : null
  const seasonParam = url.searchParams.get('season')

  const targets = seasonalTargets(new Date(), { year, season: seasonParam, maxSeasons: MAX_SEASONS })

  const errors: string[] = []

  // Like /api/discovery/upcoming: a dry run should still exercise AniList and
  // Anivexa when the machine has no database credentials.
  let supabase: ReturnType<typeof createAdminClient> | null = null
  try {
    supabase = createAdminClient()
  } catch (error) {
    errors.push(`database unavailable: ${getErrorMessage(error)}`)
  }

  let pagesFetched = 0
  let mediaSeen = 0
  let rateLimited = 0
  let remaining: number | null = null
  let alreadyKnown = 0
  let skippedAdultOrNoCover = 0

  const candidates: NormalizedMedia[] = []
  const seenIds = new Set<number>()

  try {
    for (const target of targets) {
      for (let page = 1; page <= pages; page += 1) {
        if (Date.now() - startedAt >= UPCOMING_TIME_BUDGET_MS) break

        const result = await fetchAniListWithRetry(
          () => fetchSeasonalMedia(target.season, target.year, page, { perPage: PER_PAGE }),
          (payload) => parseAniListMediaPage(payload as AniListMediaPageResponse),
          { deadline: startedAt + UPCOMING_TIME_BUDGET_MS },
        )

        if (!result.ok) {
          if (result.rateLimited) rateLimited += 1
          errors.push(`${target.season} ${target.year} page ${page}: ${result.error}`)
          break
        }

        pagesFetched += 1
        mediaSeen += result.parsed.media.length
        remaining = getRemaining(result.headers) ?? remaining

        for (const media of result.parsed.media as AniListMedia[]) {
          const normalized = normalizeAniListMedia(media)
          if (!normalized) continue
          if (normalized.is_adult || !normalized.cover_url) {
            skippedAdultOrNoCover += 1
            continue
          }
          if (seenIds.has(normalized.anilist_id)) continue
          seenIds.add(normalized.anilist_id)
          candidates.push(normalized)
        }

        if (!result.parsed.hasNextPage) break
        if (shouldPauseBeforeNextPage(result.headers)) {
          const waitSeconds = getWaitSeconds(result.headers)
          if (Date.now() + waitSeconds * 1000 < startedAt + UPCOMING_TIME_BUDGET_MS) await sleep(waitSeconds)
          else break
        }
      }
    }
  } catch (error) {
    errors.push(getErrorMessage(error))
  }

  let queuedAnime = 0
  let pendingSyncInserted = 0
  let anivexaChecked = 0
  let noProviders = 0
  let anivexaErrors = 0
  let budgetExhausted = false
  const queuedSample: Array<{ anilistId: number; title: string; episodes: number[] }> = []

  try {
    const known = supabase
      ? await loadKnownAnime(
          supabase,
          candidates.map((item) => item.anilist_id),
        )
      : new Set<number>()
    alreadyKnown = candidates.filter((item) => known.has(item.anilist_id)).length

    const unknown = candidates.filter((item) => !known.has(item.anilist_id))
    const toCheck = unknown.slice(0, MAX_ANIVEXA_CHECKS)
    if (unknown.length > toCheck.length) budgetExhausted = true

    const entries: Array<{ anilist_id: number; episode_number: number }> = []
    let cursor = 0

    const worker = async () => {
      while (true) {
        const item = toCheck[cursor]
        cursor += 1
        if (!item) return
        if (Date.now() - startedAt >= UPCOMING_TIME_BUDGET_MS - START_GUARD_MS) {
          budgetExhausted = true
          return
        }

        anivexaChecked += 1
        try {
          const availability = await fetchAnivexaAvailability(item.anilist_id, ANIVEXA_TIMEOUT_MS)
          const first = availability.counts.size ? lowestPlayableEpisode(availability) : null
          if (first === null) {
            noProviders += 1
            continue
          }

          const numbers = episodesToQueue(
            availability.maxEpisode,
            item.next_airing_episode?.episode ?? null,
            EPISODES_PER_ANIME_CAP,
          )
            .filter((number) => availability.counts.has(number))
            .slice(0, EPISODES_PER_ANIME_CAP)

          const queue = numbers.length ? numbers : [first]
          for (const episode_number of queue) {
            entries.push({ anilist_id: item.anilist_id, episode_number })
          }
          queuedAnime += 1
          if (queuedSample.length < 20) {
            queuedSample.push({ anilistId: item.anilist_id, title: item.title, episodes: queue })
          }
        } catch (error) {
          anivexaErrors += 1
          errors.push(`anivexa ${item.anilist_id}: ${getErrorMessage(error)}`)
        }
      }
    }

    await Promise.all(Array.from({ length: ANIVEXA_CONCURRENCY }, worker))

    const deduped = [...new Map(entries.map((entry) => [`${entry.anilist_id}-${entry.episode_number}`, entry])).values()]
    if (!dry && supabase && deduped.length) {
      pendingSyncInserted = await insertPendingSyncWithSource(deduped, 'seasonal')
    } else if (dry) {
      pendingSyncInserted = 0
    }
  } catch (error) {
    errors.push(`database: ${getErrorMessage(error)}`)
  }

  return Response.json({
    dry,
    seasons: targets,
    pagesFetched,
    mediaSeen,
    candidates: candidates.length,
    alreadyKnown,
    skippedAdultOrNoCover,
    anivexaChecked,
    queuedAnime,
    pendingSyncInserted,
    queuedInDryRun: dry ? queuedAnime : undefined,
    noProviders,
    anivexaErrors,
    budgetExhausted,
    database: supabase ? 'ok' : 'unavailable',
    rateLimited,
    remaining,
    ms: Date.now() - startedAt,
    errors,
    queuedSample,
  })
}
