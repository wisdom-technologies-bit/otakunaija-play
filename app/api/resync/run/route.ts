import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 90

const ANIVEXA_BASE_URL = 'https://anivexa-app.vercel.app'
const ANIVEXA_TIMEOUT_MS = 40_000
const BATCH_SIZE = 30
const START_BUDGET_MS = 45_000
const PROVIDERS = [
  'mkissa', 'reanime', 'anikoto', 'animegg', 'animenosub', 'anizone',
  'aniwaves', 'senshi', 'kaa', 'animedunya', 'animeonsen', 'anipm', 'anibd',
] as const

type ProviderEpisode = { id?: string; number?: number }
type Provider = { error?: string; episodes?: { sub?: ProviderEpisode[]; dub?: ProviderEpisode[] } }
type Payload = { [key: string]: unknown }
type Episode = { play_id: string; episode_number: number }
type Candidate = { anilist_id: number; failed: boolean; priorityAt: string | null }

async function fetchAnivexa(anilistId: number) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ANIVEXA_TIMEOUT_MS)
  try {
    const response = await fetch(`${ANIVEXA_BASE_URL}/episodes/${anilistId}`, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) throw new Error(`Anivexa HTTP ${response.status}`)
    return await response.json() as Payload
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Anivexa request timed out')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function providerEpisode(provider: Provider | undefined, number: number, audio: 'sub' | 'dub') {
  if (!provider || provider.error) return null
  return provider.episodes?.[audio]?.find((entry) => entry.number === number) ?? null
}

function buildProviders(payload: Payload, episodeNumber: number) {
  const subProviders: Array<{ provider: string; episodeId: string }> = []
  const dubProviders: Array<{ provider: string; episodeId: string }> = []
  for (const providerName of PROVIDERS) {
    const provider = payload[providerName] as Provider | undefined
    const sub = providerEpisode(provider, episodeNumber, 'sub')
    const dub = providerEpisode(provider, episodeNumber, 'dub')
    if (sub?.id) subProviders.push({ provider: providerName, episodeId: sub.id })
    if (dub?.id) dubProviders.push({ provider: providerName, episodeId: dub.id })
  }
  return { sub_providers: subProviders, dub_providers: dubProviders }
}

export async function GET(request: Request) {
  const startedAt = Date.now()
  const supabase = createAdminClient()
  const { data: failedRows, error: failedError } = await supabase
    .from('episodes')
    .select('anilist_id, resync_requested_at')
    .eq('needs_resync', true)
    .order('resync_requested_at', { ascending: true, nullsFirst: true })
  if (failedError) return Response.json({ error: failedError.message }, { status: 500 })

  const failedCandidates: Candidate[] = []
  const failedSeen = new Set<number>()
  for (const row of failedRows ?? []) {
    if (typeof row.anilist_id === 'number' && !failedSeen.has(row.anilist_id)) {
      failedSeen.add(row.anilist_id)
      failedCandidates.push({ anilist_id: row.anilist_id, failed: true, priorityAt: row.resync_requested_at })
    }
  }

  const dubOnlyCandidates: Candidate[] = []
  const { data: dubOnlyRows, error: dubOnlyError } = await supabase
    .from('episodes')
    .select('anilist_id, dub_providers, sub_providers')
  if (dubOnlyError) return Response.json({ error: dubOnlyError.message }, { status: 500 })

  const dubOnlyIds = Array.from(new Set((dubOnlyRows ?? [])
    .filter((row) => Array.isArray(row.dub_providers) && row.dub_providers.length > 0 && Array.isArray(row.sub_providers) && row.sub_providers.length === 0)
    .map((row) => row.anilist_id)
    .filter((id): id is number => typeof id === 'number' && !failedSeen.has(id))))
  if (dubOnlyIds.length > 0) {
    const { data: dubOnlyAnime, error: dubOnlyAnimeError } = await supabase
      .from('anime')
      .select('anilist_id, last_resynced_at')
      .in('anilist_id', dubOnlyIds)
      .order('last_resynced_at', { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE - failedCandidates.length)
    if (dubOnlyAnimeError) return Response.json({ error: dubOnlyAnimeError.message }, { status: 500 })
    for (const row of dubOnlyAnime ?? []) {
      if (typeof row.anilist_id === 'number' && !failedSeen.has(row.anilist_id)) {
        failedSeen.add(row.anilist_id)
        dubOnlyCandidates.push({ anilist_id: row.anilist_id, failed: false, priorityAt: null })
      }
    }
  }

  const remaining = Math.max(0, BATCH_SIZE - failedCandidates.length - dubOnlyCandidates.length)
  const airingCandidates: Candidate[] = []
  if (remaining > 0) {
    const { data: airingRows, error: airingError } = await supabase
      .from('anime')
      .select('anilist_id, last_resynced_at')
      .eq('status', 'Currently Airing')
      .order('last_resynced_at', { ascending: true, nullsFirst: true })
      .limit(remaining)
    if (airingError) return Response.json({ error: airingError.message }, { status: 500 })
    for (const row of airingRows ?? []) {
      if (typeof row.anilist_id === 'number' && !failedSeen.has(row.anilist_id)) {
        failedSeen.add(row.anilist_id)
        airingCandidates.push({ anilist_id: row.anilist_id, failed: false, priorityAt: null })
      }
    }
  }

  const selected = [...failedCandidates, ...dubOnlyCandidates, ...airingCandidates].slice(0, BATCH_SIZE)
  const chainDepth = Math.max(0, Number.parseInt(new URL(request.url).searchParams.get('chainDepth') ?? '0', 10) || 0)
  if (selected.length === 0) return Response.json({ animeProcessed: 0, chainDepth, message: 'nothing to resync' })

  let animeProcessed = 0
  let animeFailed = 0
  let episodesUpdated = 0
  let animeSkippedByBudget = 0

  for (let index = 0; index < selected.length; index += 1) {
    if (Date.now() - startedAt >= START_BUDGET_MS) {
      animeSkippedByBudget = selected.length - index
      break
    }
    const anime = selected[index]
    try {
      const payload = await fetchAnivexa(anime.anilist_id)
      const { data: episodes, error: episodesError } = await supabase
        .from('episodes')
        .select('play_id, episode_number')
        .eq('anilist_id', anime.anilist_id)
      if (episodesError) throw episodesError

      for (const episode of (episodes ?? []) as Episode[]) {
        const providers = buildProviders(payload, episode.episode_number)
        const { error } = await supabase.from('episodes').update(providers).eq('play_id', episode.play_id)
        if (error) throw error
        episodesUpdated += 1
      }

      const { error: animeError } = await supabase
        .from('anime')
        .update({ last_resynced_at: new Date().toISOString() })
        .eq('anilist_id', anime.anilist_id)
      if (animeError) throw animeError
      animeProcessed += 1
    } catch (error) {
      animeFailed += 1
      console.error('[resync] anime failed', anime.anilist_id, error)
    }
  }

  if (animeSkippedByBudget > 0 && chainDepth < 5) {
    void fetch(`${new URL(request.url).origin}/api/resync/run?chainDepth=${chainDepth + 1}`, { method: 'GET' }).catch((error) => {
      console.error('[resync] chained invocation failed', error)
    })
  }

  return Response.json({
    animeSelected: selected.length,
    animeProcessed,
    animeFailed,
    episodesUpdated,
    animeSkippedByBudget,
    prioritizedForFailedWatch: failedCandidates.length,
    chainDepth,
  })
}

export async function OPTIONS() {
  return new Response(null, { status: 204 })
}
