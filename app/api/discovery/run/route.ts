import {
  MAX_PAGES,
  MAX_RETRIES,
  deduplicateEntries,
  findExistingPendingSyncEntries,
  fetchAniListCatalogPage,
  fetchAniListPage,
  getAniListError,
  getCurrentUnixTime,
  getErrorMessage,
  getWaitSeconds,
  insertPendingSync,
  isOlderThanOneDay,
  jsonError,
  parseAniListCatalogResponse,
  parseAniListResponse,
  scheduleRetryAfter429,
  shouldPauseBeforeNextPage,
  sleep,
  toPendingSyncEntries,
  type AniListResponse,
} from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

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

async function fetchAniPmAiring() {
  const res = await fetch('https://ani.pm/api/anime/airing-week', {
    headers: {
      'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
      accept: 'application/json',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`ani.pm HTTP ${res.status} ${res.headers.get('cf-mitigated') ?? ''}`.trim())
  const { items = [] } = await res.json()
  return items
    .filter((i: any) => i.onSite)
    .map((i: any) => ({ anilist_id: Number(i.anilistId), episode_number: Number(i.episode) }))
    .filter((e: any) => e.anilist_id > 0 && e.episode_number > 0)
}

const SHIKIMORI_BASE = process.env.SHIKIMORI_BASE_URL ?? 'https://shikimori.io'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

type ShikimoriItem = {
  id: number | string
  episodes_aired?: number
  released_on?: string | null
  aired_on?: string | null
}

async function shikimoriList(query: string, pages: number): Promise<ShikimoriItem[]> {
  const out: ShikimoriItem[] = []
  for (let page = 1; page <= pages; page += 1) {
    try {
      const res = await fetch(`${SHIKIMORI_BASE}/api/animes?${query}&limit=50&page=${page}`, {
        headers: { 'user-agent': 'WisdomDiscovery/1.0', accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`shikimori HTTP ${res.status}`)
      const items = (await res.json()) as ShikimoriItem[]
      out.push(...items)
      if (items.length < 50) break
    } catch (e) {
      if (out.length === 0) throw e
      break // keep the pages we already got
    }
    await wait(400)
  }
  return out
}

async function resolveAniListIds(malIds: number[]) {
  const map = new Map<number, number>()
  for (let i = 0; i < malIds.length; i += 50) {
    const chunk = malIds.slice(i, i + 50)
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          query: 'query($ids:[Int]){Page(perPage:50){media(idMal_in:$ids,type:ANIME){id idMal}}}',
          variables: { ids: chunk },
        }),
        cache: 'no-store',
      })
      if (res.status === 429) {
        if (attempt === MAX_RETRIES) return map // return what we have so far
        await sleep(scheduleRetryAfter429(res.headers))
        continue
      }
      if (!res.ok) return map
      const json = await res.json()
      for (const m of json?.data?.Page?.media ?? []) if (m.idMal) map.set(m.idMal, m.id)
      break
    }
    await wait(300)
  }
  return map
}

