import { after } from 'next/server'
import {
  deduplicateEntries,
  findExistingPendingSyncEntries,
  getErrorMessage,
  insertPendingSync,
  jsonError,
} from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 240

const OTAKUNAIJA_BASE = process.env.OTAKUNAIJA_BASE_URL ?? 'https://otakunaija.name.ng'
const ANIVEXA_BASE = process.env.ANIVEXA_BASE_URL ?? 'https://anivexa.otakunaija.name.ng'

const DEFAULT_BATCH = 12
const MAX_BATCH = 25

// How many anime are checked in parallel. 4 is a safe default for Anivexa.
const CONCURRENCY = Number(process.env.EPISODE_CHECK_CONCURRENCY) || 4

// Per-request timeout for Anivexa. Must stay well under the run budgets below,
// because the worker start-gate uses this value to decide whether it can still
// fit one more anime inside the wall-clock budget.
const ANIVEXA_TIMEOUT_MS = Number(process.env.ANIVEXA_TIMEOUT_MS) || 45_000

type FeedItem = {
  series_id: number
  anilist_id: number
  title: string
  status: string
  episode_numbers: number[]
  latest_episode: number | null
  episode_count: number
}

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
  return base.replace(/\/+$/, '') + '/rest/v1/' + path
}

async function loadState(): Promise<Map<number, number>> {
  const res = await fetch(
    supabaseUrl('episode_check_state?select=anilist_id,last_checked_at&limit=5000'),
    { headers: supabaseHeaders(), cache: 'no-store' },
  )
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

// Episode number -> how many providers list it (sub and dub count once per provider).
async function fetchEpisodeNumbers(
  anilistId: number,
): Promise<{ counts: Map<number, number>; providersWithData: number }> {
  const res = await fetch(ANIVEXA_BASE + '/episodes/' + anilistId, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(ANIVEXA_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`anivexa HTTP ${res.status}`)
  const json = (await res.json()) as Record<string, any>

  const counts = new Map<number, number>()
  let providersWithData = 0
  for (const [key, val] of Object.entries(json)) {
    if (NON_PROVIDER_KEYS.has(key) || !val || typeof val !== 'object') continue
    const seen = new Set<number>()
    for (const list of [val.episodes?.sub, val.episodes?.dub]) {
      if (!Array.isArray(list)) continue
      for (const e of list) {
        const n = Number(e?.number)
        if (Number.isInteger(n) && n >= 1) seen.add(n)
      }
    }
    if (seen.size === 0) continue
    providersWithData += 1
    for (const n of seen) counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  return { counts, providersWithData }
}

// ---------- Runner ----------

async function runCheck(batch: number) {
  const started = Date.now()
  const [feed, state] = await Promise.all([fetchFeed(), loadState()])

  // Never-checked first, then oldest last_checked_at.
  const queue = [...feed].sort((a, b) => {
    const ta = state.get(a.anilist_id) ?? 0
    const tb = state.get(b.anilist_id) ?? 0
    return ta - tb || a.anilist_id - b.anilist_id
  })
  const picked = queue.slice(0, batch)
  const neverChecked = feed.filter((f) => !state.has(f.anilist_id)).length

  const entries: { anilist_id: number; episode_number: number }[] = []
  const checked: { anilistId: number; missingCount: number }[] = []
  const results: any[] = []
  let next = 0

  // Just fetches episode numbers, a few anime at a time.
  const worker = async () => {
    while (true) {
      const item = picked[next++]
      if (!item) return
      try {
        const have = new Set(item.episode_numbers)
        const { counts, providersWithData } = await fetchEpisodeNumbers(item.anilist_id)
        // 2+ providers answered = an episode needs 2 of them to list it.
        const minAgree = providersWithData >= 2 ? 2 : 1
        // Fill gaps and everything above, but never below the lowest episode OtakuNaija has.
        // No episodes yet = take everything.
        const lowerBound = have.size > 0 ? Math.min(...have) : 1
        const missing = [...counts]
          .filter(([n, c]) => c >= minAgree && n >= lowerBound && !have.has(n))
          .map(([n]) => n)
          .sort((a, b) => a - b)
        for (const episode_number of missing) {
          entries.push({ anilist_id: item.anilist_id, episode_number })
        }
        checked.push({ anilistId: item.anilist_id, missingCount: missing.length })
        results.push({
          anilistId: item.anilist_id,
          title: item.title,
          haveCount: item.episode_count,
          missingCount: missing.length,
          missingSample: missing.slice(0, 20),
        })
      } catch (e) {
        const message = getErrorMessage(e)
        await stamp(item.anilist_id, 0, message).catch(() => {})
        results.push({ anilistId: item.anilist_id, title: item.title, error: message })
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  // Insert once, same as discovery.
  const deduped = deduplicateEntries(entries)
  const existingKeys = await findExistingPendingSyncEntries(deduped)
  const inserted = await insertPendingSync(deduped)

  // Stamp only after the insert succeeded, so a failed insert is retried next run.
  await Promise.all(checked.map((c) => stamp(c.anilistId, c.missingCount, null).catch(() => {})))

  return {
    feedSize: feed.length,
    neverChecked,
    batchRequested: batch,
    checked: results.length,
    missingFound: deduped.length,
    alreadyKnown: deduped.filter((e) => existingKeys.has(e.anilist_id + '-' + e.episode_number)).length,
    pendingSyncInserted: inserted,
    tookMs: Date.now() - started,
    results,
  }
}

// ---------- Route ----------

export async function GET(request: Request) {
  const secret = process.env.EPISODE_CHECK_SECRET
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  const params = new URL(request.url).searchParams
  const batch = Math.min(Math.max(Number(params.get('batch')) || DEFAULT_BATCH, 1), MAX_BATCH)

  // Manual: run inside the request and return full results.
  if (params.get('wait') === '1') {
    try {
      return Response.json(await runCheck(batch))
    } catch (error) {
      return jsonError(getErrorMessage(error))
    }
  }

  // Cron: reply 202 right away, keep working in the background.
  after(async () => {
    try {
      const r = await runCheck(batch)
      const errors = r.results
        .filter((x: any) => x.error)
        .map((x: any) => ({ id: x.anilistId, title: x.title, error: x.error }))
      console.log(
        'episode-check',
        JSON.stringify({
          checked: r.checked,
          missingFound: r.missingFound,
          inserted: r.pendingSyncInserted,
          tookMs: r.tookMs,
          errorCount: errors.length,
          errors,
        }),
      )
    } catch (error) {
      console.error('episode-check failed', getErrorMessage(error))
    }
  })
  return Response.json({ accepted: true, batch, concurrency: CONCURRENCY }, { status: 202 })
}
