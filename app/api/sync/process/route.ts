import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 90

const ANIVEXA_BASE_URL = 'https://anivexa.otakunaija.name.ng'
const JIKAN_BASE_URL = 'https://api.jikan.moe/v4'
const PROVIDERS = [
  'mkissa', 'reanime', 'anikoto', 'animegg', 'anineko', 'anidbapp', 'animenosub',
  'anizone', 'aniwaves', 'anibd', 'senshi', 'kaa', 'animedunya', 'animeonsen',
] as const
const BATCH_SIZE = 10
const TIME_BUDGET_MS = 50_000
const ANIVEXA_TIMEOUT_MS = 40_000
let lastJikanCallAt = 0
let lastAniListCallAt = 0

type ProviderEpisode = {
  id?: string
  number?: number
  title?: string | null
  description?: string | null
  image?: string | null
  airDate?: string | null
  duration?: number | null
  filler?: boolean | null
  recap?: boolean | null
}

type AnivexaProvider = {
  error?: string
  episodes?: { sub?: ProviderEpisode[]; dub?: ProviderEpisode[] }
}

type AnivexaResponse = {
  mappings?: { malId?: number | null; title?: string }
  [key: string]: unknown
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchAnivexa(anilistId: number) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ANIVEXA_TIMEOUT_MS)
  try {
    const response = await fetch(`${ANIVEXA_BASE_URL}/episodes/${anilistId}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`Anivexa HTTP ${response.status}`)
    try {
      return (await response.json()) as AnivexaResponse
    } catch {
      throw new Error('Anivexa returned invalid JSON')
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Anivexa request timed out')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchAniListImages(anilistId: number) {
  const elapsed = Date.now() - lastAniListCallAt
  if (elapsed < 700) await wait(700 - elapsed)

  const request = async () => {
    lastAniListCallAt = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'query ($id: Int) { Media(id: $id, type: ANIME) { coverImage { extraLarge } bannerImage } }',
          variables: { id: anilistId },
        }),
        signal: controller.signal,
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`AniList HTTP ${response.status}`)
      const payload = await response.json() as { data?: { Media?: { coverImage?: { extraLarge?: string | null } | null; bannerImage?: string | null } | null } }
      const media = payload.data?.Media
      if (!media) throw new Error('AniList returned no media data')
      return { poster_url: media.coverImage?.extraLarge ?? null, banner_url: media.bannerImage ?? null }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('AniList image request timed out')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  try {
    return await request()
  } catch (error) {
    if (error instanceof Error && error.message === 'AniList HTTP 429') {
      await wait(3000)
      return request()
    }
    throw error
  }
}

async function fetchJikan(malId: number) {
  const elapsed = Date.now() - lastJikanCallAt
  if (elapsed < 400) await wait(400 - elapsed)
  lastJikanCallAt = Date.now()
  let response = await fetch(`${JIKAN_BASE_URL}/anime/${malId}/full`, { cache: 'no-store' })
  if (response.status === 429) {
    await wait(3000)
    lastJikanCallAt = Date.now()
    response = await fetch(`${JIKAN_BASE_URL}/anime/${malId}/full`, { cache: 'no-store' })
  }
  if (!response.ok) throw new Error(`Jikan HTTP ${response.status}`)
  return (await response.json()) as { data?: {
    title?: string | null; synopsis?: string | null; type?: string | null; images?: { jpg?: { large_image_url?: string | null } }
    genres?: Array<{ name?: string }>; status?: string | null; year?: number | null
    aired?: { prop?: { from?: { year?: number | null } } }
    studios?: Array<{ name?: string | null }>
  } }
}

function pickEpisode(provider: AnivexaProvider, episodeNumber: number, audio: 'sub' | 'dub') {
  if (provider.error) return null
  return provider.episodes?.[audio]?.find((entry) => entry.number === episodeNumber) ?? null
}

function finishStatus(attempts: number) {
  return attempts >= 5 ? 'error' : 'pending'
}

async function failRow(supabase: ReturnType<typeof createAdminClient>, row: { id: number; attempts: number }, message: string) {
  const attempts = row.attempts + 1
  await supabase.from('pending_sync').update({
    attempts,
    last_error: message.slice(0, 500),
    status: finishStatus(attempts),
  }).eq('id', row.id)
  return attempts >= 5 ? 'failed' : 'retrying'
}

export async function GET() {
  const startedAt = Date.now()
  const supabase = createAdminClient()
  let rowsFailed = 0
  let rowsRetrying = 0
  let rowsCompleted = 0

  const { data: processingRows, error: recoveryError } = await supabase
    .from('pending_sync')
    .select('id, processed_at, created_at')
    .eq('status', 'processing')
  if (recoveryError) return Response.json({ error: recoveryError.message }, { status: 500 })

  const staleBefore = Date.now() - 10 * 60 * 1000
  const staleIds = (processingRows ?? []).filter((row) => {
    const reference = row.processed_at ?? row.created_at
    return reference && new Date(reference).getTime() < staleBefore
  }).map((row) => row.id)
  if (staleIds.length > 0) {
    await supabase.from('pending_sync').update({ status: 'pending' }).in('id', staleIds)
  }

  const { data: rows, error: selectError } = await supabase
    .from('pending_sync')
    .select('id, anilist_id, episode_number, attempts')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE)
  if (selectError) return Response.json({ error: selectError.message }, { status: 500 })
  if (!rows?.length) return Response.json({ processed: 0, message: 'no pending rows' })

  for (let index = 0; index < rows.length; index += 1) {
    if (Date.now() - startedAt >= TIME_BUDGET_MS) break
    const row = rows[index]
    await supabase.from('pending_sync').update({ status: 'processing', processed_at: new Date().toISOString() }).eq('id', row.id)

    try {
      const payload = await fetchAnivexa(row.anilist_id)
      const mappings = payload.mappings ?? {}
      const malId = mappings.malId ?? null
      const animeTitle = mappings.title ?? ''
      const subProviders: Array<{ provider: string; episodeId: string }> = []
      const dubProviders: Array<{ provider: string; episodeId: string }> = []
      let firstSubMatch: ProviderEpisode | null = null
      let firstDubMatch: ProviderEpisode | null = null

      for (const providerName of PROVIDERS) {
        const provider = payload[providerName] as AnivexaProvider | undefined
        if (!provider || provider.error) continue
        const sub = pickEpisode(provider, row.episode_number, 'sub')
        if (sub?.id) {
          subProviders.push({ provider: providerName, episodeId: sub.id })
          firstSubMatch ??= sub
        }
        const dub = pickEpisode(provider, row.episode_number, 'dub')
        if (dub?.id) {
          dubProviders.push({ provider: providerName, episodeId: dub.id })
          firstDubMatch ??= dub
        }
      }

      const metadata = firstSubMatch ?? firstDubMatch
      const hasUsableMetadata = Boolean(
        metadata && (
          metadata.title != null ||
          metadata.description != null ||
          metadata.image != null ||
          metadata.airDate != null ||
          (metadata.duration != null && metadata.duration > 0) ||
          metadata.filler === true ||
          metadata.recap === true
        ),
      )
      if (!hasUsableMetadata) throw new Error('Anivexa returned no usable episode metadata')

      const { data: existingAnime, error: animeLookupError } = await supabase
        .from('anime').select('anilist_id').eq('anilist_id', row.anilist_id).maybeSingle()
      if (animeLookupError) throw animeLookupError
      if (!existingAnime) {
        let anime = { anilist_id: row.anilist_id, mal_id: malId, title: animeTitle, description: null as string | null, cover_url: null as string | null, poster_url: null as string | null, banner_url: null as string | null, format: null as string | null, genres: null as string[] | null, status: null as string | null, release_year: null as number | null, studio: null as string | null }
        if (malId !== null) {
          try {
            const jikan = await fetchJikan(malId)
            const data = jikan.data
            anime = { ...anime, title: data?.title || animeTitle, description: data?.synopsis ?? null, cover_url: data?.images?.jpg?.large_image_url ?? null, format: typeof data?.type === 'string' && ['TV', 'MOVIE', 'OVA', 'SPECIAL', 'ONA', 'MUSIC'].includes(data.type.toUpperCase()) ? data.type.toUpperCase() : null, genres: data?.genres?.map((genre) => genre.name).filter((name): name is string => Boolean(name)) ?? [], status: data?.status ?? null, release_year: data?.year ?? data?.aired?.prop?.from?.year ?? null, studio: data?.studios?.[0]?.name ?? null }
          } catch {
            // The requested fallback is the minimal anime row.
          }
        }
        try {
          const images = await fetchAniListImages(row.anilist_id)
          anime = { ...anime, ...images }
        } catch {
          anime = { ...anime, poster_url: null, banner_url: null }
        }
        const { error } = await supabase.from('anime').insert(anime)
        if (error) throw error
      }

      const { error: episodeError } = await supabase.from('episodes').upsert({
        play_id: `${row.anilist_id}-${row.episode_number}`,
        anilist_id: row.anilist_id,
        mal_id: malId,
        episode_number: row.episode_number,
        title: metadata?.title ?? null,
        description: metadata?.description ?? null,
        image_url: metadata?.image ?? null,
        air_date: metadata?.airDate ?? null,
        duration: metadata?.duration ?? null,
        filler: metadata?.filler ?? null,
        recap: metadata?.recap ?? null,
        sub_providers: subProviders,
        dub_providers: dubProviders,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'play_id' })
      if (episodeError) throw episodeError
      await supabase.from('pending_sync').update({ status: 'done', processed_at: new Date().toISOString() }).eq('id', row.id)
      rowsCompleted += 1
    } catch (error) {
      const result = await failRow(supabase, row, error instanceof Error ? error.message : 'Sync processing failed')
      if (result === 'failed') rowsFailed += 1
      else rowsRetrying += 1
    }
  }

  return Response.json({
    rowsSelected: rows.length,
    rowsCompleted,
    rowsFailed,
    rowsRetrying,
    rowsSkippedByBudget: rows.length - rowsCompleted - rowsFailed - rowsRetrying,
  })
}
