/**
 * Turning an ani-api payload into a stream this resolver is willing to serve.
 *
 * Nothing here guesses. A payload is used only when the API proved it is the
 * requested MAL episode and every field we hand to the browser passed a check.
 * Anything else is a typed skip and the caller falls through to Anivexa, which
 * is exactly what happened before the provider existed.
 */

import { readAniConfig, withinAniPercent, type AniConfig, type AniEnv } from './config'
import { getAniStream, logAniOutcome } from './client'
import { AniRequestError, isAniError } from './errors'
import type { AniAudio, AniStreamPayload, AniSubtitleTrack } from './types'
import { signAniSubtitlePath } from '@/lib/proxy-signing'

/** The only hosts a master playlist may live on. Subdomains included. */
export const ALLOWED_MASTER_HOSTS = ['dramahot.top', 'drama1.cfd'] as const

export const DEFAULT_SUBTITLE_REFERER = 'https://zokoanime.video/'

export type PlayerSubtitle = {
  url: string
  label: string
  srclang?: string
  default: boolean
  kind: string
}

export type AniProviderStream = {
  streamUrl: string
  type: 'hls'
  server: null
  headers: Record<string, string>
  subtitles: PlayerSubtitle[]
  intro: null
  outro: null
  /** Per-subtitle path already signed by this module; null = sign the raw url. */
  subtitlePaths: Array<string | null>
}

export type TryAniResult =
  | { status: 'ok'; stream: AniProviderStream; ms: number; malId: number }
  | { status: 'skipped' | 'failed'; reason: string; ms: number; malId: number | null }

export type TryAniInput = {
  anilistId: number
  episodeNumber: number
  malId: number | null
  audio: AniAudio
  excluded: Set<string>
  /** The resolver's existing m3u8 probe. A failed probe means ani is skipped. */
  probe: (streamUrl: string, headers: Record<string, string>) => Promise<boolean>
  /**
   * Called only after every cheap gate passed, so a disabled provider or an id
   * outside the rollout percentage never touches the database.
   */
  lookupMalId?: () => Promise<number | null>
  env?: AniEnv
}

function hostOf(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.host.toLowerCase() : null
  } catch {
    return null
  }
}

/** https + one of the allow-listed hosts (or a subdomain of one). */
export function isAllowedMasterUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  const host = hostOf(value)
  if (!host) return false
  return ALLOWED_MASTER_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

export type ValidatedAniStream = {
  masterUrl: string
  referer: string
  subtitleReferer: string
  quality: string | null
  tracks: AniSubtitleTrack[]
}

/**
 * Validate the payload before any of it is used.
 *
 * Order matters: identity first (never serve the wrong episode), then shape,
 * then host, then the two "is there anything to play" checks.
 */
export function validateAniPayload(
  payload: AniStreamPayload,
  expected: { malId: number, episode: number, audio: AniAudio, requireSubtitle: boolean },
): ValidatedAniStream {
  const mal = payload.mal
  if (!mal || mal.stream_verified !== true) throw new AniRequestError('ANI_NOT_VERIFIED')
  if (Number(mal.mal_id) !== expected.malId || Number(mal.mal_episode) !== expected.episode) {
    throw new AniRequestError('ANI_EPISODE_MISMATCH')
  }
  if (payload.stream_type !== 'hls') throw new AniRequestError('ANI_BAD_STREAM_TYPE')
  if (!isAllowedMasterUrl(payload.master_url)) throw new AniRequestError('ANI_HOST_NOT_ALLOWED')

  const playable = (payload.variants ?? []).filter((variant) => variant?.playable === true)
  if (playable.length === 0) throw new AniRequestError('ANI_NO_VARIANT')

  const tracks = playableTracks(payload.subtitles ?? [])
  if (expected.requireSubtitle && expected.audio === 'sub' && tracks.length === 0) {
    throw new AniRequestError('ANI_NO_SUBTITLE')
  }

  return {
    masterUrl: payload.master_url as string,
    referer: payload.headers_required?.master_playlist?.Referer || DEFAULT_SUBTITLE_REFERER,
    subtitleReferer: payload.headers_required?.subtitles?.Referer || DEFAULT_SUBTITLE_REFERER,
    quality: payload.quality_selected ?? null,
    tracks,
  }
}

