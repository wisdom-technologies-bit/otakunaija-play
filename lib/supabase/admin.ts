import { createClient } from '@supabase/supabase-js'
import type { AniListMedia } from '@/lib/upcoming'

export function createAdminClient() {
  const url = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceRoleKey) {
    throw new Error('Supabase server credentials are not configured')
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

export type PendingSyncEntry = {
  anilist_id: number
  episode_number: number
}

export type AnimeSchedule = {
  episode: number
  airingAt: number
  media: {
    id: number
  }
}

export type AniListResponse = {
  data?: {
    Page?: {
      pageInfo?: { hasNextPage?: boolean }
      airingSchedules?: AnimeSchedule[]
    }
  }
  errors?: Array<{ message?: string }>
}

export type CatalogMedia = {
  id: number
  idMal?: number | null
  format?: string | null
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null
  title?: { romaji?: string | null } | null
}

export type AniListCatalogResponse = {
  data?: {
    Page?: {
      pageInfo?: { hasNextPage?: boolean }
      media?: CatalogMedia[]
    }
  }
  errors?: Array<{ message?: string }>
}

export async function insertPendingSync(entries: PendingSyncEntry[]) {
  if (entries.length === 0) return 0

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('pending_sync')
    .upsert(entries, {
      onConflict: 'anilist_id,episode_number',
      ignoreDuplicates: true,
    })
    .select('anilist_id, episode_number')

  if (error) throw new Error(`Failed to insert pending sync rows: ${error.message}`)
  return data?.length ?? 0
}

export async function findExistingPendingSyncEntries(entries: PendingSyncEntry[]) {
  if (entries.length === 0) return new Set<string>()

  const supabase = createAdminClient()
  const anilistIds = Array.from(new Set(entries.map((entry) => entry.anilist_id)))
  const { data, error } = await supabase
    .from('pending_sync')
    .select('anilist_id, episode_number')
    .in('anilist_id', anilistIds)

  if (error) throw new Error(`Failed to inspect pending sync rows: ${error.message}`)

  return new Set(
    (data ?? []).map((entry) => `${entry.anilist_id}-${entry.episode_number}`),
  )
}

export function pendingSyncKey(entry: PendingSyncEntry) {
  return `${entry.anilist_id}-${entry.episode_number}`
}

export async function fetchAniListCatalogPage(page: number) {
  return fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(sort: START_DATE_DESC, type: ANIME) {
      id
      idMal
      format
      startDate { year month day }
      title { romaji }
    }
  }
}`,
      variables: { page, perPage: 50 },
    }),
    cache: 'no-store',
  })
}

export function parseAniListCatalogResponse(payload: AniListCatalogResponse) {
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message ?? 'AniList error').join('; '))
  }

  return {
    hasNextPage: payload.data?.Page?.pageInfo?.hasNextPage ?? false,
    media: payload.data?.Page?.media ?? [],
  }
}

export async function fetchAniListPage(page: number, now: number) {
  const response = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: `query (
  $page: Int
  $perPage: Int
  $airingAtGreater: Int
  $airingAtLesser: Int
) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    airingSchedules(
      sort: TIME_DESC
      airingAt_greater: $airingAtGreater
      airingAt_lesser: $airingAtLesser
    ) {
      episode
      airingAt
      media {
        id
        idMal
        title { romaji english }
        format
        status
      }
    }
  }
}`,
      variables: {
        page,
        perPage: 50,
        airingAtGreater: now - 172800,
        airingAtLesser: now,
      },
    }),
    cache: 'no-store',
  })

  return response
}

export function getWaitSeconds(headers: Headers) {
  const retryAfter = Number(headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter

  const reset = Number(headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) {
    const resetInSeconds = reset > 1_000_000_000 ? reset - Math.floor(Date.now() / 1000) : reset
    if (resetInSeconds > 0) return resetInSeconds
  }

  return 60
}

export function sleep(seconds: number) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

export function isOlderThanOneDay(schedule: AnimeSchedule, now: number) {
  return schedule.airingAt <= now - 86400
}

export function jsonError(message: string, status = 500) {
  return Response.json({ error: message }, { status })
}

export function parseAniListResponse(payload: AniListResponse) {
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message ?? 'AniList error').join('; '))
  }

  return {
    hasNextPage: payload.data?.Page?.pageInfo?.hasNextPage ?? false,
    schedules: payload.data?.Page?.airingSchedules ?? [],
  }
}

export function toPendingSyncEntries(schedules: AnimeSchedule[]) {
  return schedules.map((schedule) => ({
    anilist_id: schedule.media.id,
    episode_number: schedule.episode,
  }))
}

export function deduplicateEntries(entries: PendingSyncEntry[]) {
  return Array.from(
    new Map(entries.map((entry) => [`${entry.anilist_id}-${entry.episode_number}`, entry])).values(),
  )
}

export function getRemaining(headers: Headers) {
  const remaining = Number(headers.get('x-ratelimit-remaining'))
  return Number.isFinite(remaining) ? remaining : null
}

export function getAniListError(status: number) {
  return `AniList request failed with HTTP ${status}`
}

export function scheduleRetryAfter429(headers: Headers) {
  return getWaitSeconds(headers)
}

export function shouldPauseBeforeNextPage(headers: Headers) {
  const remaining = getRemaining(headers)
  return remaining !== null && remaining <= 2
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Discovery run failed'
}

export function getCurrentUnixTime() {
  return Math.floor(Date.now() / 1000)
}

export const MAX_PAGES = 5
export const MAX_RETRIES = 1

// ---------------------------------------------------------------------------
// Upcoming / seasonal discovery (PROMPT PLAY-1)
// ---------------------------------------------------------------------------

/**
 * Fields shared by every upcoming/seasonal query. AniList rejects unknown
 * fields, so this string is kept in step with the NormalizedMedia columns in
 * lib/upcoming.ts.
 */
export const ANILIST_MEDIA_FIELDS = `
      id
      idMal
      title { romaji english }
      coverImage { extraLarge large }
      bannerImage
      startDate { year month day }
      season
      seasonYear
      format
      status
      episodes
      duration
      genres
      studios(isMain: true) { nodes { name } }
      description(asHtml: false)
      popularity
      trailer { id site }
      source
      nextAiringEpisode { airingAt episode }
      isAdult`

export type AniListMediaPageResponse = {
  data?: {
    Page?: {
      pageInfo?: { hasNextPage?: boolean; total?: number }
      media?: AniListMedia[]
    }
  }
  errors?: Array<{ message?: string }>
}

export type AniListMediaResponse = {
  data?: { Media?: AniListMedia | null }
  errors?: Array<{ message?: string }>
}

const ANILIST_ENDPOINT = 'https://graphql.anilist.co'

function anilistPost(query: string, variables: Record<string, unknown>) {
  return fetch(ANILIST_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
  })
}

export type UpcomingSort = 'START_DATE' | 'POPULARITY_DESC'

/** page of `status: NOT_YET_RELEASED` anime, earliest start date (or most popular) first. */
export function fetchUpcomingMedia(
  page: number,
  options: { perPage?: number; sort?: UpcomingSort } = {},
) {
  const perPage = Math.min(Math.max(options.perPage ?? 50, 1), 50)
  const sort =
    options.sort === 'POPULARITY_DESC'
      ? ['POPULARITY_DESC', 'START_DATE']
      : ['START_DATE', 'POPULARITY_DESC']

  return anilistPost(
    `query ($page: Int, $perPage: Int, $sort: [MediaSort]) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage total }
    media(
      type: ANIME
      status: NOT_YET_RELEASED
      isAdult: false
      sort: $sort
      format_in: [TV, TV_SHORT, MOVIE, ONA, OVA, SPECIAL]
    ) {
      ${ANILIST_MEDIA_FIELDS}
    }
  }
}`,
    { page, perPage, sort },
  )
}

/** page of one season's anime, most popular first. */
export function fetchSeasonalMedia(
  season: string,
  year: number,
  page: number,
  options: { perPage?: number } = {},
) {
  const perPage = Math.min(Math.max(options.perPage ?? 50, 1), 50)

  return anilistPost(
    `query ($page: Int, $perPage: Int, $season: MediaSeason, $year: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage total }
    media(
      type: ANIME
      season: $season
      seasonYear: $year
      isAdult: false
      sort: [POPULARITY_DESC, SCORE_DESC]
      format_in: [TV, TV_SHORT, MOVIE, ONA, OVA, SPECIAL]
    ) {
      ${ANILIST_MEDIA_FIELDS}
    }
  }
}`,
    { page, perPage, season, year },
  )
}

/** one media by AniList id (manual import). */
export function fetchAniListMedia(id: number) {
  return anilistPost(
    `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    ${ANILIST_MEDIA_FIELDS}
  }
}`,
    { id },
  )
}

export function parseAniListMediaPage(payload: AniListMediaPageResponse) {
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message ?? 'AniList error').join('; '))
  }

  return {
    hasNextPage: payload.data?.Page?.pageInfo?.hasNextPage ?? false,
    total: payload.data?.Page?.pageInfo?.total ?? null,
    media: payload.data?.Page?.media ?? [],
  }
}

export function parseAniListMedia(payload: AniListMediaResponse) {
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message ?? 'AniList error').join('; '))
  }
  return payload.data?.Media ?? null
}

export type AniListFetchResult<T> =
  | { ok: true; parsed: T; headers: Headers; rateLimited: boolean }
  | { ok: false; error: string; rateLimited: boolean; status?: number }

/**
 * AniList GET with the repo's existing 429 handling: honour Retry-After, retry
 * MAX_RETRIES times, and give up (returning an error instead of throwing) when
 * the next wait would overrun the caller's deadline. Routes never throw out of
 * a GET as a result.
 */
export async function fetchAniListWithRetry<T>(
  request: () => Promise<Response>,
  parse: (payload: unknown) => T,
  options: { deadline?: number; maxRetries?: number } = {},
): Promise<AniListFetchResult<T>> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  const deadline = options.deadline ?? Date.now() + 45_000
  let rateLimited = false

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response: Response
    try {
      response = await request()
    } catch (error) {
      return { ok: false, error: getErrorMessage(error), rateLimited }
    }

    if (response.status === 429) {
      rateLimited = true
      if (attempt === maxRetries) {
        return { ok: false, error: 'AniList rate limit retry exhausted', rateLimited, status: 429 }
      }
      const waitSeconds = getWaitSeconds(response.headers)
      if (Date.now() + waitSeconds * 1000 > deadline) {
        return { ok: false, error: 'AniList rate limited, time budget exhausted', rateLimited, status: 429 }
      }
      await sleep(waitSeconds)
      continue
    }

    if (!response.ok) {
      return { ok: false, error: getAniListError(response.status), rateLimited, status: response.status }
    }

    try {
      const payload = (await response.json()) as unknown
      return { ok: true, parsed: parse(payload), headers: response.headers, rateLimited }
    } catch (error) {
      return { ok: false, error: getErrorMessage(error), rateLimited, status: response.status }
    }
  }

  return { ok: false, error: 'AniList request failed', rateLimited }
}

// ---------------------------------------------------------------------------
// discovery_state cursors
// ---------------------------------------------------------------------------

export async function readDiscoveryState(key: string): Promise<Record<string, unknown> | null> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('discovery_state')
    .select('value')
    .eq('key', key)
    .maybeSingle()

  if (error) throw new Error(`Failed to read discovery state: ${error.message}`)
  const value = (data?.value ?? null) as Record<string, unknown> | null
  return value ?? null
}

export async function writeDiscoveryState(key: string, value: Record<string, unknown>) {
  const supabase = createAdminClient()
  const { error } = await supabase
    .from('discovery_state')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })

  if (error) throw new Error(`Failed to write discovery state: ${error.message}`)
}

/** Paging cursor helper: returns a positive page number, defaulting to 1. */
export function readCursorPage(state: Record<string, unknown> | null): number {
  const page = Number(state?.next_page)
  return Number.isInteger(page) && page > 0 ? page : 1
}

export const UPCOMING_DEFAULT_MIN_POPULARITY = 2000
export const UPCOMING_WINDOW_MONTHS = 9
export const UPCOMING_TIME_BUDGET_MS = 45_000
export const UPCOMING_EXPORT_TIME_BUDGET_MS = 50_000

/** Like insertPendingSync, but records which sweep queued the row. */
export async function insertPendingSyncWithSource(
  entries: PendingSyncEntry[],
  discoverySource: string,
) {
  if (entries.length === 0) return 0

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('pending_sync')
    .upsert(
      entries.map((entry) => ({ ...entry, discovery_source: discoverySource })),
      { onConflict: 'anilist_id,episode_number', ignoreDuplicates: true },
    )
    .select('anilist_id, episode_number')

  if (error) throw new Error(`Failed to insert pending sync rows: ${error.message}`)
  return data?.length ?? 0
}
