import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET } from '@/app/api/proxy/segment/route'
import { signProxyUrl } from '@/lib/proxy-signing'

/**
 * PART A — characterisation of the bug measured by the owner on 2026-11-21.
 *
 * The AniKoto/MegaPlay CDN disguises real MPEG-TS segments under rotating
 * extensions and labels: `seg-f3-00001.html` answered `HTTP 200`, 931,164 bytes
 * and `content-type: text/html`, and the body was real MPEG-TS (0x47 at offset
 * 0, 188, 376). Fetched directly with `Referer: https://megaplay.buzz/` the
 * bytes arrived; fetched through `/api/proxy/segment` the request failed.
 *
 * These tests describe what the route does TODAY, so the suite stays green while
 * the bug is pinned down in executable form. Every assertion in the
 * `text/html` and `text/css`/`application/javascript` groups is a defect and is
 * flipped by the Part B commit.
 *
 * The hang probes at the bottom answer one question: which upstream habit
 * reproduces the 20 s / 0 bytes the owner saw on a plain full GET.
 */

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

/** The size the CDN actually sent for play_id 21-1180, ani provider, index 1. */
const SEGMENT_BYTES = 931_164
const TS_SYNC = 0x47

/**
 * A body shaped like the CDN's: 188-byte TS packets, sync byte at 0, 188, 376
 * and every 188 bytes after that, filler that never looks like markup.
 */
function disguisedSegment(total = SEGMENT_BYTES): Uint8Array {
  const bytes = new Uint8Array(total)
  for (let index = 0; index < total; index += 1) {
    bytes[index] = index % 188 === 0 ? TS_SYNC : ((index * 7 + 11) % 251)
  }
  return bytes
}


/** Length plus a cheap checksum: comparing 931 KB element by element is slow. */
function fingerprint(bytes: Uint8Array) {
  let sum = 0
  for (let index = 0; index < bytes.length; index += 1) sum = (sum + bytes[index] * (index % 7 + 1)) % 1_000_003
  return { length: bytes.length, sum, first: bytes[0], at188: bytes[188], at376: bytes[376] }
}

const TARGET = 'https://seg1.mistyhorizon.space/anikoto/seg-f3-00001.html'
const HEADERS = { Referer: 'https://megaplay.buzz/' }

async function signedPath(url = TARGET) {
  return signProxyUrl(url, HEADERS, '/api/proxy/segment')
}

function call(path: string, init: { range?: string } = {}) {
  return GET(new Request(`https://play.otakunaija.test${path}`, {
    headers: init.range ? { Range: init.range } : {},
  }))
}

/** A stub CDN: one body, one label, an optional length, an optional status. */
function upstream(
  body: BodyInit | null,
  contentType: string | null,
  options: { status?: number; length?: number | null } = {},
) {
  const headers: Record<string, string> = {}
  if (contentType) headers['content-type'] = contentType
  if (options.length !== undefined && options.length !== null) headers['content-length'] = String(options.length)
  const mock = vi.fn(async () => new Response(body, { status: options.status ?? 200, headers }))
  globalThis.fetch = mock as unknown as typeof fetch
  return mock
}

beforeEach(() => {
  process.env = { ...originalEnv, PROXY_SIGNING_SECRET: 'test-secret' }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
})

