/**
 * Fixtures shaped exactly like the ani-api responses described in
 * `ani-cli/api/README.md`, `models.py`, `services/streams.py` and
 * `services/subtitles.py` (read on 2026-11-14).
 *
 * The sandbox cannot reach the production API and holds no key, so these are
 * hand-built from the documented shapes, not captured from a live call. They
 * cover a stream with five subtitle tracks (one needing conversion), sub and
 * dub, and every documented error code.
 */

import type { AniStreamPayload } from '@/lib/ani/types'

export const MAL_ID = 21
export const ANILIST_ID = 1001
export const EPISODE = 1
export const ANI_BASE = 'https://ani-api.example.test'
export const SENTINEL_KEY = 'ani-key-SENTINEL-do-not-leak-7f3a9c'

export const ANI_ENV: Record<string, string> = {
  ANI_PROVIDER_ENABLED: '1',
  ANI_API_BASE_URL: ANI_BASE,
  ANI_API_KEY: SENTINEL_KEY,
  ANI_PROVIDER_PERCENT: '100',
  ANI_DUB_ENABLED: '0',
  ANI_REQUIRE_SUBTITLE: '1',
}

export function aniStreamPayload(overrides: Partial<AniStreamPayload> = {}): AniStreamPayload {
  return {
    request_id: 'req-fixture',
    provider: 'zokoanime',
    metadata_source: 'hianime',
    anime_id: 'one-piece-1',
    episode_id: '1',
    episode_number: '1',
    audio: { type: 'sub', declared: 'sub', verified: false },
    quality_requested: 'best',
    quality_selected: '1080p',
    stream_type: 'hls',
    master_url: 'https://hls.dramahot.top/abc/master.m3u8',
    proxied_master_url: '/v1/stream/token.master/master.m3u8',
    variants: [
      { quality: '1080p', playlist_url: 'https://hls.dramahot.top/abc/1080/index.m3u8', playable: true, probe_http_code: 200 },
      { quality: '720p', playlist_url: 'https://hls.dramahot.top/abc/720/index.m3u8', playable: true, probe_http_code: 200 },
    ],
    subtitles: [
      {
        url: 'https://hls.dramahot.top/abc/subs/english.vtt',
        id: 'sub-1',
        index: 0,
        label: 'English (- (Crunchyroll))',
        title: 'English (Crunchyroll)',
        language: 'en',
        language_name: 'English',
        kind: 'full',
        format: 'vtt',
        converted: false,
        playable: true,
        default: true,
        language_verified: false,
        proxied_url: '/v1/subtitles/tok1.vtt',
      },
      {
        url: 'https://hls.dramahot.top/abc/subs/spanish.vtt',
        id: 'sub-2',
        index: 1,
        label: 'Spanish',
        title: 'Spanish',
        language: 'es',
        language_name: 'Spanish',
        kind: 'full',
        format: 'vtt',
        converted: false,
        playable: true,
        default: false,
        language_verified: false,
        proxied_url: '/v1/subtitles/tok2.vtt',
      },
      {
        url: 'https://hls.dramahot.top/abc/subs/portuguese.srt',
        id: 'sub-3',
        index: 2,
        label: 'Portuguese - Brazil',
        title: 'Portuguese (Brazil)',
        language: 'pt',
        language_name: 'Portuguese',
        kind: 'full',
        format: 'srt',
        converted: true,
        playable: true,
        default: false,
        language_verified: false,
        proxied_url: '/v1/subtitles/tok3.vtt',
      },
      {
        url: 'https://hls.dramahot.top/abc/subs/arabic.ass',
        id: 'sub-4',
        index: 3,
        label: 'Arabic',
        title: 'Arabic',
        language: 'ar',
        language_name: 'Arabic',
        kind: 'full',
        format: 'ass',
        converted: true,
        playable: true,
        default: false,
        language_verified: false,
        proxied_url: '/v1/subtitles/tok4.vtt',
      },
      {
        url: 'https://hls.dramahot.top/abc/subs/signs.vtt',
        id: 'sub-5',
        index: 4,
        label: 'English Signs & Songs',
        title: 'English (Signs & Songs)',
        language: 'en',
        language_name: 'English',
        kind: 'signs',
        format: 'vtt',
        converted: false,
        playable: true,
        default: false,
        language_verified: false,
        proxied_url: '/v1/subtitles/tok5.vtt',
      },
    ],
    subtitle_count: 5,
    subtitle_default_id: 'sub-1',
    headers_required: {
      master_playlist: { Referer: 'https://zokoanime.video/' },
      subtitles: { Referer: 'https://zokoanime.video/' },
      segments: {},
    },
    url_lifetime: { observed_valid_for_minutes: 28 },
    mal: {
      mal_id: MAL_ID,
      mal_episode: EPISODE,
      hianime_id: 'one-piece-1',
      episode_id: '1',
      stream_verified: true,
      verification: 'provider_embed',
      evidence: 'embed /mal/21/1/sub on episode 1',
    },
    ...overrides,
  }
}

/** A dub payload: same stream, declared dub, audio never verified. */
export function aniDubPayload(): AniStreamPayload {
  return aniStreamPayload({ audio: { type: 'dub', declared: 'dub', verified: false } })
}

export const ANI_ERROR_BODIES: Record<string, { status: number, body: { code: string, title: string } }> = {
  MAL_NOT_FOUND: { status: 404, body: { code: 'MAL_NOT_FOUND', title: 'Unknown MAL id' } },
  MAL_NOT_MAPPED: { status: 404, body: { code: 'MAL_NOT_MAPPED', title: 'No verified HiAnime mapping' } },
  MAL_MAPPING_AMBIGUOUS: { status: 409, body: { code: 'MAL_MAPPING_AMBIGUOUS', title: 'Ambiguous mapping' } },
  MAL_EPISODE_NOT_FOUND: { status: 404, body: { code: 'MAL_EPISODE_NOT_FOUND', title: 'Episode not present' } },
  MAL_EPISODE_MISMATCH: { status: 409, body: { code: 'MAL_EPISODE_MISMATCH', title: 'Embed disagrees' } },
  MAL_TITLE_SOURCE_UNAVAILABLE: { status: 503, body: { code: 'MAL_TITLE_SOURCE_UNAVAILABLE', title: 'Title source down' } },
}
