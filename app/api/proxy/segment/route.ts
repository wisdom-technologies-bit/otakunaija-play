/**
 * Segment proxy (edge).
 *
 * Fetches the signed media URI with the signed headers and hands the bytes back
 * to the player.
 *
 * THE RULE: the BODY decides what a segment is, never the label.
 *
 * The AniKoto/MegaPlay CDN hosts rotate both the file extension and the
 * `Content-Type` of every segment while the bytes stay real MPEG-TS: measured on
 * 2026-11-21 for play_id 21-1180, `seg-f3-00001.html` answered HTTP 200 with
 * 931,164 bytes, `content-type: text/html`, and 0x47 at offsets 0, 188 and 376.
 * Index 2 came back as `application/javascript` and index 3 as `text/css`, both
 * real TS as well. Before this rule the label alone decided: `text/html` was
 * thrown away as an error page (so hls.js stalled at 00:03 with
 * `bufferSeekOverHole`) and `text/css` / `application/javascript` reached the
 * demuxer labelled as stylesheets.
 *
 * So a suspicious body is sniffed and accepted when its bytes say media:
 *
 *  - MPEG-TS: 0x47 at offset 0, and - once at least 189 bytes are in hand -
 *    again at offset 188 (the 188-byte packet sync). A range too short to reach
 *    offset 188 falls back to the first byte alone. Accepted bodies are
 *    relabelled `video/mp2t` whatever the upstream called them.
 *  - fragmented MP4 (`ftyp`/`styp`/`moof`/`sidx` at offset 4), relabelled
 *    `video/mp4`, if the route is ever handed one.
 *
 * A body is rejected only when it LOOKS like markup or JSON: the first
 * non-whitespace byte is `<`, or `{` / `[` followed by text. That is what a CDN
 * error page or an expired-token JSON answer looks like, and it is rejected as a
 * failed fetch so the player's retry path runs instead of the demuxer decoding
 * markup. The label is not consulted for that decision either: an error page is
 * refused under any `Content-Type`, and `text/html` on its own never rejects a
 * real segment.
 *
 * Sniffing is still the exception, not the rule (PLAY-4). A body is only ever
 * looked at when its upstream type is not one we trust as-is - anything that is
 * not `video/*`, `audio/*`, `application/vnd.apple.mpegurl`,
 * `application/x-mpegurl` or `video/mp2t`. That means the rotating `text/css`,
 * `application/javascript`, `image/*`, octet-stream, `text/plain` and missing
 * labels are all sniffed now, not just the image and octet-stream ones.
 *
 * The bounds are unchanged:
 *
 *  - a body is only sniffed when the request is for a body whose first byte is
 *    meaningful (a full body, or a range starting at byte 0);
 *  - known length <= 2 MB: the whole body is buffered, which is cheap at that
 *    size and lets a relabel also correct `Content-Length`;
 *  - otherwise (unknown length, chunked transfer, or a larger body): at most the
 *    first 512 bytes are read through a stream reader, and the rest keeps
 *    streaming with the bytes already read replayed in front, so memory stays
 *    bounded and no byte is lost or reordered;
 *  - a correctly typed `video/*` response still streams with zero reads before
 *    the Response is returned, so it pays no extra time-to-first-byte.
 *
 * A range from the middle of a file is never sniffed: its first byte is not a
 * sync byte and proves nothing.
 */

import { corsHeaders, proxyJson, verifyProxySignature, withDefaultUserAgent } from '@/lib/proxy-signing'

export const runtime = 'edge'

const PASSTHROUGH_HEADERS = ['Content-Length', 'Content-Range', 'Accept-Ranges']
/** A suspicious body up to this size is buffered; above it, only its prefix is read. */
const SNIFF_MAX_BYTES = 2 * 1024 * 1024
/** Hard cap on the bytes read before a large or chunked suspicious body starts streaming. */
const SNIFF_PREFIX_BYTES = 64 * 1024
/**
 * The probe has to reach offset 188 to confirm the second TS sync byte, so it is
 * 512 bytes: enough for both media checks, still tiny next to a 931 KB segment,
 * and reading stops there, which is why a chunked error page still streams
 * instead of being collected.
 */
const PROBE_BYTES = 512
const TS_SYNC_BYTE = 0x47
/** MPEG-TS repeats its sync byte every 188 bytes; offset 188 is the second one. */
const TS_SECOND_SYNC_OFFSET = 188
const DEFAULT_TS_TYPE = 'video/mp2t'
const DEFAULT_MP4_TYPE = 'video/mp4'
/** Box types a fragmented-MP4 segment can start with, read at offset 4. */
const FMP4_BOXES = ['ftyp', 'styp', 'moof', 'sidx']
/**
 * Types trusted as-is: never sniffed, never relabelled, streamed untouched. The
 * complement is what gets sniffed, so `text/css` and `application/javascript`
 * (two of the disguises) are looked at while a real `video/*` never is.
 */