describe('PART A: a real TS segment labelled text/html', () => {
  it('(a) with Content-Length, no Range: rejected as a failed fetch today', async () => {
    const body = disguisedSegment()
    upstream(body, 'text/html', { length: body.length })

    const response = await call(await signedPath())

    // The defect: the label alone decided, so 931 KB of real MPEG-TS was thrown
    // away and hls.js saw a failed fragment at 00:03.
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'UPSTREAM_FETCH_FAILED' })
  })

  it('(b) chunked, no Content-Length: rejected as a failed fetch today', async () => {
    const body = disguisedSegment()
    upstream(body, 'text/html', { length: null })

    const response = await call(await signedPath())

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'UPSTREAM_FETCH_FAILED' })
  })

  it('(c) with Range: bytes=0-1023: rejected as a failed fetch today', async () => {
    const body = disguisedSegment()
    upstream(body, 'text/html', { length: body.length })

    const response = await call(await signedPath(), { range: 'bytes=0-1023' })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'UPSTREAM_FETCH_FAILED' })
  })

  it('(d) plain full GET: answers with JSON, never with a media byte', async () => {
    const body = disguisedSegment()
    upstream(body, 'text/html', { length: body.length })

    const response = await call(await signedPath())

    expect(response.status).toBe(502)
    expect(response.headers.get('content-type')).toContain('application/json')
    const received = new Uint8Array(await response.arrayBuffer())
    expect(received[0]).not.toBe(TS_SYNC)
  })

  it('keeps CORS on the rejection, so the browser reads the real status', async () => {
    const body = disguisedSegment()
    upstream(body, 'text/html', { length: body.length })

    const response = await call(await signedPath())

    expect(response.status).toBe(502)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('PART A: a real TS segment labelled text/css or application/javascript', () => {
  it('passes text/css through untouched, still labelled text/css today', async () => {
    const body = disguisedSegment()
    upstream(body, 'text/css', { length: body.length })

    const response = await call(await signedPath('https://seg1.mistyhorizon.space/anikoto/seg-f3-00003.css'))

    // The defect: the body is real MPEG-TS but the player is told it is CSS, so
    // hls.js has to cope with a lie about the media type.
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/css')
    expect(fingerprint(new Uint8Array(await response.arrayBuffer()))).toEqual(fingerprint(body))
  })

  it('passes application/javascript through untouched today', async () => {
    const body = disguisedSegment()
    upstream(body, 'application/javascript', { length: body.length })

    const response = await call(await signedPath('https://seg1.mistyhorizon.space/anikoto/seg-f3-00002.js'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/javascript')
    expect(fingerprint(new Uint8Array(await response.arrayBuffer()))).toEqual(fingerprint(body))
  })
})

describe('PART A: the disguises that already work', () => {
  const accepted: Array<[string, string | null, string]> = [
    ['image/jpeg', 'image/jpeg', 'seg-f3-00000.jpg'],
    ['image/png', 'image/png', 'seg-f3-00004.png'],
    ['application/octet-stream', 'application/octet-stream', 'seg-f3-00005.bin'],
    ['no content-type at all', null, 'seg-f3-00006.dat'],
  ]

  it.each(accepted)('%s is accepted and relabelled video/mp2t', async (_label, contentType, name) => {
    const body = disguisedSegment()
    upstream(body, contentType, { length: body.length })

    const response = await call(await signedPath(`https://seg1.mistyhorizon.space/anikoto/${name}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp2t')
    expect(fingerprint(new Uint8Array(await response.arrayBuffer()))).toEqual(fingerprint(body))
  })
})

describe('PART A: bodies that must keep being rejected', () => {
  it('rejects a real HTML error page with a 200 and a text/html label', async () => {
    const html = '<!doctype html><html><head><title>403</title></head><body>Forbidden</body></html>'
    upstream(html, 'text/html', { length: html.length })

    const response = await call(await signedPath())

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'UPSTREAM_FETCH_FAILED' })
  })

  it('rejects a real HTML error page served with 403 by the CDN', async () => {
    const html = '<html><body>hotlink blocked</body></html>'
    upstream(html, 'text/html', { status: 403, length: html.length })

    const response = await call(await signedPath())

    expect(response.status).toBe(502)
  })

  it('rejects an error page that starts with whitespace then markup', async () => {
    const html = '\n\t  <html><body>expired token</body></html>'
    upstream(html, 'text/plain', { length: html.length })

    const response = await call(await signedPath())

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'UPSTREAM_FETCH_FAILED' })
  })

  it('rejects a JSON error body', async () => {
    const json = '{"error":"UPSTREAM_FETCH_FAILED","detail":"signed url expired"}'
    upstream(json, 'application/json', { length: json.length })

    const response = await call(await signedPath())

    // Today an application/json label is not suspicious at all, so the error
    // document is handed to the demuxer as if it were media. The Part B commit
    // makes the body decide and rejects this.
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
  })
})

/**
 * The 20 s / 0 bytes hang.
 *
 * Four upstream habits are tried against the same 931 KB html-labelled TS body.
 * A request counts as hung when it has not produced a Response after 400 ms,
 * which is far longer than the ~1 s the CDN took to answer in full.
 */
describe('PART A: which upstream habit reproduces the 20 s hang', () => {
  /** A body the test drives by hand: it sends what it is given and then waits. */
  function manualStream() {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    const body = new ReadableStream<Uint8Array>({
      start(streamController) { controller = streamController },
    }, { highWaterMark: 0 })
    return {
      body,
      push: (chunk: Uint8Array) => controller?.enqueue(chunk),
      close: () => { try { controller?.close() } catch { /* already closed */ } },
    }
  }

  /** `settled: false` means no Response within `budgetMs`. */
  async function settlesWithin(promise: Promise<Response>, budgetMs = 400) {
    return Promise.race([
      promise.then((response) => ({ settled: true as const, status: response.status })),
      new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), budgetMs)),
    ])
  }

  it('does NOT reproduce it: a Content-Length larger than the body ends at the stream end', async () => {
    const partial = disguisedSegment(5_000)
    const stream = manualStream()
    upstream(stream.body, 'text/html', { length: SEGMENT_BYTES })
    stream.push(partial)
    stream.close()

    const outcome = await settlesWithin(call(await signedPath()))

    // The in-process Response is not a socket: `arrayBuffer()` stops at the end
    // of the stream and never waits for the promised Content-Length.
    expect(outcome).toEqual({ settled: true, status: 502 })
  })

  it('REPRODUCES it: the body stalls after N bytes on the buffered path', async () => {
    const stream = manualStream()
    upstream(stream.body, 'text/html', { length: SEGMENT_BYTES })
    stream.push(disguisedSegment(5_000))

    const pending = call(await signedPath())
    const outcome = await settlesWithin(pending)

    // `await response.arrayBuffer()` has no stall timeout, so the route waits for
    // 931,164 bytes that never arrive and the client receives nothing at all.
    expect(outcome).toEqual({ settled: false })

    stream.close()
    await pending
  })

  it('REPRODUCES it: a slow trickle keeps the client waiting for minutes', async () => {
    const stream = manualStream()
    upstream(stream.body, 'text/html', { length: SEGMENT_BYTES })
    stream.push(disguisedSegment(1_024))

    const pending = call(await signedPath())
    const outcome = await settlesWithin(pending)

    // 931 KB at a trickle is the same 0 bytes from the player's point of view:
    // the buffered path answers only once the whole body is in memory.
    expect(outcome).toEqual({ settled: false })

    stream.close()
    await pending
  })

  it('REPRODUCES it: headers arrive and the body never sends a byte', async () => {
    const stream = manualStream()
    upstream(stream.body, 'text/html', { length: SEGMENT_BYTES })

    const pending = call(await signedPath())
    const outcome = await settlesWithin(pending)

    expect(outcome).toEqual({ settled: false })

    stream.close()
    await pending
  })

  it('does NOT reproduce it: a keep-alive chunked body that never closes answers from the probe', async () => {
    const stream = manualStream()
    upstream(stream.body, 'text/html', { length: null })
    stream.push(disguisedSegment(16 * 1_024))

    const outcome = await settlesWithin(call(await signedPath()))

    // Without a Content-Length the route only needs the 64-byte probe, and the
    // html label rejects it as soon as the probe is in: no wait for the close.
    expect(outcome).toEqual({ settled: true, status: 502 })

    stream.close()
  })
})
