import { createAdminClient } from '@/lib/supabase/admin'
import { isRetryEligible, postOtaku, shortError, wait } from '@/lib/otaku'
import { buildOtakuAnimePayload, mapStoredStatus } from '@/lib/upcoming'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ANIVEXA_BASE_URL = 'https://anivexa.otakunaija.name.ng'
const JIKAN_BASE_URL = 'https://api.jikan.moe/v4'
const BATCH_SIZE = 10
const TIME_BUDGET_MS = 50_000
let lastJikanCallAt = 0

type AnimeRow = {
  anilist_id: number
  mal_id: number | null
  title: string
  description: string | null
  cover_url: string | null
  genres: string[] | null
  status: string | null
  release_year: number | null
  studio: string | null
  poster_url: string | null
  banner_url: string | null
  format: string | null
  otaku_anime_id: number | null
  otaku_video_id: number | null
  exported_to_otaku: boolean
  export_attempts: number
  status_synced_to_otaku: string | null
}

type EpisodeRow = {
  play_id: string
  anilist_id: number
  mal_id: number | null
  episode_number: number
  title: string | null
  description: string | null
  image_url: string | null
  air_date: string | null
  duration: number | null
  export_attempts: number
  updated_at: string | null
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
  const update = { export_attempts: attempts, last_export_error: message, updated_at: new Date().toISOString() }
  const filter = table === 'anime' ? supabase.from(table).update(update).eq('anilist_id', key) : supabase.from(table).update(update).eq('play_id', key)
  const { error } = await filter
  if (error) throw error
}

