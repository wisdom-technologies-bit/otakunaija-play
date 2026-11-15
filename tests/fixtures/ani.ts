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
  ANI_ANIKOTO_REQUIRE_SUBTITLE: '1',
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

/* ------------------------------------------------------------------------- *
 * AniKoto — the ani-api's new FIRST source (as of 2026-11-15).
 *
 * Shapes below come from real `curl` output for
 * `GET /v1/streams/mal/{mal}/episode/{n}?audio=sub&quality=best`:
 *
 *  - `provider: "anikoto"` first, ZokoAnime as the fallback.
 *  - `master_url` on `fetch.nexabloom.top`.
 *  - `headers_required.master_playlist.Referer` and `.subtitles.Referer` are
 *    both `https://megaplay.buzz/`.
 *  - `headers_required.segments` says `{}` even though every segment returns
 *    403 without that Referer, so the master playlist's headers are what the
 *    segment proxy must sign with.
 *  - subtitle `url` is ABSOLUTE on `*.mysubsplay.com`; `proxied_url` is a
 *    RELATIVE ani-api path (`/v1/subtitles/<token>.vtt`) that needs the key.
 *  - subtitle `language` is `"en"` on EVERY track, in every language.
 *  - `intro` / `outro` are `[start, end]` seconds, `[0, 0]` when unknown.
 *  - there is no `url_lifetime` (`expiry_known: false`).
 * ------------------------------------------------------------------------- */

export const ANIKOTO_REFERER = 'https://megaplay.buzz/'
export const ANIKOTO_MASTER_HOST = 'fetch.nexabloom.top'
export const ANIKOTO_MASTER_URL = `https://${ANIKOTO_MASTER_HOST}/hls/one-piece/ep1/master.m3u8`
/** Solo Leveling: the same master for `audio=sub` and `audio=dub`. */
export const SOLO_LEVELING_MAL = 52299

/**
 * One subtitle track in the exact AniKoto shape: absolute CDN `url`, relative
 * `proxied_url`, `converted: false`, `format: "vtt"`, `language: "en"` whatever
 * the track actually is.
 */
export function anikotoTrack(label: string, id: string, index: number, file: string): NonNullable<AniStreamPayload['subtitles']>[number] {
  return {
    url: `https://subs1.mysubsplay.com/anikoto/${file}.vtt`,
    proxied_url: `/v1/subtitles/${id}.vtt`,
    id,
    index,
    label,
    title: label,
    language: 'en',
    language_name: 'English',
    kind: 'full',
    format: 'vtt',
    converted: false,
    playable: true,
    default: index === 0,
    language_verified: false,
  }
}

/** A payload in the AniKoto shape; `mal` and the markers are what vary. */
export function anikotoStreamPayload(options: {
  malId?: number
  episode?: number
  provider?: string
  masterUrl?: string
  subtitles?: NonNullable<AniStreamPayload['subtitles']>
  intro?: [number, number] | null
  outro?: [number, number] | null
  urlLifetime?: { observed_valid_for_minutes?: number | null }
} = {}): AniStreamPayload {
  const malId = options.malId ?? MAL_ID
  const episode = options.episode ?? EPISODE
  const subtitles = options.subtitles ?? [
    anikotoTrack('Portuguese (- Portuguese(Brazil))', 'ak-1', 0, 'one-piece-1-ptbr'),
    anikotoTrack('Spanish (- Spanish(Latin America))', 'ak-2', 1, 'one-piece-1-esla'),
    anikotoTrack('English', 'ak-3', 2, 'one-piece-1-en'),
  ]
  return {
    request_id: 'req-anikoto',
    provider: options.provider ?? 'anikoto',
    metadata_source: options.provider ?? 'anikoto',
    anime_id: `anikoto-${malId}`,
    episode_id: String(episode),
    episode_number: String(episode),
    audio: { type: 'sub', declared: 'sub', verified: false },
    quality_requested: 'best',
    quality_selected: '1080p',
    stream_type: 'hls',
    master_url: options.masterUrl ?? ANIKOTO_MASTER_URL,
    proxied_master_url: '/v1/stream/anikoto-token/master.m3u8',
    variants: [
      { quality: '1080p', playlist_url: `https://${ANIKOTO_MASTER_HOST}/hls/one-piece/ep1/1080/index.m3u8`, playable: true, probe_http_code: 200 },
    ],
    subtitles,
    subtitle_count: subtitles.length,
    subtitle_default_id: subtitles[0]?.id ?? null,
    headers_required: {
      master_playlist: { Referer: ANIKOTO_REFERER },
      subtitles: { Referer: ANIKOTO_REFERER },
      // Real payload: `{}`. The segments still need the Referer, which is why
      // the manifest rewrite proxies them with the master playlist's headers.
      segments: {},
    },
    ...(options.urlLifetime ? { url_lifetime: options.urlLifetime } : {}),
    intro: 'intro' in options ? options.intro : [31, 111],
    outro: 'outro' in options ? options.outro : [1376, 1447],
    mal: {
      mal_id: malId,
      mal_episode: episode,
      episode_id: String(episode),
      stream_verified: true,
      verification: 'provider_embed',
      evidence: `anikoto embed /mal/${malId}/${episode}/sub`,
    },
  }
}

/** Solo Leveling: unknown opening (`[0, 0]`), known ending. */
export function soloLevelingPayload(): AniStreamPayload {
  return anikotoStreamPayload({
    malId: SOLO_LEVELING_MAL,
    intro: [0, 0],
    outro: [1325, 1414],
    subtitles: [
      anikotoTrack('English', 'sl-1', 0, 'solo-leveling-1-en'),
      anikotoTrack('Portuguese (- Portuguese(Brazil))', 'sl-2', 1, 'solo-leveling-1-ptbr'),
    ],
  })
}

/** Attack on Titan: three tracks, three languages, every `language: "en"`. */
export function attackOnTitanPayload(): AniStreamPayload {
  return anikotoStreamPayload({
    malId: 16498,
    intro: [12, 102],
    outro: null,
    subtitles: [
      anikotoTrack('Arabic', 'aot-1', 0, 'aot-1-ar'),
      anikotoTrack('French', 'aot-2', 1, 'aot-1-fr'),
      anikotoTrack('Thai', 'aot-3', 2, 'aot-1-th'),
    ],
  })
}

/** Naruto: nine tracks, all labelled `language: "en"`. */
export function narutoPayload(): AniStreamPayload {
  const labels = [
    'Arabic', 'English', 'French', 'Indonesian', 'Italian',
    'Portuguese (- Portuguese(Brazil))', 'Russian', 'Spanish (- Spanish(Latin America))', 'Thai',
  ]
  return anikotoStreamPayload({
    malId: 20,
    intro: [0, 0],
    outro: [0, 0],
    subtitles: labels.map((label, index) => anikotoTrack(label, `naruto-${index + 1}`, index, `naruto-1-${index + 1}`)),
  })
}

/** Some AniKoto episodes really do come back with zero subtitle tracks. */
export function anikotoNoSubtitlePayload(malId: number = MAL_ID): AniStreamPayload {
  return anikotoStreamPayload({ malId, subtitles: [] })
}

/**
 * The identical sub/dub pair (MAL 52299 episode 1): both audio paths return the
 * exact same `master_url`, so the dub is really the sub.
 */
export function identicalSubDubPair(): { sub: AniStreamPayload, dub: AniStreamPayload } {
  const sub = soloLevelingPayload()
  const dub = { ...soloLevelingPayload(), audio: { type: 'dub' as const, declared: 'dub' as const, verified: false } }
  return { sub, dub }
}
