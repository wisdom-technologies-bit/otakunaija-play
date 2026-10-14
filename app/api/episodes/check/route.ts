import {
  deduplicateEntries,
  findExistingPendingSyncEntries,
  getErrorMessage,
  insertPendingSync,
  jsonError,
} from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const OTAKUNAIJA_BASE = process.env.OTAKUNAIJA_BASE_URL ?? 'https://otakunaija.name.ng'
const ANIVEXA_BASE = process.env.ANIVEXA_BASE_URL ?? 'https://anivexa.otakunaija.name.ng'
const DEFAULT_BATCH = 8
const MAX_BATCH = 25
const CONCURRENCY = 3
const DEADLINE_MS = 120_000 // stop starting new anime after this (cron-job.org cuts responses at 30s)
const MAX_FILL_WHEN_HAS_EPISODES = 100
// Optional: comma-separated provider slugs, e.g. "mkissa,anikoto,animegg,aniwaves,senshi,anipm".
// When set, only those providers are queried (much faster than asking all 12).
const ANIVEXA_PROVIDERS = (process.env.ANIVEXA_PROVIDERS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const ANIVEXA_TIMEOUT_MS = Number(process.env.ANIVEXA_TIMEOUT_MS) || 15_000

type FeedItem = {
  series_id: number
  anilist_id: number
  title: string
  status: string
  episode_numbers: number[]
  latest_episode: number | null
  episode_count: number
}

type Found = { count: number; airDate: string | null }

// ---------- OtakuNaija feed ----------

async function fetchFeed(): Promise<FeedItem[]> {
  const key = process.env.OTAKUNAIJA_PLAY_API_KEY
  if (!key) throw new Error('OTAKUNAIJA_PLAY_API_KEY is not set')
  const items: FeedItem[] = []
  let cursor: number | null = null
  for (let guard = 0; guard < 20; guard += 1) {
    const url = new URL('/api/play/airing-feed', OTAKUNAIJA_BASE)
    url.searchParams.set('limit', '500')
    if (cursor !== null) url.searchParams.set('cursor', String(cursor))
    const res = await fetch(url, {
      headers: { 'x-play-api-key': key, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`airing-feed HTTP ${res.status}`)
    const body = (await res.json()) as { items?: FeedItem[]; next_cursor?: number | null }
    items.push(...(body.items ?? []))
    if (body.next_cursor == null) break
    cursor = body.next_cursor
  }
  return items
}

// ---------- Rotation state (Supabase REST, no SDK dependency) ----------

function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
  return { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }
}

function supabaseUrl(path: string) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  if (!base) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  return `${base}/rest/v1/${path}`
}

async function loadState(): Promise<Map<number, number>> {
  const res = await fetch(supabaseUrl('episode_check_state?select=anilist_id,last_checked_at&limit=5000'), {
    headers: supabaseHeaders(),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`state read HTTP ${res.status}`)
  const rows = (await res.json()) as { anilist_id: number; last_checked_at: string }[]
  return new Map(rows.map((r) => [r.anilist_id, Date.parse(r.last_checked_at)]))
}

async function stamp(anilistId: number, lastMissing: number, lastError: string | null) {
  const res = await fetch(supabaseUrl('episode_check_state?on_conflict=anilist_id'), {
    method: 'POST',
    headers: { ...supabaseHeaders(), prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([
      {
        anilist_id: anilistId,
        last_checked_at: new Date().toISOString(),
        last_missing: lastMissing,
        last_error: lastError,
      },
    ]),
  })
  if (!res.ok) throw new Error(`state write HTTP ${res.status}`)
}

// ---------- Anivexa ----------

const NON_PROVIDER_KEYS = new Set(['mappings', 'page', 'type'])

async function fetchAnivexaEpisodes(anilistId: number) {
  const path = ANIVEXA_PROVIDERS.length
    ? `/episodes/${ANIVEXA_PROVIDERS.join('/')}/${anilistId}?map=false`
    : `/episodes/${anilistId}`
  const res = await fetch(`${ANIVEXA_BASE}${path}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(ANIVEXA_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`anivexa HTTP ${res.status}`)
  const json = (await res.json()) as Record<string, any>

  const found = new Map<number, Found>()
  let providersWithData = 0

  for (const [key, val] of Object.entries(json)) {
    if (NON_PROVIDER_KEYS.has(key) || !val || typeof val !== 'object') continue
    const eps = val.episodes
    if (!eps || typeof eps !== 'object') continue // provider returned { error }

    const seenByProvider = new Map<number, string | null>()
    for (const list of [eps.sub, eps.dub]) {
      if (!Array.isArray(list)) continue
      for (const e of list) {
        const n = Number(e?.number)
        // OtakuNaija stores integer episode numbers; skip 0 and fractional (13.5) entries
        if (!Number.isInteger(n) || n < 1) continue
        if (!seenByProvider.has(n) || !seenByProvider.get(n)) seenByProvider.set(n, e?.airDate ?? null)
      }
    }
    if (seenByProvider.size === 0) continue
    providersWithData += 1
    for (const [n, airDate] of seenByProvider) {
      const prev = found.get(n)
      found.set(n, {
        count: (prev?.count ?? 0) + 1,
        airDate: prev?.airDate ?? airDate,
      })
    }
  }
  return { found, providersWithData }
}

// ---------- Per-anime check ----------

async function checkOne(item: FeedItem, quorumOverride: number | null) {
  const have = new Set(item.episode_numbers)
  const { found, providersWithData } = await fetchAnivexaEpisodes(item.anilist_id)

  // Providers sometimes match the wrong season or use absolute numbering, so when
  // 2+ providers answered we require 2 of them to agree on an episode number.
  const minAgree = quorumOverride ?? (providersWithData >= 2 ? 2 : 1)
  const tomorrow = Date.now() + 86_400_000

  // Never backfill history below what OtakuNaija already has (e.g. Detective Conan
  // starting at 1214 must not pull 1..1213). We only fill gaps between the lowest and
  // highest episode we have, plus everything above. With zero episodes, take all.
  const lowerBound = have.size > 0 ? Math.min(...have) : 1

  const missing: number[] = []
  for (const [n, f] of found) {
    if (have.has(n)) continue
    if (n < lowerBound) continue
    if (f.count < minAgree) continue
    const t = f.airDate ? Date.parse(f.airDate) : NaN
    if (Number.isFinite(t) && t > tomorrow) continue // not aired yet
    missing.push(n)
  }
  missing.sort((a, b) => a - b)

  // Safety valve: an anime that already has episodes should never need a huge fill.
  // If it does, the remainder is picked up on its next turn in the rotation.
  const toInsert = have.size > 0 ? missing.slice(0, MAX_FILL_WHEN_HAS_EPISODES) : missing
  const entries = toInsert.map((episode_number) => ({ anilist_id: item.anilist_id, episode_number }))
  let inserted = 0
  let alreadyKnown = 0
  if (entries.length) {
    const deduped = deduplicateEntries(entries)
    const existing = await findExistingPendingSyncEntries(deduped)
    alreadyKnown = deduped.filter((e) => existing.has(`${e.anilist_id}-${e.episode_number}`)).length
    inserted = await insertPendingSync(deduped)
  }
  return { missing, providersWithData, minAgree, inserted, alreadyKnown }
}

// ---------- Route ----------

export async function GET(request: Request) {
  const secret = process.env.EPISODE_CHECK_SECRET
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  const started = Date.now()
  const params = new URL(request.url).searchParams
  const batch = Math.min(Math.max(Number(params.get('batch')) || DEFAULT_BATCH, 1), MAX_BATCH)
  const quorumParam = Number(params.get('quorum'))
  const quorumOverride = quorumParam >= 1 ? quorumParam : null

  try {
    const [feed, state] = await Promise.all([fetchFeed(), loadState()])

    // Never-checked first (no state row), then oldest last_checked_at.
    // This guarantees every anime is checked once before any is checked twice.
    const queue = [...feed].sort((a, b) => {
      const ta = state.get(a.anilist_id) ?? 0
      const tb = state.get(b.anilist_id) ?? 0
      return ta - tb || a.anilist_id - b.anilist_id
    })
    const picked = queue.slice(0, batch)
    const neverChecked = feed.filter((f) => !state.has(f.anilist_id)).length

    const results: any[] = []
    let totalInserted = 0
    let stoppedByBudget = false
    let next = 0

    const worker = async () => {
      while (true) {
        if (Date.now() - started > DEADLINE_MS) {
          stoppedByBudget = true
          return
        }
        const item = picked[next++]
        if (!item) return
        try {
          const r = await checkOne(item, quorumOverride)
          totalInserted += r.inserted
          await stamp(item.anilist_id, r.missing.length, null)
          results.push({
            anilistId: item.anilist_id,
            title: item.title,
            haveLatest: item.latest_episode,
            haveCount: item.episode_count,
            missingCount: r.missing.length,
            missingSample: r.missing.slice(0, 20),
            providersWithData: r.providersWithData,
            minAgree: r.minAgree,
            inserted: r.inserted,
            alreadyKnown: r.alreadyKnown,
          })
        } catch (e) {
          const message = getErrorMessage(e)
          // Stamp anyway so one broken anime can't block the rotation; it is retried next loop.
          await stamp(item.anilist_id, 0, message).catch(() => {})
          results.push({ anilistId: item.anilist_id, title: item.title, error: message })
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))

    return Response.json({
      feedSize: feed.length,
      neverChecked,
      batchRequested: batch,
      checked: results.length,
      pendingSyncInserted: totalInserted,
      stoppedByBudget,
      tookMs: Date.now() - started,
      results,
    })
  } catch (error) {
    return jsonError(getErrorMessage(error))
  }
}
