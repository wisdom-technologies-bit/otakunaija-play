/**
 * Segment proxy (edge).
 *
 * Fetches the signed media URI with the signed headers and hands the bytes back
 * to the player. Two upstream habits are handled explicitly:
 *
 *  - AniKoto serves real MPEG-TS bytes under `image/jpeg` with a `.jpg`
 *    extension (`seg-1-v1-a1.jpg`). A player that trusts the content type will
 *    refuse them, so the body is sniffed: a first byte of 0x47 is a TS sync byte
 *    and the response is relabelled `video/mp2t` whatever the upstream called it.
 *  - A CDN that answers an expired or blocked request with an HTML error page
 *    would otherwise reach the demuxer as "video". Those are rejected as a
 *    failed fetch, so the player's retry path runs instead of a decode error.
 *
 * Small bodies are buffered to make the sniff possible; anything larger than
 * SNIFF_MAX_BYTES is streamed through unchanged, because a 20 MB body is not an
 * error page worth reading.
 */

import { corsHeaders, proxyJson, verifyProxySignature, withDefaultUserAgent } from '@/lib/proxy-signing'

export const runtime = 'edge'

const PASSTHROUGH_HEADERS = ['Content-Length', 'Content-Range', 'Accept-Ranges']
const SNIFF_MAX_BYTES = 8 * 1024 * 1024
const TS_SYNC_BYTE = 0x47
const DEFAULT_TS_TYPE = 'video/mp2t'

export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders() }) }

function isHtmlType(contentType: string) {
  return /text\/html|application\/xhtml/i.test(contentType)
}

/** Leading whitespace ignored: a CDN often prefixes its error page with a newline. */
function looksLikeHtml(bytes: Uint8Array) {
  for (const byte of bytes.subarray(0, 64)) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
    return byte === 0x3c // '<'
  }
  return false
}

function isTs(bytes: Uint8Array) {
  return bytes.length > 0 && bytes[0] === TS_SYNC_BYTE
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const verified = await verifyProxySignature(params.get('u') ?? '', params.get('h') ?? '', params.get('e') ?? '', params.get('s') ?? '')
  if (!verified.valid || !verified.targetUrl || !verified.headers) return proxyJson({ error: 'INVALID_OR_EXPIRED_SIGNATURE' }, 403)
  try {
    const upstreamHeaders = withDefaultUserAgent(verified.headers)
    const range = request.headers.get('Range')
    if (range) upstreamHeaders.Range = range

    const response = await fetch(verified.targetUrl, {
      headers: upstreamHeaders,
      redirect: 'follow',
      cache: 'no-store',
    })
    // 200 and 206 are both ok; let 416 (bad range) through so the player can recover.
    if (!response.ok && response.status !== 416) return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502)

    const upstreamType = response.headers.get('Content-Type') ?? ''
    const headers = new Headers(corsHeaders())
    for (const name of PASSTHROUGH_HEADERS) {
      const value = response.headers.get(name)
      if (value) headers.set(name, value)
    }
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
    headers.set('Cache-Control', 'public, max-age=3600')
    if (!headers.has('Accept-Ranges')) headers.set('Accept-Ranges', 'bytes')

    // A body that cannot start with a sync byte proves nothing, so sniffing only
    // applies to a full body or a range that begins at byte 0.
    const fullBody = response.status === 200 || !range || /^bytes=0-/.test(range.trim())
    const length = Number(response.headers.get('Content-Length') ?? '')
    const snifffable = fullBody && (!Number.isFinite(length) || length <= SNIFF_MAX_BYTES)

    if (!snifffable) {
      headers.set('Content-Type', isHtmlType(upstreamType) ? DEFAULT_TS_TYPE : upstreamType || DEFAULT_TS_TYPE)
      return new Response(response.body, { status: response.status, headers })
    }

    const bytes = new Uint8Array(await response.arrayBuffer())

    // An HTML error page is never a segment. Reject it so the player retries
    // (and, for an ani stream, excludes the provider) instead of feeding markup
    // to the demuxer.
    if (isHtmlType(upstreamType) || looksLikeHtml(bytes)) {
      return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502)
    }

    // The sync byte decides, not the label: TS under `image/jpeg` (AniKoto) and
    // a mislabelled `application/octet-stream` are both real media.
    const contentType = isTs(bytes)
      ? DEFAULT_TS_TYPE
      : upstreamType || (verified.targetUrl.toLowerCase().includes('.ts') ? DEFAULT_TS_TYPE : 'video/mp4')
    headers.set('Content-Type', contentType)
    if (fullBody && bytes.length > 0) headers.set('Content-Length', String(bytes.length))

    return new Response(bytes, { status: response.status, headers })
  } catch { return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502) }
}
