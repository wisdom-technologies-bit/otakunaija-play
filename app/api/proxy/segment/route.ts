/**
 * Segment proxy (edge).
 *
 * Fetches the signed media URI with the signed headers and hands the bytes back
 * to the player. Two upstream habits are handled explicitly:
 *
 *  - AniKoto serves real MPEG-TS bytes under `image/jpeg` with a `.jpg`
 *    extension (`seg-1-v1-a1.jpg`). A player that trusts the content type will
 *    refuse them, so a suspicious body is sniffed: a first byte of 0x47 is a TS
 *    sync byte and the response is relabelled `video/mp2t` whatever the upstream
 *    called it.
 *  - A CDN that answers an expired or blocked request with an HTML error page
 *    would otherwise reach the demuxer as "video". Those are rejected as a
 *    failed fetch, so the player's retry path runs instead of a decode error.
 *
 * Sniffing is the exception, not the rule (PLAY-4). This route serves every
 * stream, not only an ani one, and before PLAY-3 it streamed the body straight
 * through. A body is only ever looked at when its upstream content type is
 * suspicious:
 *
 *  - missing, `image/*`, `text/html`, `application/octet-stream`,
 *    `binary/octet-stream` or `text/plain`, and the request is for a body whose
 *    first byte is meaningful (a full body, or a range starting at byte 0);
 *  - known length <= 2 MB: the whole body is buffered, which is cheap at that
 *    size and lets a relabel also correct `Content-Length`;
 *  - otherwise (unknown length, chunked transfer, or a larger body): at most the
 *    first 64 KB is read through a stream reader, and the rest keeps streaming
 *    with the bytes already read replayed in front, so memory stays bounded and
 *    no byte is lost or reordered.
 *
 * Everything else (`video/*`, `audio/*`, `application/vnd.apple.mpegurl`, any
 * trustworthy type, and any mid-file range) is streamed through untouched,
 * exactly as this route did before PLAY-3, apart from the CORS and cache
 * headers: no bytes are read before the Response is returned, so a correctly
 * labelled segment pays no extra time-to-first-byte.
 */

import { corsHeaders, proxyJson, verifyProxySignature, withDefaultUserAgent } from '@/lib/proxy-signing'

export const runtime = 'edge'

const PASSTHROUGH_HEADERS = ['Content-Length', 'Content-Range', 'Accept-Ranges']
/** A suspicious body up to this size is buffered; above it, only its prefix is read. */
const SNIFF_MAX_BYTES = 2 * 1024 * 1024
/** Hard cap on the bytes read before a large or chunked suspicious body starts streaming. */
const SNIFF_PREFIX_BYTES = 64 * 1024
/**
 * Both checks only need the start of the body: the sync byte, and the first
 * non-whitespace byte for the markup test. Reading stops there, which is why a
 * chunked error page still streams instead of being collected.
 */
const HTML_PROBE_BYTES = 64
const TS_SYNC_BYTE = 0x47
const DEFAULT_TS_TYPE = 'video/mp2t'
const SUSPICIOUS_TYPES = ['application/octet-stream', 'binary/octet-stream', 'text/plain']

/**
 * Byte ranges.
 *
 * A media element and hls.js send `Range` for a seek, and some CDN hosts ignore
 * it and answer 200 with the whole body (measured: one host returned all
 * 3,047,480 bytes for `Range: bytes=0-2000000`). Handing that 200 back to the
 * player breaks seeking and makes a native player believe the resource is not
 * seekable, so a single range is answered as a real 206: either passed through
 * from an upstream that honoured it, or sliced locally from the full body.
 *
 * Only `bytes=start-` and `bytes=start-end` are handled. Anything else (a
 * multi-range request) falls through to the previous behaviour untouched.
 */
const SINGLE_RANGE = /^bytes=(\d+)-(\d*)$/

function parseRange(value: string | null): { start: number; end: number | null } | null {
  if (!value) return null
  const match = value.trim().match(SINGLE_RANGE)
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] === '' ? null : Number(match[2])
  if (!Number.isFinite(start) || start < 0) return null
  if (end !== null && (!Number.isFinite(end) || end < start)) return null
  return { start, end }
}