function playableTracks(tracks: AniSubtitleTrack[]): AniSubtitleTrack[] {
  return tracks.filter((track) => {
    if (!track || track.playable !== true) return false
    const url = typeof track.url === 'string' && track.url.length > 0
    const proxied = typeof track.proxied_url === 'string' && track.proxied_url.length > 0
    return url || proxied
  })
}

function isSignsTrack(track: AniSubtitleTrack) {
  return track.kind === 'signs' || track.kind === 'forced'
}

function isEnglish(track: AniSubtitleTrack) {
  const language = (track.language ?? '').toLowerCase()
  if (language === 'en' || language === 'en-us' || language === 'en-gb') return true
  const label = (track.label ?? '').trim().toLowerCase()
  return label === 'english' || label.startsWith('english ')
}

/**
 * Every playable track, ordered for a player: the provider's default first, then
 * English, then everything else in the provider's own order. Signs/forced tracks
 * are only dropped when a full track exists, because a signs-only episode must
 * still be watchable.
 */
export function orderSubtitles(tracks: AniSubtitleTrack[]): AniSubtitleTrack[] {
  const playable = playableTracks(tracks)
  const full = playable.filter((track) => !isSignsTrack(track))
  const pool = full.length > 0 ? full : playable
  return pool
    .map((track, index) => ({ track, index }))
    .sort((a, b) => {
      const aDefault = a.track.default === true ? 0 : 1
      const bDefault = b.track.default === true ? 0 : 1
      if (aDefault !== bDefault) return aDefault - bDefault
      const aEnglish = isEnglish(a.track) ? 0 : 1
      const bEnglish = isEnglish(b.track) ? 0 : 1
      if (aEnglish !== bEnglish) return aEnglish - bEnglish
      return a.index - b.index
    })
    .map((entry) => entry.track)
}

/** A track is served as WebVTT by us only when the provider's own file is not. */
export function needsConversion(track: AniSubtitleTrack): boolean {
  if (track.converted === true) return true
  if (typeof track.format === 'string' && track.format !== 'vtt') return true
  return false
}

function languageCode(track: AniSubtitleTrack): string | undefined {
  const code = (track.language ?? '').trim()
  if (!code || code.toLowerCase() === 'und') return undefined
  return code
}

function labelFor(track: AniSubtitleTrack): string {
  const label = typeof track.label === 'string' ? track.label.trim() : ''
  if (label.length > 0) return label
  const title = typeof track.title === 'string' ? track.title.trim() : ''
  return title.length > 0 ? title : 'Subtitles'
}

/**
 * Build the player-facing stream from a validated payload.
 *
 * vtt tracks the provider already serves go through the existing signed
 * `/api/proxy/subtitle`. Anything else (converted, srt, ass, unknown) goes
 * through our own `/api/proxy/ani-subtitle`, whose token carries only
 * `{mal, ep, audio, trackId}`: the browser never sees an ani-api URL or key.
 */
export async function buildAniProviderStream(
  validated: ValidatedAniStream,
  context: { malId: number, episode: number, audio: AniAudio },
): Promise<AniProviderStream> {
  const ordered = orderSubtitles(validated.tracks)
  const subtitles: PlayerSubtitle[] = []
  const subtitlePaths: Array<string | null> = []

  for (const [position, track] of ordered.entries()) {
    const source = (track.proxied_url as string | undefined) ?? (track.url as string)
    const converted = needsConversion(track)
    const language = languageCode(track)
    subtitles.push({
      url: source,
      label: labelFor(track),
      ...(language ? { srclang: language } : {}),
      default: track.default === true,
      kind: track.kind ?? 'full',
    })
    subtitlePaths.push(
      converted
        ? await signAniSubtitlePath({
            mal: context.malId,
            ep: context.episode,
            audio: context.audio,
            // Stable handle: the provider's own id when it has one, otherwise
            // the provider's raw index. A drifted payload resolves to "not
            // found" rather than to a different language.
            trackId: track.id || `idx:${track.index ?? position}`,
          })
        : null,
    )
  }

  return {
    streamUrl: validated.masterUrl,
    type: 'hls',
    server: null,
    headers: { Referer: validated.referer },
    subtitles,
    intro: null,
    outro: null,
    subtitlePaths,
  }
}

