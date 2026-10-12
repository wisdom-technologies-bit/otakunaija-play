import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 90

const ANIVEXA_BASE_URL = 'https://anivexa.otakunaija.name.ng'
const REQUEST_TIMEOUT_MS = 20_000
const BATCH_SIZE = 15
const START_BUDGET_MS = 45_000
const ALLOWED_FORMATS = new Set(['MOVIE', 'OVA', 'SPECIAL'])

type Mapping = { anilistId?: number | null; type?: string | null; format?: string | null }
type Payload = { mappings?: { franchise?: Mapping[] | null } | null }
type Anime = { anilist_id: number }

async function fetchMapping(anilistId: number) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${ANIVEXA_BASE_URL}/map/${anilistId}`, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) throw new Error(`Anivexa HTTP ${response.status}`)
    return await response.json() as Payload
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Anivexa request timed out')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function GET(request: Request) {
  const startedAt = Date.now()
  const url = new URL(request.url)
  const chainDepth = Math.max(0, Number.parseInt(url.searchParams.get('chainDepth') ?? '0', 10) || 0)
  const supabase = createAdminClient()
  const { data: selected, error } = await supabase
    .from('anime')
    .select('anilist_id')
    .is('franchise_checked_at', null)
    .order('anilist_id', { ascending: true })
    .limit(BATCH_SIZE)

  if (error) return Response.json({ error: error.message }, { status: 500 })
  if (!selected?.length) return Response.json({ animeChecked: 0, chainDepth, message: 'nothing to check' })

  let animeChecked = 0
  let animeFailed = 0
  let franchiseEntriesFound = 0
  let pendingSyncInserted = 0
  let animeSkippedByBudget = 0

  for (let index = 0; index < selected.length; index += 1) {
    if (Date.now() - startedAt >= START_BUDGET_MS) {
      animeSkippedByBudget = selected.length - index
      break
    }
    const anime = selected[index] as Anime
    try {
      const payload = await fetchMapping(anime.anilist_id)
      const matches = (payload.mappings?.franchise ?? []).filter((entry) =>
        entry.type === 'ANIME' && typeof entry.anilistId === 'number' && ALLOWED_FORMATS.has((entry.format ?? '').toUpperCase()),
      )
      franchiseEntriesFound += matches.length
      if (matches.length) {
        const entries = matches.map((entry) => ({ anilist_id: entry.anilistId as number, episode_number: 1, status: 'pending' }))
        const { data, error: insertError } = await supabase
          .from('pending_sync')
          .upsert(entries, { onConflict: 'anilist_id,episode_number', ignoreDuplicates: true })
          .select('anilist_id, episode_number')
        if (insertError) throw insertError
        pendingSyncInserted += data?.length ?? 0
      }
      const { error: markError } = await supabase.from('anime').update({ franchise_checked_at: new Date().toISOString() }).eq('anilist_id', anime.anilist_id)
      if (markError) throw markError
      animeChecked += 1
    } catch (error) {
      animeFailed += 1
      console.error('[franchise-discovery] anime failed', anime.anilist_id, error)
    }
  }

  if (animeSkippedByBudget > 0 && chainDepth < 5) {
    void fetch(`${url.origin}/api/franchise-discovery/run?chainDepth=${chainDepth + 1}`, { method: 'GET' }).catch((error) => {
      console.error('[franchise-discovery] chained invocation failed', error)
    })
  }

  return Response.json({
    animeSelected: selected.length,
    animeChecked,
    animeFailed,
    franchiseEntriesFound,
    pendingSyncInserted,
    animeSkippedByBudget,
    chainDepth,
  })
}

export async function OPTIONS() {
  return new Response(null, { status: 204 })
}
