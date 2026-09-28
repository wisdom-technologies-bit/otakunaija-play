import {
  MAX_PAGES,
  MAX_RETRIES,
  deduplicateEntries,
  fetchAniListPage,
  getAniListError,
  getCurrentUnixTime,
  getErrorMessage,
  getWaitSeconds,
  insertPendingSync,
  isOlderThanOneDay,
  jsonError,
  parseAniListResponse,
  scheduleRetryAfter429,
  shouldPauseBeforeNextPage,
  sleep,
  toPendingSyncEntries,
  type AniListResponse,
} from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function fetchPageWithRetry(page: number, now: number) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetchAniListPage(page, now)

    if (response.status === 429) {
      if (attempt === MAX_RETRIES) throw new Error('AniList rate limit retry exhausted')
      await sleep(scheduleRetryAfter429(response.headers))
      continue
    }

    if (!response.ok) throw new Error(getAniListError(response.status))

    const payload = (await response.json()) as AniListResponse
    return { parsed: parseAniListResponse(payload), headers: response.headers }
  }

  throw new Error('Unable to fetch AniList page')
}

export async function GET() {
  const now = getCurrentUnixTime()
  const collected = []
  let pagesFetched = 0

  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { parsed, headers } = await fetchPageWithRetry(page, now)
      pagesFetched += 1
      collected.push(...parsed.schedules)

      const pageIsOlderThanOneDay =
        parsed.schedules.length > 0 && parsed.schedules.every((schedule) => isOlderThanOneDay(schedule, now))

      if (!parsed.hasNextPage || pageIsOlderThanOneDay || page === MAX_PAGES) break
      if (shouldPauseBeforeNextPage(headers)) await sleep(getWaitSeconds(headers))
    }

    const entries = deduplicateEntries(toPendingSyncEntries(collected))
    const inserted = await insertPendingSync(entries)

    return Response.json({
      pagesFetched,
      airingSchedulesSeen: collected.length,
      pendingSyncInserted: inserted,
    })
  } catch (error) {
    return jsonError(getErrorMessage(error))
  }
}
