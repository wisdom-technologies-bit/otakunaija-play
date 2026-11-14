/**
 * Shapes returned by the ani-api (`GET /v1/streams/mal/{mal_id}/episode/{n}`).
 *
 * Hand-written from `ani-cli/api/src/ani_api/models.py` on 2026-11-14. Every
 * field we do not rely on is optional here on purpose: the service is allowed to
 * grow, and an unknown extra field must never break a watch request.
 */

export type AniAudio = 'sub' | 'dub'

export type AniSubtitleKind = 'full' | 'signs' | 'forced' | 'dubtitle'
export type AniSubtitleFormat = 'vtt' | 'srt' | 'ass' | 'unknown'

export type AniSubtitleTrack = {
  url?: string
  proxied_url?: string | null
  id?: string
  index?: number
  label?: string | null
  title?: string
  language?: string
  language_name?: string
  kind?: AniSubtitleKind
  format?: AniSubtitleFormat
  converted?: boolean
  playable?: boolean
  default?: boolean
  language_verified?: boolean
}

export type AniVariant = {
  quality?: string
  playlist_url?: string
  playable?: boolean | null
  probe_http_code?: number | null
}

export type AniMalContext = {
  mal_id?: number
  mal_episode?: number
  hianime_id?: string
  episode_id?: string
  stream_verified?: boolean
  verification?: string
  evidence?: string | null
}

export type AniStreamPayload = {
  request_id?: string
  provider?: string
  metadata_source?: string
  anime_id?: string
  episode_id?: string
  episode_number?: string | null
  audio?: { type?: AniAudio; declared?: AniAudio; verified?: boolean }
  quality_requested?: string
  quality_selected?: string | null
  stream_type?: string
  master_url?: string | null
  proxied_master_url?: string | null
  variants?: AniVariant[]
  subtitles?: AniSubtitleTrack[]
  subtitle_count?: number
  subtitle_default_id?: string | null
  headers_required?: {
    master_playlist?: { Referer?: string }
    subtitles?: { Referer?: string }
    segments?: Record<string, string>
  } | null
  url_lifetime?: { observed_valid_for_minutes?: number | null }
  mal?: AniMalContext | null
}

/** Flat error body the ani-api returns: `{"code": "...", "title": ...}`. */
export type AniErrorBody = {
  code?: string
  title?: string
  detail?: string
  retry_after?: number | null
}
