import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET } from '@/app/api/proxy/segment/route'
import { signProxyUrl } from '@/lib/proxy-signing'

/**
 * PART B — the body decides what a segment is, never the label.
 *
 * Measured by the owner on 2026-11-21 (play_id 21-1180, ani provider): the
 * AniKoto/MegaPlay CDN serves real MPEG-TS under rotating extensions AND
 * rotating labels. `seg-f3-00001.html` answered 200 with 931,164 bytes of real
 * TS and `content-type: text/html`; index 2 was `application/javascript`, index
 * 3 `text/css`, all real TS. Every case below is one of those disguises, and
 * every one must now be accepted, relabelled `video/mp2t`, and delivered byte
 * for byte. A body that looks like markup or JSON is still refused, under any
 * label, and the 502 keeps its CORS headers so the browser sees the real status.
 */

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

/** The size the CDN actually sent for play_id 21-1180, ani provider, index 1. */
const SEGMENT_BYTES = 931_164
const TS_SYNC = 0x47
const HOST = 'https://seg1.mistyhorizon.space/anikoto'

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

const HEADERS = { Referer: 'https://megaplay.buzz/' }

async function signedPath(url: string) {
  return signProxyUrl(url, HEADERS, '/api/proxy/segment')
}

function call(path: string, init: { range?: string } = {}) {
  return GET(new Request(`https://play.otakunaija.test${path}`, {
    headers: init.range ? { Range: init.range } : {},
  }))
}