function skipReason(error: unknown): string {
  if (isAniError(error)) return error.code
  if (error instanceof Error && error.name === 'AbortError') return 'ANI_TIMEOUT'
  return 'ANI_UNKNOWN'
}

/**
 * Cheap gates first, in order, so a request that cannot possibly use ani pays
 * nothing for it: no upstream call, and no Supabase lookup either.
 */
export function aniSkipReason(
  input: { anilistId: number, audio: AniAudio, excluded: Set<string> },
  config: AniConfig,
): string | null {
  if (!config.enabled) return 'ANI_DISABLED'
  if (!config.baseUrl || !config.apiKey) return 'ANI_NOT_CONFIGURED'
  if (input.audio === 'dub' && !config.dubEnabled) return 'ANI_DUB_DISABLED'
  for (const entry of input.excluded) {
    if (entry.startsWith('ani:')) return 'ANI_EXCLUDED'
  }
  if (!withinAniPercent(input.anilistId, config.percent)) return 'ANI_OUT_OF_PERCENT'
  return null
}

/**
 * Try ani before Anivexa. Resolves to `ok` only when the payload validated AND
 * the playlist actually answered a probe; everything else is a typed skip that
 * the caller ignores after one trace line.
 */
export async function tryAni(input: TryAniInput): Promise<TryAniResult> {
  const started = Date.now()
  const config = readAniConfig(input.env)
  const finish = (status: 'skipped' | 'failed', reason: string, malId: number | null): TryAniResult => {
    const ms = Date.now() - started
    logAniOutcome({
      anilistId: input.anilistId,
      malId,
      episode: input.episodeNumber,
      audio: input.audio,
      outcome: status,
      reason,
      ms,
    })
    return { status, reason, ms, malId }
  }

  const gate = aniSkipReason(input, config)
  if (gate) {
    // A flag-off deployment must stay as quiet as it was before this feature
    // existed, so cheap gate skips only reach the log once the provider is on.
    if (config.enabled) return finish('skipped', gate, input.malId)
    return { status: 'skipped', reason: gate, ms: Date.now() - started, malId: input.malId }
  }

  let malId = input.malId
  if (malId === null && input.lookupMalId) malId = await input.lookupMalId()
  if (malId === null) return finish('skipped', 'ANI_NO_MAL_ID', null)

  try {
    const payload = await getAniStream(malId, input.episodeNumber, input.audio, { env: input.env })
    const validated = validateAniPayload(payload, {
      malId,
      episode: input.episodeNumber,
      audio: input.audio,
      requireSubtitle: config.requireSubtitle,
    })
    const stream = await buildAniProviderStream(validated, {
      malId,
      episode: input.episodeNumber,
      audio: input.audio,
    })

    const usable = await input.probe(stream.streamUrl, stream.headers)
    if (!usable) {
      const ms = Date.now() - started
      logAniOutcome({
        anilistId: input.anilistId,
        malId,
        episode: input.episodeNumber,
        audio: input.audio,
        outcome: 'failed',
        reason: 'ANI_PROBE_FAILED',
        ms,
      })
      return { status: 'failed', reason: 'ANI_PROBE_FAILED', ms, malId }
    }

    const ms = Date.now() - started
    logAniOutcome({
      anilistId: input.anilistId,
      malId: input.malId,
      episode: input.episodeNumber,
      audio: input.audio,
      outcome: 'ok',
      reason: null,
      ms,
    })
    return { status: 'ok', stream, ms, malId }
  } catch (error) {
    return finish('failed', skipReason(error), malId)
  }
}