export async function GET() {
  const startedAt = Date.now()
  const supabase = createAdminClient()
  const { data: rows, error } = await supabase
  .from('episodes')
  .select('play_id, anilist_id, mal_id, episode_number, title, description, image_url, air_date, duration, exported_to_otaku, export_attempts, sub_providers, dub_providers, updated_at')
  .eq('exported_to_otaku', false)
  .or('sub_providers.neq.[],dub_providers.neq.[]')
  .order('created_at', { ascending: false })
  .limit(BATCH_SIZE)

  if (error) return Response.json({ error: error.message }, { status: 500 })
  const eligibleRows = (rows ?? []).filter((row) => isRetryEligible(row.updated_at ?? null, row.export_attempts ?? 0)).slice(0, BATCH_SIZE)
  if (!eligibleRows.length) return Response.json({ processed: 0, message: 'no retry-eligible exports' })

  let episodesExported = 0
  let animeStatusesFlipped = 0
  let animeStatusFlipFailed = 0
  let episodesBlockedByAnime = 0
  let episodesFailed = 0
  let episodesRetrying = 0

  for (const episode of eligibleRows as EpisodeRow[]) {
    if (Date.now() - startedAt >= TIME_BUDGET_MS) break
    const { data: anime, error: animeLookupError } = await supabase
  .from('anime')
  .select('anilist_id, mal_id, title, description, cover_url, genres, status, release_year, studio, poster_url, banner_url, format, otaku_anime_id, otaku_video_id, exported_to_otaku, export_attempts, status_synced_to_otaku')
  .eq('anilist_id', episode.anilist_id)
  .maybeSingle()
    if (animeLookupError || !anime) {
      episodesBlockedByAnime += 1
      continue
    }

    const animeRow = anime as AnimeRow
    const videoFormat = ['MOVIE', 'OVA', 'SPECIAL'].includes((animeRow.format ?? '').toUpperCase())
    
    if (videoFormat) {
      try {
        let videoId = animeRow.otaku_video_id

        if (videoId == null) {
          const result = await postOtaku('/api/play/videos', {
            anilistId: animeRow.anilist_id,
            malId: episode.mal_id ?? animeRow.mal_id,
            title: decodeHtml(animeRow.title),
            description: decodeHtml(animeRow.description),
            coverUrl: animeRow.cover_url,
            genres: animeRow.genres,
            status: animeRow.status,
            releaseYear: animeRow.release_year,
            studioName: animeRow.studio,
            contentType: (animeRow.format as string).toLowerCase(),
            episodeTitle: decodeHtml(episode.title),
            episodeDescription: decodeHtml(episode.description),
            thumbnailUrl: episode.image_url,
            airDate: episode.air_date,
            duration: episode.duration,
            playId: episode.play_id,
          })

          if (
            ![200, 201].includes(result.response.status) ||
            typeof result.payload.videoId !== 'number'
          ) {
            throw new Error(`Video export HTTP ${result.response.status}`)
          }

          videoId = result.payload.videoId

          const { error: saveVideoError } = await supabase
            .from('anime')
            .update({
              otaku_video_id: videoId,
              exported_to_otaku: true,
              last_export_error: null,
            })
            .eq('anilist_id', animeRow.anilist_id)

          if (saveVideoError) throw saveVideoError
        }

        // Mark the source queue row complete without storing a video ID
        // in episodes.otaku_episode_id.
        const { error: saveQueueError } = await supabase
          .from('episodes')
          .update({
            exported_to_otaku: true,
            last_export_error: null,
          })
          .eq('play_id', episode.play_id)

        if (saveQueueError) throw saveQueueError

        episodesExported += 1
      } catch (error) {
        const attempts = episode.export_attempts + 1
        await updateAttempt(
          supabase,
          'episodes',
          episode.play_id,
          attempts,
          shortError(error)
        )

        if (attempts >= 5) episodesFailed += 1
        else episodesRetrying += 1
      }

      continue
    }

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
          posterUrl: animeRow.poster_url,
          bannerUrl: animeRow.banner_url,
        })
        if (![200, 201].includes(result.response.status) || typeof result.payload.seriesId !== 'number') throw new Error(`Anime export HTTP ${result.response.status}`)
        const syncedStatus = mapStoredStatus(animeRow.status)
        const { error: saveAnimeError } = await supabase.from('anime').update({ otaku_anime_id: result.payload.seriesId, exported_to_otaku: true, status_synced_to_otaku: syncedStatus, last_export_error: null }).eq('anilist_id', animeRow.anilist_id)
        if (saveAnimeError) throw saveAnimeError
        animeRow.otaku_anime_id = result.payload.seriesId
        animeRow.status_synced_to_otaku = syncedStatus
      } catch (error) {
        await updateAttempt(supabase, 'anime', animeRow.anilist_id, animeRow.export_attempts + 1, shortError(error))
        episodesBlockedByAnime += 1
        continue
      }
    }

    // An anime that reached OtakuNaija as an upcoming placeholder flips to
    // ongoing as soon as it has a real episode to export.
    if (animeRow.otaku_anime_id != null && animeRow.status_synced_to_otaku === 'upcoming') {
      try {
        const decodedRow = {
          ...animeRow,
          title: decodeHtml(animeRow.title),
          description: decodeHtml(animeRow.description),
        }
        const statusResult = await postOtaku(
          '/api/play/anime',
          buildOtakuAnimePayload(decodedRow, { statusOverride: 'ongoing', isPlaceholder: false }) as unknown as Record<string, unknown>,
        )
        if (![200, 201].includes(statusResult.response.status)) {
          throw new Error(`Anime status update HTTP ${statusResult.response.status}`)
        }
        const { error: statusSaveError } = await supabase
          .from('anime')
          .update({ status_synced_to_otaku: 'ongoing' })
          .eq('anilist_id', animeRow.anilist_id)
        if (statusSaveError) throw statusSaveError
        animeRow.status_synced_to_otaku = 'ongoing'
        animeStatusesFlipped += 1
      } catch (error) {
        // Never block the episode: the flip is retried while the status stays 'upcoming'.
        console.error('[export] placeholder status update failed', animeRow.anilist_id, shortError(error))
        animeStatusFlipFailed += 1
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

  return Response.json({ episodesSelected: eligibleRows.length, episodesExported, episodesBlockedByAnime, episodesFailed, episodesRetrying, animeStatusesFlipped, animeStatusFlipFailed })
}