/** A stub CDN that answers exactly the headers it is given. */
function upstreamRaw(body: BodyInit | null, headers: Record<string, string>, status = 200) {
  const mock = vi.fn(async () => new Response(body, { status, headers }))
  globalThis.fetch = mock as unknown as typeof fetch
  return mock
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

describe('PART B: a real TS segment under every disguise is accepted and relabelled', () => {
  const disguises: Array<[string, string | null, string]> = [
    ['text/html (the measured index 1)', 'text/html', 'seg-f3-00001.html'],
    ['text/html with a charset', 'text/html; charset=utf-8', 'seg-f3-00001.html'],
    ['application/javascript (index 2)', 'application/javascript', 'seg-f3-00002.js'],
    ['text/javascript', 'text/javascript', 'seg-f3-00002.js'],
    ['application/x-javascript', 'application/x-javascript', 'seg-f3-00002.js'],
    ['text/css (index 3)', 'text/css', 'seg-f3-00003.css'],
    ['image/jpeg (index 0)', 'image/jpeg', 'seg-f3-00000.jpg'],
    ['image/png', 'image/png', 'seg-f3-00004.png'],
    ['image/webp', 'image/webp', 'seg-f3-00005.webp'],
    ['application/octet-stream', 'application/octet-stream', 'seg-f3-00006.bin'],
    ['text/plain', 'text/plain', 'seg-f3-00007.txt'],
    ['no content-type at all', null, 'seg-f3-00008.dat'],
    ['application/json', 'application/json', 'seg-f3-00009.json'],
  ]

  it.each(disguises)('%s: 200, video/mp2t, every byte intact', async (_label, contentType, name) => {
    const body = disguisedSegment()
    upstream(body, contentType, { length: body.length })

    const response = await call(await signedPath(`${HOST}/${name}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp2t')
    expect(response.headers.get('content-length')).toBe(String(body.length))
    const received = new Uint8Array(await response.arrayBuffer())
    expect(fingerprint(received)).toEqual(fingerprint(body))
  })

  it('accepts the same body with no Content-Length (chunked), bounded to the probe', async () => {
    const body = disguisedSegment()
    upstream(body, 'text/html', { length: null })

    const response = await call(await signedPath(`${HOST}/seg-f3-00001.html`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp2t')
    // No upstream length, so none is invented.
    expect(response.headers.get('content-length')).toBeNull()
    expect(fingerprint(new Uint8Array(await response.arrayBuffer()))).toEqual(fingerprint(body))
  })

  it('still relabels a fragmented-MP4 body disguised as html', async () => {
    const body = new Uint8Array(4096)
    body.set([0x00, 0x00, 0x00, 0x18, 0x73, 0x74, 0x79, 0x70, 0x6d, 0x73, 0x64, 0x68])
    upstream(body, 'text/html', { length: body.length })

    const response = await call(await signedPath(`${HOST}/seg-f3-00010.html`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body)
  })

  it('leaves the label alone when the body proves nothing either way', async () => {
    // 0x47 at offset 0 but not at 188: not TS, not markup. The route has no
    // evidence to relabel it, so the upstream label is kept rather than invented.
    const body = new Uint8Array(1024)
    body[0] = 0x47
    for (let index = 1; index < body.length; index += 1) body[index] = 0x11
    upstream(body, 'application/octet-stream', { length: body.length })

    const response = await call(await signedPath(`${HOST}/seg-f3-00011.bin`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
  })
})

describe('PART B: ranges on an html-labelled TS body', () => {
  it('answers Range: bytes=0-1023 with 206, video/mp2t and a real Content-Range', async () => {
    const body = disguisedSegment()
    // The CDN ignores Range and answers 200 with the whole segment, which is what
    // the owner measured; the proxy slices it locally.
    upstream(body, 'text/html', { length: body.length })

    const response = await call(await signedPath(`${HOST}/seg-f3-00001.html`), { range: 'bytes=0-1023' })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('video/mp2t')
    expect(response.headers.get('content-range')).toBe(`bytes 0-1023/${body.length}`)
    expect(response.headers.get('content-length')).toBe('1024')
    const received = new Uint8Array(await response.arrayBuffer())
    expect(received.length).toBe(1024)
    expect(received[0]).toBe(TS_SYNC)
    expect(received[188]).toBe(TS_SYNC)
  })

  it('answers Range: bytes=0- with 206 to the end of the segment', async () => {
    const body = disguisedSegment(188 * 40)
    upstream(body, 'text/html', { length: body.length })

    const response = await call(await signedPath(`${HOST}/seg-f3-00001.html`), { range: 'bytes=0-' })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('video/mp2t')
    expect(response.headers.get('content-range')).toBe(`bytes 0-${body.length - 1}/${body.length}`)
    expect(fingerprint(new Uint8Array(await response.arrayBuffer()))).toEqual(fingerprint(body))
  })

  it('keeps an upstream 206 and its own Content-Range, relabelled', async () => {
    const body = disguisedSegment(188 * 40)
    upstreamRaw(body, {
      'content-type': 'text/html',
      'content-length': String(body.length),
      'content-range': `bytes 0-${body.length - 1}/${body.length}`,
    }, 206)

    const response = await call(await signedPath(`${HOST}/seg-f3-00001.html`), { range: 'bytes=0-' })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('video/mp2t')
    expect(response.headers.get('content-range')).toBe(`bytes 0-${body.length - 1}/${body.length}`)
  })

  it('accepts a range too short to reach offset 188 on the first byte alone', async () => {
    const body = disguisedSegment(188 * 4)
    upstreamRaw(body.subarray(0, 100), {
      'content-type': 'text/html',
      'content-length': '100',
      'content-range': `bytes 0-99/${body.length}`,
    }, 206)

    const response = await call(await signedPath(`${HOST}/seg-f3-00001.html`), { range: 'bytes=0-99' })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('video/mp2t')
    expect(response.headers.get('content-length')).toBe('100')
  })
})

describe('PART B: bodies that must keep being rejected', () => {
  const markup: Array<[string, string, string]> = [
    ['a doctype page', 'text/html', '<!doctype html><html><body>403 Forbidden</body></html>'],
    ['a bare html page', 'text/html', '<html><head><title>expired</title></head></html>'],
    ['markup after whitespace', 'text/plain', '\n\t  <html><body>expired token</body></html>'],
    ['a comment then markup', 'application/octet-stream', '<!-- gone --><html><body>expired</body></html>'],
    ['markup under a media label', 'image/jpeg', '<!DOCTYPE html><html><body>hotlink blocked</body></html>'],
    ['markup under text/css', 'text/css', '<!doctype html><html><body>not here</body></html>'],
  ]

  it.each(markup)('rejects %s as a failed fetch', async (_name, contentType, html) => {
    upstream(html, contentType, { length: html.length })

    const response = await call(await signedPath(`${HOST}/seg-f3-00001.html`))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'UPSTREAM_FETCH_FAILED' })
    // CORS on the 502, or the browser reports a CORS failure instead of the code.
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('rejects a JSON error body instead of handing it to the demuxer', async () => {
    const json = '{"error":"UPSTREAM_FETCH_FAILED","detail":"signed url expired"}'
    upstream(json, 'application/json', { length: json.length })

    const response = await call(await signedPath(`${HOST}/seg-f3-00001.html`))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'UPSTREAM_FETCH_FAILED' })
  })

  it('rejects a JSON array error body', async () => {
    const json = '[{"error":"gone"}]'
    upstream(json, 'text/html', { length: json.length })

    const response = await call(await signedPath(`${HOST}/seg-f3-00001.html`))

    expect(response.status).toBe(502)
  })

  it('rejects an html error page the CDN serves with a 403', async () => {
    const html = '<html><body>hotlink blocked</body></html>'
    upstream(html, 'text/html', { status: 403, length: html.length })

    const response = await call(await signedPath(`${HOST}/seg-f3-00001.html`))

    expect(response.status).toBe(502)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('rejects markup inside a chunked body, from the probe alone', async () => {
    const html = new TextEncoder().encode('\n  <html><body>expired</body></html>')
    upstream(html, 'application/javascript', { length: null })

    const response = await call(await signedPath(`${HOST}/seg-f3-00002.js`))

    expect(response.status).toBe(502)
  })
})

describe('PART B: a type we trust is still never read before answering', () => {
  it('streams video/mp2t with zero bytes read, whatever the body is', async () => {
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1
        controller.enqueue(new Uint8Array([TS_SYNC]))
        controller.close()
      },
    }, { highWaterMark: 0 })
    upstream(body, 'video/mp2t', { length: null })

    const response = await call(await signedPath(`${HOST}/seg-f3-00000.jpg`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp2t')
    expect(reads).toBe(0)
  })
})
