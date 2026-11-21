import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET as getSegment } from '@/app/api/proxy/segment/route'
import { GET as getManifest } from '@/app/api/proxy/manifest/route'
import { GET as getSubtitle } from '@/app/api/proxy/subtitle/route'
import { GET as getAniSubtitle } from '@/app/api/proxy/ani-subtitle/route'
import { __resetAniState } from '@/lib/ani/client'
import { UPSTREAM_TIMEOUTS } from '@/lib/proxy-upstream'
import { signAniSubtitlePath, signProxyUrl } from '@/lib/proxy-signing'
import { ANI_BASE, ANI_ENV, MAL_ID, aniStreamPayload } from './fixtures/ani'

/**
 * PART C — never hang.
 *
 * On 2026-11-21 a plain full GET of one 931 KB segment through
 * `/api/proxy/segment` sat for 20 s with 0 bytes received and no error: the CDN
 * had answered the headers and then stopped sending, and neither the fetch nor
 * the body read had a deadline. Every upstream call now has one:
 *
 *  - ~10 s to the response headers (AbortController, per attempt);
 *  - ~15 s with no body bytes;
 *  - ONE retry for a timeout, a network error or an upstream 5xx, never a 4xx;
 *  - a fast, CORS-carrying 504 (`UPSTREAM_TIMEOUT`) or 502 on final failure.
 *
 * The bounds are shrunk to tens of milliseconds here so the behaviour is proved
 * without waiting for the real ones; production keeps the defaults.
 */

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
const originalTimeouts = { ...UPSTREAM_TIMEOUTS }

const FAST = { headersMs: 60, stallMs: 60, retries: 1 }
const SEGMENT_TARGET = 'https://seg1.mistyhorizon.space/anikoto/seg-f3-00001.html'
const HEADERS = { Referer: 'https://megaplay.buzz/' }

/** Genuine 188-byte TS packets. */
function tsChunk(total = 188 * 4): Uint8Array {
  const bytes = new Uint8Array(total)
  for (let index = 0; index < total; index += 1) bytes[index] = index % 188 === 0 ? 0x47 : index % 251
  return bytes
}

/** An upstream that accepts the connection and never answers at all. */
function neverAnswers() {
  const mock = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  }))
  globalThis.fetch = mock as unknown as typeof fetch
  return mock
}

/** An upstream that answers the headers and then never sends a body byte. */
function headersThenStall(headers: Record<string, string> = { 'content-type': 'text/html', 'content-length': '931164' }) {
  const mock = vi.fn(async () => new Response(
    new ReadableStream<Uint8Array>({ start() { /* never enqueues, never closes */ } }, { highWaterMark: 0 }),
    { headers },
  ))
  globalThis.fetch = mock as unknown as typeof fetch
  return mock
}

/** An upstream that sends one chunk and then goes silent. */
function oneChunkThenStall(chunk: Uint8Array, headers: Record<string, string>) {
  const mock = vi.fn(async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(chunk) },
    }, { highWaterMark: 0 }),
    { headers },
  ))
  globalThis.fetch = mock as unknown as typeof fetch
  return mock
}

function stubFetch(handler: () => Promise<Response> | Response) {
  const mock = vi.fn(async () => handler())
  globalThis.fetch = mock as unknown as typeof fetch
  return mock
}

async function segmentPath() {
  return signProxyUrl(SEGMENT_TARGET, HEADERS, '/api/proxy/segment')
}

async function callSegment(init: { range?: string } = {}) {
  const path = await segmentPath()
  return getSegment(new Request(`https://play.otakunaija.test${path}`, {
    headers: init.range ? { Range: init.range } : {},
  }))
}

async function timed<T>(run: () => Promise<T>) {
  const started = Date.now()
  const value = await run()
  return { value, elapsed: Date.now() - started }
}

beforeEach(() => {
  process.env = { ...originalEnv, PROXY_SIGNING_SECRET: 'test-secret' }
  Object.assign(UPSTREAM_TIMEOUTS, FAST)
  __resetAniState()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
  Object.assign(UPSTREAM_TIMEOUTS, originalTimeouts)
  vi.restoreAllMocks()
  __resetAniState()
})

