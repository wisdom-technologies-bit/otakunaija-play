import { createClient } from '@supabase/supabase-js'

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

export async function fetchAniListPage(page: number, now: number) {
  const response = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: `query ($page: Int, $perPage: Int, $airingAtLesser: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    airingSchedules(sort: TIME_DESC, airingAt_lesser: $airingAtLesser) {
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