/** Emits only `[start, end]` of the upstream body, then cancels the rest. */
function sliceStream(body: ReadableStream<Uint8Array>, start: number, end: number | null) {
  const reader = body.getReader()
  const wanted = end === null ? null : end - start + 1
  let skipped = 0
  let sent = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const step = await reader.read()
        if (step.done) {
          controller.close()
          return
        }
        let chunk = step.value
        if (!chunk || chunk.length === 0) continue
        if (skipped < start) {
          const needed = start - skipped
          if (chunk.length <= needed) {
            skipped += chunk.length
            continue
          }
          chunk = chunk.subarray(needed)
          skipped = start
        }
        if (wanted !== null) {
          const remaining = wanted - sent
          if (remaining <= 0) {
            await reader.cancel().catch(() => {})
            controller.close()
            return
          }
          if (chunk.length > remaining) chunk = chunk.subarray(0, remaining)
        }
        sent += chunk.length
        controller.enqueue(chunk)
        if (wanted !== null && sent >= wanted) {
          await reader.cancel().catch(() => {})
          controller.close()
        }
        return
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders() }) }

/** The media type without its parameters, so `text/html; charset=utf-8` matches. */
function mediaType(contentType: string) {
  return contentType.split(';')[0].trim().toLowerCase()
}

function isHtmlType(contentType: string) {
  const type = mediaType(contentType)
  return type === 'text/html' || type === 'application/xhtml+xml'
}

/**
 * A type worth looking at. `image/*` and the octet-stream aliases are AniKoto's
 * habit and a mislabelled CDN's habit; a missing type proves nothing either way.
 */
function isSuspiciousType(contentType: string) {
  const type = mediaType(contentType)
  if (!type) return true
  if (type.startsWith('image/')) return true
  if (isHtmlType(type)) return true
  return SUSPICIOUS_TYPES.includes(type)
}

/**
 * `null` when the header is absent or not a number. `Number('')` is 0, so the
 * old `Number.isFinite(Number(header ?? ''))` called an absent (chunked) length
 * a known one and buffered the entire body with no upper bound.
 */
function knownLength(value: string | null): number | null {
  const trimmed = value?.trim() ?? ''
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null
}

/** Leading whitespace ignored: a CDN often prefixes its error page with a newline. */
function looksLikeHtml(bytes: Uint8Array) {
  for (const byte of bytes.subarray(0, HTML_PROBE_BYTES)) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
    return byte === 0x3c // '<'
  }
  return false
}

function isTs(bytes: Uint8Array) {
  return bytes.length > 0 && bytes[0] === TS_SYNC_BYTE
}

function defaultType(targetUrl: string) {
  return targetUrl.toLowerCase().includes('.ts') ? DEFAULT_TS_TYPE : 'video/mp4'
}

/**
 * Reads just enough of the body to decide, and keeps every byte it consumed.
 * `head` is at most HTML_PROBE_BYTES; `tail` holds the rest in order, so the
 * replayed stream below is byte-for-byte the upstream body.
 */
async function readProbe(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  let done = false
  while (total < HTML_PROBE_BYTES && !done && total < SNIFF_PREFIX_BYTES) {
    const step = await reader.read()
    if (step.done) { done = true; break }
    if (!step.value || step.value.length === 0) continue
    parts.push(step.value)
    total += step.value.length
  }
  const head = new Uint8Array(Math.min(HTML_PROBE_BYTES, total))
  const tail: Uint8Array[] = []
  let filled = 0
  for (const part of parts) {
    if (filled >= head.length) { tail.push(part); continue }
    const take = Math.min(part.length, head.length - filled)
    head.set(part.subarray(0, take), filled)
    filled += take
    if (take < part.length) tail.push(part.subarray(take))
  }
  return { head, tail, reader, done }
}

/** The consumed prefix first, then the untouched remainder of the upstream body. */
function replay(head: Uint8Array, tail: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>, done: boolean) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length > 0) controller.enqueue(head)
      for (const part of tail) controller.enqueue(part)
      if (done) controller.close()
    },
    async pull(controller) {
      const step = await reader.read()
      if (step.done) { controller.close(); return }
      if (step.value && step.value.length > 0) controller.enqueue(step.value)
    },
    cancel(reason) { return reader.cancel(reason) },
  })
}

