import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ANIVEXA_BASE_URL = 'https://anivexa.otakunaija.name.ng'
const JIKAN_BASE_URL = 'https://api.jikan.moe/v4'
const BATCH_SIZE = 10
const TIME_BUDGET_MS = 50_000
const REQUEST_TIMEOUT_MS = 10_000

let lastJikanCallAt = 0

type AnimeRow = {
  anilist_id: number
  title: string
  description: string | null
  cover_url: string | null
  genres: string[] | null
  status: string | null
  release_year: number | null
  studio: string | null
  otaku_anime_id: number | null
  exported_to_otaku: boolean
  export_attempts: number
}

type EpisodeRow = {
  play_id: string
  anilist_id: number
  episode_number: number
  title: string | null
  description: string | null
  image_url: string | null
  air_date: string | null
  duration: number | null
  export_attempts: number
}

function decodeHtml(value: string | null | undefined): string | null {
  if (value == null) return null
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', quot: '"', nbsp: '\u00a0',
  }
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1].toLowerCase() === 'x'
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return named[entity.toLowerCase()] ?? match
  })
}

function shortError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function postOtaku(path: string, body: Record<string, unknown>) {
  const baseUrl = process.env.OTAKUNAIJA_API_URL
  const apiKey = process.env.OTAKUNAIJA_API_KEY
  if (!baseUrl || !apiKey) throw new Error('OtakuNaija API credentials are not configured')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-play-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    })
    let payload: Record<string, unknown> = {}
    try { payload = await response.json() as Record<string, unknown> } catch { /* handled as an invalid response */ }
    return { response, payload }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('OtakuNaija request timed out')
    throw error
  } finally {
    clearTimeout(timeout)
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
  return response.json() as Promise<{ data?: { title?: string; synopsis?: string | null; images?: { jpg?: { large_image_url?: string | null } }; genres?: Array<{ name?: string }>; status?: string | null; year?: number | null; aired?: { prop?: { from?: { year?: number | null } } } } }>
}

async function updateAttempt(supabase: ReturnType<typeof createAdminClient>, table: 'anime' | 'episodes', key: string | number, attempts: number, message: string) {
  const filter = table === 'anime' ? supabase.from(table).update({ export_attempts: attempts, last_export_error: message }).eq('anilist_id', key) : supabase.from(table).update({ export_attempts: attempts, last_export_error: message }).eq('play_id', key)
  const { error } = await filter
  if (error) throw error
}

export async function GET() {
  const startedAt = Date.now()
  const supabase = createAdminClient()
  const { data: rows, error } = await supabase
    .from('episodes')
    .select('play_id, anilist_id, episode_number, title, description, image_url, air_date, duration, export_attempts')
    .eq('exported_to_otaku', false)
    .lt('export_attempts', 5)
    .or('sub_providers.neq.[],dub_providers.neq.[]')
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (error) return Response.json({ error: error.message }, { status: 500 })
  if (!rows?.length) return Response.json({ processed: 0, message: 'nothing to export' })

  let episodesExported = 0
  let episodesBlockedByAnime = 0
  let episodesFailed = 0
  let episodesRetrying = 0

  for (const episode of rows as EpisodeRow[]) {
    if (Date.now() - startedAt >= TIME_BUDGET_MS) break
    const { data: anime, error: animeLookupError } = await supabase.from('anime').select('anilist_id, title, description, cover_url, genres, status, release_year, studio, otaku_anime_id, exported_to_otaku, export_attempts').eq('anilist_id', episode.anilist_id).maybeSingle()
    if (animeLookupError || !anime) {
      episodesBlockedByAnime += 1
      continue
    }

    const animeRow = anime as AnimeRow
    if (animeRow.otaku_anime_id == null) {
      try {
        const result = await postOtaku('/api/play/anime', {
          anilistId: animeRow.anilist_id,
          title: decodeHtml(animeRow.title),
          description: decodeHtml(animeRow.description),
          coverUrl: animeRow.cover_url,
          genres: animeRow.genres,
          status: animeRow.status,
          releaseYear: animeRow.release_year,
          studioName: animeRow.studio,
        })
        if (![200, 201].includes(result.response.status) || typeof result.payload.seriesId !== 'number') throw new Error(`Anime export HTTP ${result.response.status}`)
        const { error: saveAnimeError } = await supabase.from('anime').update({ otaku_anime_id: result.payload.seriesId, exported_to_otaku: true, last_export_error: null }).eq('anilist_id', animeRow.anilist_id)
        if (saveAnimeError) throw saveAnimeError
      } catch (error) {
        await updateAttempt(supabase, 'anime', animeRow.anilist_id, animeRow.export_attempts + 1, shortError(error))
        episodesBlockedByAnime += 1
        continue
      }
    }

    try {
      const result = await postOtaku('/api/play/episodes', {
        anilistId: episode.anilist_id,
        episodeNumber: episode.episode_number,
        playId: episode.play_id,
        title: decodeHtml(episode.title),
        description: decodeHtml(episode.description),
        thumbnailUrl: episode.image_url,
        airDate: episode.air_date,
        duration: episode.duration,
      })
      if (result.response.status === 404 && result.payload.error === 'ANIME_NOT_FOUND') {
        await supabase.from('anime').update({ otaku_anime_id: null, exported_to_otaku: false }).eq('anilist_id', animeRow.anilist_id)
      }
      if (![200, 201].includes(result.response.status) || typeof result.payload.episodeId !== 'number') throw new Error(result.response.status === 404 && result.payload.error === 'ANIME_NOT_FOUND' ? 'OtakuNaija anime not found' : `Episode export HTTP ${result.response.status}`)
      const { error: saveEpisodeError } = await supabase.from('episodes').update({ otaku_episode_id: result.payload.episodeId, exported_to_otaku: true, last_export_error: null }).eq('play_id', episode.play_id)
      if (saveEpisodeError) throw saveEpisodeError
      episodesExported += 1
    } catch (error) {
      const attempts = episode.export_attempts + 1
      await updateAttempt(supabase, 'episodes', episode.play_id, attempts, shortError(error))
      if (attempts >= 5) episodesFailed += 1
      else episodesRetrying += 1
    }
  }

  return Response.json({ episodesSelected: rows.length, episodesExported, episodesBlockedByAnime, episodesFailed, episodesRetrying })
}