const TRUSTED_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'video/mp2t']

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

/** A type whose bytes are believed without looking: no read, no relabel. */
function isTrustedType(contentType: string) {
  const type = mediaType(contentType)
  if (!type) return false
  if (type.startsWith('video/') || type.startsWith('audio/')) return true
  return TRUSTED_TYPES.includes(type)
}

/**
 * Everything we do not trust: `image/*`, `text/html`, `text/css`,
 * `application/javascript`, the octet-stream aliases, `text/plain`, JSON, and a
 * missing type. These hosts rotate through all of them, so the body decides.
 */
function isSuspiciousType(contentType: string) {
  return !isTrustedType(contentType)
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

function isWhitespace(byte: number) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

/**
 * Markup or JSON, judged by bytes alone: a CDN error page (`<!doctype`, `<html`,
 * or the same after leading whitespace) and an expired-token answer
 * (`{"error":...}`) both start this way. The label is irrelevant here, which is
 * the whole point: an error page is refused whatever type it claims.
 */
function looksLikeMarkup(bytes: Uint8Array) {
  let index = 0
  while (index < bytes.length && index < PROBE_BYTES && isWhitespace(bytes[index])) index += 1
  if (index >= bytes.length) return false
  const first = bytes[index]
  if (first === 0x3c) return true // '<'
  if (first !== 0x7b && first !== 0x5b) return false // '{' '['
  const next = bytes[index + 1]
  if (next === undefined) return false
  return isWhitespace(next) || (next >= 0x21 && next <= 0x7e)
}

/**
 * MPEG-TS: the sync byte, plus the second sync byte at offset 188 once enough of
 * the body is in hand. A range shorter than 189 bytes cannot reach it, so the
 * first byte alone has to do.
 */
function isMpegTs(bytes: Uint8Array) {
  if (bytes.length === 0 || bytes[0] !== TS_SYNC_BYTE) return false
  if (bytes.length <= TS_SECOND_SYNC_OFFSET) return true
  return bytes[TS_SECOND_SYNC_OFFSET] === TS_SYNC_BYTE
}

/** A fragmented-MP4 segment: a 4-byte box size then `ftyp`/`styp`/`moof`/`sidx`. */
function isFragmentedMp4(bytes: Uint8Array) {
  if (bytes.length < 8) return false
  const box = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7])
  return FMP4_BOXES.includes(box)
}

/**
 * The label to hand the player: the bytes win when they prove media, otherwise
 * the upstream label, otherwise a guess from the path.
 */
function responseType(bytes: Uint8Array, upstreamType: string, targetUrl: string) {
  if (isMpegTs(bytes)) return DEFAULT_TS_TYPE
  if (isFragmentedMp4(bytes)) return DEFAULT_MP4_TYPE
  return upstreamType || defaultType(targetUrl)
}

/**
 * Last resort only: no upstream label and a body that proves nothing. The
 * extension never decides whether a body is accepted, only this fallback label.
 */
function defaultType(targetUrl: string) {
  return targetUrl.toLowerCase().includes('.ts') ? DEFAULT_TS_TYPE : DEFAULT_MP4_TYPE
}

/**
 * Reads just enough of the body to decide, and keeps every byte it consumed.
 * `head` is at most PROBE_BYTES; `tail` holds the rest in order, so the
 * replayed stream below is byte-for-byte the upstream body.
 */
async function readProbe(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  let done = false
  while (total < PROBE_BYTES && !done && total < SNIFF_PREFIX_BYTES) {
    const step = await reader.read()
    if (step.done) { done = true; break }
    if (!step.value || step.value.length === 0) continue
    parts.push(step.value)
    total += step.value.length
  }
  const head = new Uint8Array(Math.min(PROBE_BYTES, total))
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

      // Markup is never a segment, whatever the label says. Reject it so the
      // player retries (and, for an ani stream, excludes the provider) instead of
      // feeding an error page to the demuxer.
      if (looksLikeMarkup(bytes)) {
        return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502)
      }

      // The bytes decide, not the label: TS under `text/html` (the measured
      // 931 KB segment), `text/css`, `application/javascript`, `image/jpeg` or
      // `application/octet-stream` is all real media and all becomes video/mp2t.
      headers.set('Content-Type', responseType(bytes, upstreamType, verified.targetUrl))
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
    if (looksLikeMarkup(probe.head)) {
      await probe.reader.cancel().catch(() => {})
      return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502)
    }

    headers.set('Content-Type', responseType(probe.head, upstreamType, verified.targetUrl))
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