describe('PART C: the segment proxy fails fast instead of hanging', () => {
  it('answers 504 when the upstream never sends headers, after exactly one retry', async () => {
    const mock = neverAnswers()

    const { value: response, elapsed } = await timed(() => callSegment())

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: 'UPSTREAM_TIMEOUT' })
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(mock).toHaveBeenCalledTimes(2)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('answers 504 when the headers arrive and the body stalls (the 20 s case)', async () => {
    const mock = headersThenStall()

    const { value: response, elapsed } = await timed(() => callSegment())

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: 'UPSTREAM_TIMEOUT' })
    expect(mock).toHaveBeenCalledTimes(2)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('answers 504 when the body stalls after N bytes on the buffered path', async () => {
    const mock = oneChunkThenStall(tsChunk(5_000), { 'content-type': 'text/html', 'content-length': '931164' })

    const { value: response, elapsed } = await timed(() => callSegment())

    expect(response.status).toBe(504)
    expect(mock).toHaveBeenCalledTimes(2)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('answers 504 when a chunked body stalls before the probe is full', async () => {
    const mock = oneChunkThenStall(tsChunk(16), { 'content-type': 'text/html' })

    const { value: response, elapsed } = await timed(() => callSegment())

    expect(response.status).toBe(504)
    expect(mock).toHaveBeenCalledTimes(2)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('recovers when the retry answers, so one stalled attempt costs no playback', async () => {
    let attempt = 0
    stubFetch(async () => {
      attempt += 1
      if (attempt === 1) throw new TypeError('fetch failed')
      const body = tsChunk()
      return new Response(body, { headers: { 'content-type': 'text/html', 'content-length': String(body.length) } })
    })

    const response = await callSegment()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp2t')
    expect(attempt).toBe(2)
  })

  it('retries an upstream 5xx once, then reports a 502', async () => {
    const mock = stubFetch(async () => new Response('', { status: 503 }))

    const response = await callSegment()

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'UPSTREAM_FETCH_FAILED' })
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('never retries a 4xx: the CDN meant it', async () => {
    const mock = stubFetch(async () => new Response('', { status: 403 }))

    const response = await callSegment()

    expect(response.status).toBe(502)
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('never retries a 416', async () => {
    const mock = stubFetch(async () => new Response(null, { status: 416, headers: { 'content-range': 'bytes */500' } }))

    const response = await callSegment({ range: 'bytes=900-' })

    expect(response.status).toBe(416)
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('ends a passthrough stream that stalls after the Response went out', async () => {
    // A trusted type is handed over before any read, so the status cannot change:
    // the stall ends the stream with an error and hls.js retries the fragment.
    stubFetch(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(tsChunk(188)) },
      }, { highWaterMark: 0 }),
      { headers: { 'content-type': 'video/mp2t', 'content-length': '100000' } },
    ))

    const response = await callSegment()
    expect(response.status).toBe(200)

    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    await expect(reader.read()).rejects.toThrow(/no body bytes/)
  })

  it('logs host and path only, never the signed url', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    neverAnswers()

    await callSegment()

    expect(warn).toHaveBeenCalled()
    const logged = warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
    expect(logged).toContain('seg1.mistyhorizon.space/anikoto/seg-f3-00001.html')
    expect(logged).not.toContain('u=')
    expect(logged).not.toContain('s=')
    expect(logged).not.toContain('?')
  })
})

describe('PART C: the manifest and subtitle proxies fail fast too', () => {
  it('manifest: 504 with CORS when the upstream never answers', async () => {
    const mock = neverAnswers()
    const path = await signProxyUrl('https://cdn.example/master.m3u8', {}, '/api/proxy/manifest')

    const { value: response, elapsed } = await timed(() => getManifest(new Request(`https://play.test${path}`)))

    expect(response.status).toBe(504)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(mock).toHaveBeenCalledTimes(2)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('manifest: 504 when the headers arrive and the body stalls', async () => {
    headersThenStall({ 'content-type': 'application/vnd.apple.mpegurl' })
    const path = await signProxyUrl('https://cdn.example/master.m3u8', {}, '/api/proxy/manifest')

    const response = await getManifest(new Request(`https://play.test${path}`))

    expect(response.status).toBe(504)
  })

  it('subtitle: 504 with CORS when the upstream never answers', async () => {
    const mock = neverAnswers()
    const path = await signProxyUrl('https://cdn.example/sub.vtt', {}, '/api/proxy/subtitle')

    const response = await getSubtitle(new Request(`https://play.test${path}`))

    expect(response.status).toBe(504)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('subtitle: 504 when the body stalls mid-track', async () => {
    headersThenStall({ 'content-type': 'text/vtt' })
    const path = await signProxyUrl('https://cdn.example/sub.vtt', {}, '/api/proxy/subtitle')

    const response = await getSubtitle(new Request(`https://play.test${path}`))

    expect(response.status).toBe(504)
  })
})

describe('PART C: the ani-subtitle proxy fails fast too', () => {
  const TOKEN = { mal: MAL_ID, ep: 1, audio: 'sub' as const, trackId: 'sub-1' }

  async function aniPath() {
    for (const [key, value] of Object.entries({ ...ANI_ENV, PROXY_SIGNING_SECRET: 'test-secret' })) process.env[key] = value
    return signAniSubtitlePath(TOKEN)
  }

  it('504 with CORS when the track never answers', async () => {
    const path = await aniPath()
    // The ani-api itself answers; the track fetch is the one that never does.
    let calls = 0
    globalThis.fetch = vi.fn((url: unknown, init?: RequestInit) => {
      if (String(url).startsWith(`${ANI_BASE}/v1/streams`)) return Promise.resolve(Response.json(aniStreamPayload()))
      calls += 1
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }) as unknown as typeof fetch

    const response = await getAniSubtitle(new Request(`https://play.test${path}`))

    expect(response.status).toBe(504)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(calls).toBe(2)
  })

  it('504 when the track answers the headers and then stalls', async () => {
    const path = await aniPath()
    globalThis.fetch = vi.fn((url: unknown) => {
      if (String(url).startsWith(`${ANI_BASE}/v1/streams`)) return Promise.resolve(Response.json(aniStreamPayload()))
      return Promise.resolve(new Response(
        new ReadableStream<Uint8Array>({ start() {} }, { highWaterMark: 0 }),
        { headers: { 'content-type': 'text/vtt' } },
      ))
    }) as unknown as typeof fetch

    const response = await getAniSubtitle(new Request(`https://play.test${path}`))

    expect(response.status).toBe(504)
  })
})
