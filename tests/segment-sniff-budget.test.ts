import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET } from '@/app/api/proxy/segment/route'
import { signProxyUrl } from '@/lib/proxy-signing'

/**
 * PLAY-4: `/api/proxy/segment` serves every stream, not only an ani one, so
 * sniffing must be the exception. A body is only looked at when its upstream
 * content type is suspicious, the buffer budget is 2 MB, and an unknown or too
 * large body is decided from at most a 64 KB prefix that is then replayed in
 * front of the untouched remainder.
 *
 * Every test below also guards the memory ceiling: `sent()` counts the bytes the
 * route actually pulled from the upstream body before it returned a Response.
 */

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

const MIB = 1024 * 1024
const PREFIX_CEILING = 64 * 1024

/** 188-byte TS packets: 0x47 then filler. */
function tsBody(packets = 3): Uint8Array {
  const bytes = new Uint8Array(188 * packets)
  for (let packet = 0; packet < packets; packet += 1) {
    bytes[packet * 188] = 0x47
    for (let index = 1; index < 188; index += 1) bytes[packet * 188 + index] = index % 251
  }
  return bytes
}

/** An MP4-ish body: not TS, not markup. */
function mp4Body(bytes = 4096): Uint8Array {
  const body = new Uint8Array(bytes)
  body.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
  return body
}

type Instrumented = {
  body: ReadableStream<Uint8Array>
  /** Bytes the route pulled out of this stream so far. */
  sent: () => number
  /** How many chunks were read. */
  pulls: () => number
}

/**
 * A generated stream that only produces a chunk when it is asked for, so a
 * consumer that buffers shows up as a large `sent()`.
 */
function instrumented(totalBytes: number, chunkSize: number, fill: (offset: number) => number): Instrumented {
  let sentBytes = 0
  let pullsCount = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sentBytes >= totalBytes) { controller.close(); return }
      pullsCount += 1
      const size = Math.min(chunkSize, totalBytes - sentBytes)
      const chunk = new Uint8Array(size)
      for (let index = 0; index < size; index += 1) chunk[index] = fill(sentBytes + index)
      sentBytes += size
      controller.enqueue(chunk)
    },
  },
  // No pre-pull: a chunk is produced only when the route actually asks for one,
  // so `sent()` measures real reads rather than queue filling.
  { highWaterMark: 0 })
  return { body, sent: () => sentBytes, pulls: () => pullsCount }
}

function upstream(body: BodyInit | ReadableStream<Uint8Array>, headers: Record<string, string>, status = 200) {
  const mock = vi.fn(async () => new Response(body as BodyInit, { status, headers }))
  globalThis.fetch = mock as unknown as typeof fetch
  return mock
}

async function signedPath(url: string, headers: Record<string, string> = {}) {
  return signProxyUrl(url, headers, '/api/proxy/segment')
}

function call(path: string, init: { range?: string } = {}) {
  return GET(new Request(`https://play.otakunaija.test${path}`, {
    headers: init.range ? { Range: init.range } : {},
  }))
}

async function drain(response: Response) {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const step = await reader.read()
    if (step.done) break
    if (step.value) chunks.push(step.value)
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length }
  return joined
}

/** Drains without keeping the bytes, for bodies too big to hold in a test. */
async function drainCount(response: Response) {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  let total = 0
  let firstByte = -1
  for (;;) {
    const step = await reader.read()
    if (step.done) break
    if (step.value && step.value.length > 0) {
      if (firstByte < 0) firstByte = step.value[0]
      total += step.value.length
    }
  }
  return { total, firstByte }
}

beforeEach(() => {
  process.env = { ...originalEnv, PROXY_SIGNING_SECRET: 'test-secret' }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
})