async function handleProxy(request: Request) {
  const params = new URL(request.url).searchParams
  const verified = await verifyProxySignature(params.get('u') ?? '', params.get('h') ?? '', params.get('e') ?? '', params.get('s') ?? '')
  if (!verified.valid || !verified.targetUrl || !verified.headers) return proxyJson({ error: 'INVALID_OR_EXPIRED_SIGNATURE' }, 403)
  const range = request.headers.get('Range')
  try {
    const upstreamHeaders = withDefaultUserAgent(verified.headers)
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
    // applies to a full body or a range that begins at byte 0. A 416 passes
    // through untouched: its body explains the bad range and the player recovers
    // from the status, not from a relabelled body.
    const fullBody = response.status !== 416 && (response.status === 200 || !range || /^bytes=0-/.test(range.trim()))
    const length = knownLength(response.headers.get('Content-Length'))
    const sniffable = fullBody && isSuspiciousType(upstreamType)

    // The default path, and the one every correctly typed segment takes: hand the
    // stream straight back without reading a byte of it.
    if (!sniffable) {
      headers.set('Content-Type', upstreamType || defaultType(verified.targetUrl))
      return new Response(response.body, { status: response.status, headers })
    }

    if (length !== null && length <= SNIFF_MAX_BYTES && response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer())

      // An HTML error page is never a segment. Reject it so the player retries
      // (and, for an ani stream, excludes the provider) instead of feeding markup
      // to the demuxer.
      if (isHtmlType(upstreamType) || looksLikeHtml(bytes)) {
        return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502)
      }

      // The sync byte decides, not the label: TS under `image/jpeg` (AniKoto) and
      // a mislabelled `application/octet-stream` are both real media.
      headers.set('Content-Type', isTs(bytes) ? DEFAULT_TS_TYPE : upstreamType || defaultType(verified.targetUrl))
      if (fullBody && bytes.length > 0) headers.set('Content-Length', String(bytes.length))

      return new Response(bytes, { status: response.status, headers })
    }

    // Unknown length (chunked) or a body larger than the buffer budget: read only
    // the probe, decide, and stream the rest with the consumed bytes replayed.
    if (!response.body) {
      headers.set('Content-Type', upstreamType || defaultType(verified.targetUrl))
      return new Response(null, { status: response.status, headers })
    }

    const probe = await readProbe(response.body)
    if (isHtmlType(upstreamType) || looksLikeHtml(probe.head)) {
      await probe.reader.cancel().catch(() => {})
      return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502)
    }

    headers.set('Content-Type', isTs(probe.head) ? DEFAULT_TS_TYPE : upstreamType || defaultType(verified.targetUrl))
    // Content-Length is only ever absent or larger than what was sniffed here, so
    // the passthrough value stays true and is left alone. Nothing is invented:
    // deciding whether the stream has ended would mean waiting for the next chunk.

    return new Response(replay(probe.head, probe.tail, probe.reader, probe.done), { status: response.status, headers })
  } catch { return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502) }
}

/**
 * Turns a 200 into a real 206 when the caller asked for a byte range.
 *
 * The previous code forwarded `Range` upstream and then returned whatever came
 * back. When the CDN honoured it that was already a 206 and stays untouched;
 * when the CDN ignored it (measured: one host answered `Range: bytes=0-2000000`
 * with all 3,047,480 bytes and status 200) the player was told the whole
 * resource was the answer, which breaks seeking and makes a native player
 * believe the resource is not seekable at all.
 *
 * Everything else is left exactly as it was: no Range, an unparseable range, a
 * 416, a 502, and every already-sniffed and relabelled body.
 */
function toPartial(response: Response, parsed: { start: number; end: number | null }) {
  const headers = new Headers(response.headers)
  const total = knownLength(headers.get('Content-Length'))
  const start = parsed.start

  if (total !== null && start >= total) {
    headers.set('Content-Range', `bytes */${total}`)
    headers.delete('Content-Length')
    return new Response(null, { status: 416, headers })
  }

  const end = parsed.end !== null
    ? (total !== null ? Math.min(parsed.end, total - 1) : parsed.end)
    : (total !== null ? total - 1 : null)

  headers.set('Content-Range', `bytes ${start}-${end !== null ? end : '*'}/${total !== null ? total : '*'}`)
  if (end !== null) headers.set('Content-Length', String(end - start + 1))
  if (!response.body) return new Response(null, { status: 206, headers })
  return new Response(sliceStream(response.body, start, end), { status: 206, headers })
}

export async function GET(request: Request) {
  const response = await handleProxy(request)
  const parsed = parseRange(request.headers.get('Range'))
  if (!parsed || response.status !== 200) return response
  return toPartial(response, parsed)
}
