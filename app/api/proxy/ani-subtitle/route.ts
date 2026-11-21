/**
 * ani subtitle proxy (node runtime).
 *
 * A track the provider already serves as WebVTT keeps using the existing signed
 * `/api/proxy/subtitle`. A track that needs conversion (srt, ass, or a track the
 * ani-api marked `converted`) is fetched here instead: this route holds the key,
 * re-resolves the track from the ani cache, and answers `text/vtt`.
 *
 * The signed token carries only `{mal, ep, audio, trackId}`. The browser never
 * receives an ani-api URL, an ani-api token, or the key.
 *
 * The track fetch shares the upstream bounds in lib/proxy-upstream.ts: ~10 s to
 * the headers, ~15 s with no body bytes, and one retry for a timeout, a network
 * error or an upstream 5xx. A track that never arrives now fails fast with a
 * CORS-carrying 504/502 instead of holding the request open.
 */

import { readAniConfig } from '@/lib/ani/config'
import { getAniStream } from '@/lib/ani/client'
import { corsHeaders, proxyJson, verifyAniSubtitleToken } from '@/lib/proxy-signing'
import { fetchUpstream, readTextUpstream, runWithRetry } from '@/lib/proxy-upstream'
import type { AniStreamPayload, AniSubtitleTrack } from '@/lib/ani/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const CACHE_HEADER = 'public, max-age=3600'

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

function findTrack(payload: AniStreamPayload, trackId: string): AniSubtitleTrack | null {
  const tracks = Array.isArray(payload.subtitles) ? payload.subtitles : []
  const byId = tracks.find((track) => track?.id === trackId)
  if (byId) return byId
  if (trackId.startsWith('idx:')) {
    const index = Number(trackId.slice(4))
    const byIndex = tracks.find((track) => track?.index === index)
    if (byIndex) return byIndex
  }
  return null
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const token = await verifyAniSubtitleToken(params.get('p') ?? '', params.get('e') ?? '', params.get('s') ?? '')
  if (!token) return proxyJson({ error: 'INVALID_OR_EXPIRED_SIGNATURE' }, 403)

  const config = readAniConfig()
  if (!config.baseUrl || !config.apiKey) return proxyJson({ error: 'ANI_NOT_CONFIGURED' }, 503)

  let payload: AniStreamPayload
  try {
    payload = await getAniStream(token.mal, token.ep, token.audio)
  } catch {
    return proxyJson({ error: 'SUBTITLE_UNAVAILABLE' }, 502)
  }

  const track = findTrack(payload, token.trackId)
  const proxiedUrl = track?.proxied_url
  if (!track || typeof proxiedUrl !== 'string' || proxiedUrl.length === 0) {
    return proxyJson({ error: 'SUBTITLE_TRACK_NOT_FOUND' }, 404)
  }

  const referer = payload.headers_required?.subtitles?.Referer || 'https://zokoanime.video/'
  const target = proxiedUrl.startsWith('http') ? proxiedUrl : `${config.baseUrl}${proxiedUrl}`
  if (!target.startsWith(config.baseUrl)) return proxyJson({ error: 'SUBTITLE_TRACK_NOT_FOUND' }, 404)

  // Captured as a const so the closure keeps the narrowing from the guard above.
  const apiKey = config.apiKey
  const outcome = await runWithRetry(async () => {
    const response = await fetchUpstream(target, {
      headers: {
        'X-API-Key': apiKey,
        'User-Agent': 'OtakuNaijaPlay',
        Referer: referer,
        accept: 'text/vtt, */*',
      },
      cache: 'no-store',
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return { failed: true as const }
    }
    return { failed: false as const, text: await readTextUpstream(response) }
  }, target, 'ani-subtitle')

  if (!outcome.ok) return proxyJson({ error: outcome.code }, outcome.status)
  if (outcome.value.failed) return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502)

  const headers = new Headers(corsHeaders())
  headers.set('Content-Type', 'text/vtt; charset=utf-8')
  headers.set('Cache-Control', CACHE_HEADER)
  return new Response(outcome.value.text, { status: 200, headers })
}