describe('PLAY-4: a correctly typed segment is never buffered', () => {
  it('returns video/mp2t as a stream and reads nothing before the Response', async () => {
    const total = 512 * 1024
    const source = instrumented(total, 16 * 1024, (offset) => (offset % 188 === 0 ? 0x47 : offset % 251))
    upstream(source.body, { 'content-type': 'video/mp2t', 'content-length': String(total) })

    const response = await call(await signedPath('https://cdn.example/anivexa/0001.ts'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp2t')
    // The whole point of PLAY-4: a 512 KB segment must not be downloaded before
    // the player gets its first byte.
    expect(source.sent()).toBe(0)
    expect(source.pulls()).toBe(0)
    expect(response.body).not.toBeNull()

    const { total: received, firstByte } = await drainCount(response)
    expect(received).toBe(total)
    expect(firstByte).toBe(0x47)
    // Streamed, chunk by chunk, rather than handed over as one blob.
    expect(source.pulls()).toBeGreaterThan(1)
  })

  it('streams a chunked 50 MB mp4 with no length and keeps memory bounded', async () => {
    const total = 50 * MIB
    const source = instrumented(total, PREFIX_CEILING, (offset) => (offset < 12 ? [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d][offset] : 0x21))
    upstream(source.body, { 'content-type': 'video/mp4' })

    const response = await call(await signedPath('https://cdn.example/movie.mp4'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    // No Content-Length upstream, so none may be invented.
    expect(response.headers.get('content-length')).toBeNull()
    expect(source.sent()).toBeLessThanOrEqual(PREFIX_CEILING)
    expect(source.sent()).toBe(0)

    const { total: received } = await drainCount(response)
    expect(received).toBe(total)
  })

  it('never sniffs a range from the middle of a file', async () => {
    const source = instrumented(2048, 512, () => 0x11)
    upstream(source.body, {
      'content-type': 'image/jpeg',
      'content-length': '2048',
      'content-range': 'bytes 500000-502047/900000',
    }, 206)

    const response = await call(await signedPath('https://seg1.example/seg-9-v1-a1.jpg'), { range: 'bytes=500000-502047' })

    expect(response.status).toBe(206)
    expect(source.sent()).toBe(0)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(response.headers.get('content-range')).toBe('bytes 500000-502047/900000')
    expect(response.headers.get('content-length')).toBe('2048')
    expect((await drain(response)).length).toBe(2048)
  })

  it('leaves Content-Length and Content-Range alone on a pass-through range', async () => {
    const body = mp4Body(1024)
    upstream(body, {
      'content-type': 'video/mp4',
      'content-length': '1024',
      'content-range': 'bytes 0-1023/4096',
      'accept-ranges': 'bytes',
    }, 206)

    const response = await call(await signedPath('https://cdn.example/movie.mp4'), { range: 'bytes=0-' })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-length')).toBe('1024')
    expect(response.headers.get('content-range')).toBe('bytes 0-1023/4096')
    expect(response.headers.get('access-control-expose-headers')).toBe('Content-Length, Content-Range, Accept-Ranges')
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body)
  })

  it('passes a 416 through so the player can recover, even as HTML', async () => {
    const body = '<html><body>range not satisfiable</body></html>'
    upstream(body, { 'content-type': 'text/html', 'content-length': String(body.length) }, 416)

    const response = await call(await signedPath('https://cdn.example/movie.mp4'), { range: 'bytes=99999999-' })

    expect(response.status).toBe(416)
    expect(response.headers.get('content-type')).toBe('text/html')
  })

  it('does not read an audio or playlist body either', async () => {
    for (const type of ['audio/mpeg', 'application/vnd.apple.mpegurl']) {
      const source = instrumented(64 * 1024, 8 * 1024, () => 0x2a)
      upstream(source.body, { 'content-type': type })
      const response = await call(await signedPath('https://cdn.example/asset'))
      expect(response.headers.get('content-type')).toBe(type)
      expect(source.sent()).toBe(0)
    }
  })
})

describe('PLAY-4: small suspicious bodies stay buffered and sniffed', () => {
  it('relabels image/jpeg + 0x47 to video/mp2t', async () => {
    const body = tsBody()
    upstream(body, { 'content-type': 'image/jpeg', 'content-length': String(body.length) })

    const response = await call(await signedPath('https://seg1.example/anikoto/seg-1-v1-a1.jpg'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp2t')
    expect(response.headers.get('content-length')).toBe(String(body.length))
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body)
  })

  it('relabels application/octet-stream + 0x47 with no length, bounded to a prefix', async () => {
    const body = tsBody(4)
    const source = instrumented(body.length, 188, (offset) => body[offset])
    upstream(source.body, { 'content-type': 'application/octet-stream' })

    const response = await call(await signedPath('https://cdn.example/stream.bin'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp2t')
    expect(source.sent()).toBeLessThanOrEqual(PREFIX_CEILING)
    // The bytes that were read to decide are replayed, in order, in front.
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body)
  })

  it('invents no length for a chunked suspicious body', async () => {
    const body = tsBody(4)
    upstream(body, { 'content-type': 'image/jpeg' })

    const response = await call(await signedPath('https://seg1.example/seg-2-v1-a1.jpg'))

    expect(response.headers.get('content-type')).toBe('video/mp2t')
    // Upstream sent no length, so the player is told none: guessing would mean
    // waiting for the stream to end before answering.
    expect(response.headers.get('content-length')).toBeNull()
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body)
  })

  it('relabels text/plain + 0x47 to video/mp2t', async () => {
    const body = tsBody()
    upstream(body, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.length) })
    const response = await call(await signedPath('https://cdn.example/seg.ts'))
    expect(response.headers.get('content-type')).toBe('video/mp2t')
  })

  it('rejects an HTML error page that claims to be a JPEG', async () => {
    const html = '<!DOCTYPE html><html><body>403 Forbidden</body></html>'
    upstream(html, { 'content-type': 'image/jpeg', 'content-length': String(html.length) })

    const response = await call(await signedPath('https://seg1.example/seg-1-v1-a1.jpg'))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'UPSTREAM_FETCH_FAILED' })
  })

  it('rejects text/html whatever the length', async () => {
    const html = '\n  <html><body>expired token</body></html>'
    upstream(html, { 'content-type': 'text/html; charset=utf-8' })

    const response = await call(await signedPath('https://cdn.example/seg.ts'))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'UPSTREAM_FETCH_FAILED' })
  })

  it('rejects an HTML error page inside a chunked suspicious body', async () => {
    const html = new TextEncoder().encode('<!-- gone --><html><body>expired</body></html>')
    const source = instrumented(html.length, 16, (offset) => html[offset])
    upstream(source.body, { 'content-type': 'application/octet-stream' })

    const response = await call(await signedPath('https://cdn.example/seg.bin'))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'UPSTREAM_FETCH_FAILED' })
    expect(source.sent()).toBeLessThanOrEqual(PREFIX_CEILING)
  })
})

