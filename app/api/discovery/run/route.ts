import {
  MAX_PAGES,
  MAX_RETRIES,
  deduplicateEntries,
  findExistingPendingSyncEntries,
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

    const allEntries = toPendingSyncEntries(collected)
    const entries = deduplicateEntries(allEntries)
    const existingKeys = await findExistingPendingSyncEntries(entries)
    const deduplicatedKeys = new Set<string>()
    const seenKeys = new Set<string>()

    for (const entry of allEntries) {
      const key = `${entry.anilist_id}-${entry.episode_number}`
      if (seenKeys.has(key)) deduplicatedKeys.add(key)
      seenKeys.add(key)
    }

    const diagnostics = collected.map((schedule, index) => {
      const entry = allEntries[index]
      const hasValidAnimeData = Number.isInteger(entry?.anilist_id) && entry.anilist_id > 0
      const hasValidEpisodeData = Number.isInteger(entry?.episode_number) && entry.episode_number > 0
      const key = entry ? `${entry.anilist_id}-${entry.episode_number}` : null
      const reasons: string[] = []

      if (!hasValidAnimeData || !hasValidEpisodeData) reasons.push('invalid_required_data')
      if (key && existingKeys.has(key)) reasons.push('already_known')
      if (key && deduplicatedKeys.has(key)) reasons.push('deduplicated')

      return {
        anilistId: schedule.media?.id ?? null,
        episode: schedule.episode ?? null,
        airingAt: schedule.airingAt ?? null,
        reasons,
        convertedToPendingSync: Boolean(entry),
      }
    })

    const inserted = await insertPendingSync(entries)
    const diagnosticCounts = {
      alreadyKnown: diagnostics.filter((item) => item.reasons.includes('already_known')).length,
      rejectedByAgeWindow: 0,
      invalidRequiredData: diagnostics.filter((item) => item.reasons.includes('invalid_required_data')).length,
      deduplicated: diagnostics.filter((item) => item.reasons.includes('deduplicated')).length,
      convertedToPendingSync: entries.length,
      successfullyInserted: inserted,
    }

    return Response.json({
      pagesFetched,
      airingSchedulesSeen: collected.length,
      pendingSyncInserted: inserted,
      diagnostics: {
        counts: diagnosticCounts,
        schedules: diagnostics,
        note: 'The 48-hour boundary is applied by AniList query variables; the existing one-day check only stops pagination and does not reject schedules.',
      },
    })
  } catch (error) {
    return jsonError(getErrorMessage(error))
  }
}