async function fetchShikimoriDiscovery() {
  const now = Date.now()
  const cutoff = now - 30 * 86400_000
  const year = new Date().getUTCFullYear()
  const toMal = (id: number | string) => Number(String(id).replace(/\D/g, ''))
  const errors: string[] = []
  const safe = async (label: string, fn: () => Promise<ShikimoriItem[]>) => {
    try {
      return await fn()
    } catch (e) {
      errors.push(`${label}: ${getErrorMessage(e)}`)
      return [] as ShikimoriItem[]
    }
  }

  const ongoing = await safe('ongoing', () => shikimoriList('status=ongoing&order=popularity', 10))
  await wait(400)
  const anons = await safe('anons', () => shikimoriList('status=anons&order=popularity', 2))
  await wait(400)
  const releasedAll = await safe('released', () =>
    shikimoriList(`status=released&season=${year}&order=aired_on`, 3),
  )
  const inWindow = (d?: string | null) => {
    const t = d ? Date.parse(d) : NaN
    return t >= cutoff && t <= now
  }
  const released = releasedAll.filter((i) => inWindow(i.aired_on) || inWindow(i.released_on))

  const wanted: { mal: number; episode: number }[] = [
    ...ongoing.map((i) => ({ mal: toMal(i.id), episode: i.episodes_aired ?? 0 })),
    ...anons.map((i) => ({ mal: toMal(i.id), episode: 1 })),
    ...released.map((i) => ({ mal: toMal(i.id), episode: 1 })),
  ].filter((w) => w.mal > 0 && w.episode > 0)

  const idMap = await resolveAniListIds([...new Set(wanted.map((w) => w.mal))])
  return {
    seen: wanted.length,
    error: errors.length ? errors.join('; ') : null,
    entries: wanted
      .filter((w) => idMap.has(w.mal))
      .map((w) => ({ anilist_id: idMap.get(w.mal)!, episode_number: w.episode })),
  }
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

      if (!parsed.hasNextPage || page === MAX_PAGES) break
      if (shouldPauseBeforeNextPage(headers)) await sleep(getWaitSeconds(headers))
    }

    const catalogEntries = []
    let catalogPagesFetched = 0
    let catalogEntriesSeen = 0
    const catalogCutoff = now - 30 * 86400

    for (let page = 1; page <= 3; page += 1) {
      let response: Response
      let responseHeaders: Headers | null = null
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        response = await fetchAniListCatalogPage(page)
        if (response.status === 429) {
          if (attempt === MAX_RETRIES) throw new Error('AniList catalog rate limit retry exhausted')
          await sleep(scheduleRetryAfter429(response.headers))
          continue
        }
        if (!response.ok) throw new Error(getAniListError(response.status))
        responseHeaders = response.headers
        break
      }

      catalogPagesFetched += 1
      const catalog = parseAniListCatalogResponse(await response!.json())
      catalogEntriesSeen += catalog.media.length
      const recentMedia = catalog.media.filter((media) => {
        const { year, month, day } = media.startDate ?? {}
        if (!year || !month || !day) return false
        return Math.floor(Date.UTC(year, month - 1, day) / 1000) >= catalogCutoff
      })
      catalogEntries.push(...recentMedia.map((media) => ({ anilist_id: media.id, episode_number: 1 })))

      const pageIsOlderThanThirtyDays = catalog.media.length > 0 && catalog.media.every((media) => {
        const { year, month, day } = media.startDate ?? {}
        return !year || !month || !day || Math.floor(Date.UTC(year, month - 1, day) / 1000) < catalogCutoff
      })
      if (!catalog.hasNextPage || pageIsOlderThanThirtyDays || page === 3) break
      if (responseHeaders && shouldPauseBeforeNextPage(responseHeaders)) await sleep(getWaitSeconds(responseHeaders))
    }

    const catalogPendingSyncInserted = await insertPendingSync(deduplicateEntries(catalogEntries))
    const allEntries = toPendingSyncEntries(collected)
    let aniPmEntries: { anilist_id: number; episode_number: number }[] = []
    let aniPmError: string | null = null
    try {
      aniPmEntries = await fetchAniPmAiring()
    } catch (e) {
      aniPmError = getErrorMessage(e)
    }
    let shikimoriEntries: { anilist_id: number; episode_number: number }[] = []
    let shikimoriSeen = 0
    let shikimoriError: string | null = null
    try {
      const s = await fetchShikimoriDiscovery()
      shikimoriEntries = s.entries
      shikimoriSeen = s.seen
      shikimoriError = s.error
    } catch (e) {
      shikimoriError = getErrorMessage(e)
    }
    const entries = deduplicateEntries([...allEntries, ...aniPmEntries, ...shikimoriEntries])
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
      catalogPagesFetched,
      catalogEntriesSeen,
      catalogPendingSyncInserted,
      anipmEntriesSeen: aniPmEntries.length,
      anipmError: aniPmError,
      shikimoriSeen,
      shikimoriMapped: shikimoriEntries.length,
      shikimoriError,
      shikimoriAlreadyKnown: shikimoriEntries.filter((e) => existingKeys.has(`${e.anilist_id}-${e.episode_number}`)).length,
      entriesAlreadyKnown: entries.filter((e) => existingKeys.has(`${e.anilist_id}-${e.episode_number}`)).length,
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