describe('PLAY-4: a large suspicious body is decided from its prefix only', () => {
  it('relabels a 3 MB image/jpeg TS segment without buffering it', async () => {
    const total = 3 * MIB + 17
    const source = instrumented(total, PREFIX_CEILING, (offset) => (offset % 188 === 0 ? 0x47 : offset % 251))
    upstream(source.body, { 'content-type': 'image/jpeg', 'content-length': String(total) })

    const response = await call(await signedPath('https://seg1.example/anikoto/seg-77-v1-a1.jpg'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp2t')
    // A known length above the 2 MB budget must not be trusted as a reason to buffer.
    expect(source.sent()).toBeLessThanOrEqual(PREFIX_CEILING)
    // The body is unchanged, and its length header still describes it.
    expect(response.headers.get('content-length')).toBe(String(total))
    const { total: received } = await drainCount(response)
    expect(received).toBe(total)
  })

  it('preserves every byte when the prefix lands mid-chunk', async () => {
    // 100-byte chunks against a 64-byte probe: the first chunk is split, and its
    // tail has to reappear ahead of everything after it.
    const total = 123 * 100
    const expected = new Uint8Array(total)
    for (let index = 0; index < total; index += 1) expected[index] = index % 251
    expected[0] = 0x47
    const source = instrumented(total, 100, (offset) => expected[offset])
    upstream(source.body, { 'content-type': 'application/octet-stream' })

    const response = await call(await signedPath('https://cdn.example/seg.bin'))

    expect(response.headers.get('content-type')).toBe('video/mp2t')
    expect(source.sent()).toBeLessThanOrEqual(PREFIX_CEILING)
    const received = await drain(response)
    expect(received.length).toBe(total)
    expect(received).toEqual(expected)
  })

  it('stops reading at the 64 KB ceiling when the probe arrives in tiny pieces', async () => {
    // One-byte chunks: the probe needs 64 reads, never the whole body.
    const total = 1 * MIB
    const source = instrumented(total, 1, (offset) => (offset === 0 ? 0x47 : 0x30))
    upstream(source.body, { 'content-type': 'binary/octet-stream' })

    const response = await call(await signedPath('https://cdn.example/seg.bin'))

    expect(response.headers.get('content-type')).toBe('video/mp2t')
    expect(source.sent()).toBeLessThanOrEqual(PREFIX_CEILING)
    const { total: received } = await drainCount(response)
    expect(received).toBe(total)
  })
})
