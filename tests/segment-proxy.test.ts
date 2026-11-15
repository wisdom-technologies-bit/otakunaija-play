import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET } from '@/app/api/proxy/segment/route'
import { signProxyUrl, verifyProxySignature } from '@/lib/proxy-signing'

/**
 * AniKoto serves real MPEG-TS bytes as `seg-N-v1-a1.jpg` with
 * `Content-Type: image/jpeg` (first byte 0x47). The proxy must accept those,
 * relabel them `video/mp2t`, and still refuse an HTML error page that a CDN
 * returns instead of the segment.
 */

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

/** 188-byte TS packets: 0x47 then filler, nothing that looks like markup. */
function tsBody(packets = 3) {
  const bytes = new Uint8Array(188 * packets)
  for (let packet = 0; packet < packets; packet += 1) {
    bytes[packet * 188] = 0x47
    for (let index = 1; index < 188; index += 1) bytes[packet * 188 + index] = index % 251
  }
  return bytes
}

const SEGMENT_URL = 'https://seg1.twilightharbor.space/anikoto/seg-1-v1-a1.jpg'
const HEADERS = { Referer: 'https://megaplay.buzz/' }

async function signedPath(url = SEGMENT_URL, headers: Record<string, string> = HEADERS) {
  return signProxyUrl(url, headers, '/api/proxy/segment')
}

function call(path: string, init: { range?: string } = {}) {
  return GET(new Request(`https://play.otakunaija.test${path}`, {
    headers: init.range ? { Range: init.range } : {},
  }))
}

beforeEach(() => {
  process.env = { ...originalEnv, PROXY_SIGNING_SECRET: 'test-secret' }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
})

describe('GET /api/proxy/segment media sniffing', () => {
  it('serves a TS segment that arrives as image/jpeg as video/mp2t', async () => {
    const body = tsBody()
    // A segment host answers with a length; PLAY-4 only restates it in the small
    // buffered path and never invents one, so the fixture must carry it.
    const fetchMock = vi.fn(async () => new Response(body, {
      headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) },
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await call(await signedPath())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp2t')
    expect(response.headers.get('content-length')).toBe(String(body.length))

    const received = new Uint8Array(await response.arrayBuffer())
    expect(received[0]).toBe(0x47)
    expect(received.length).toBe(body.length)

    // The Referer the CDN demands is what the proxy sends.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(SEGMENT_URL)
    expect((init.headers as Record<string, string>).Referer).toBe('https://megaplay.buzz/')
  })

  it('rejects an HTML error page served with a 200', async () => {
    const html = '<!DOCTYPE html><html><body>403 Forbidden</body></html>'
    globalThis.fetch = vi.fn(async () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch

    const response = await call(await signedPath())
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'UPSTREAM_FETCH_FAILED' })
  })

  it('rejects an HTML body even when it claims to be a JPEG', async () => {
    globalThis.fetch = vi.fn(async () => new Response('\n<html><body>expired</body></html>', { headers: { 'content-type': 'image/jpeg' } })) as unknown as typeof fetch

    const response = await call(await signedPath())
    expect(response.status).toBe(502)
  })

  it('keeps a real video content type for a body that is not TS', async () => {
    const ftyp = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
    globalThis.fetch = vi.fn(async () => new Response(ftyp, { headers: { 'content-type': 'video/mp4' } })) as unknown as typeof fetch

    const response = await call(await signedPath('https://cdn.example/seg-1.mp4'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
  })

  it('does not sniff a mid-file range, because its first byte is not a sync byte', async () => {
    const body = new Uint8Array([0x11, 0x22, 0x33, 0x44])
    globalThis.fetch = vi.fn(async () => new Response(body, {
      status: 206,
      headers: { 'content-type': 'image/jpeg', 'content-range': 'bytes 100-103/188' },
    })) as unknown as typeof fetch

    const response = await call(await signedPath(), { range: 'bytes=100-103' })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(response.headers.get('content-range')).toBe('bytes 100-103/188')
  })

  it('still sniffs a range that starts at byte 0', async () => {
    globalThis.fetch = vi.fn(async () => new Response(tsBody(), {
      status: 206,
      headers: { 'content-type': 'image/jpeg', 'content-range': 'bytes 0-563/564' },
    })) as unknown as typeof fetch

    const response = await call(await signedPath(), { range: 'bytes=0-' })
    expect(response.headers.get('content-type')).toBe('video/mp2t')
  })

  it('refuses an unsigned request', async () => {
    const response = await call('/api/proxy/segment?u=&h=&e=&s=')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'INVALID_OR_EXPIRED_SIGNATURE' })
  })

  it('reports an upstream failure as a failed fetch', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 403 })) as unknown as typeof fetch
    const response = await call(await signedPath())
    expect(response.status).toBe(502)
  })

  it('signs the segment url and its headers into the path', async () => {
    const path = await signedPath()
    expect(path.startsWith('/api/proxy/segment?u=')).toBe(true)
    const params = new URLSearchParams(path.slice(path.indexOf('?') + 1))
    const verified = await verifyProxySignature(params.get('u') ?? '', params.get('h') ?? '', params.get('e') ?? '', params.get('s') ?? '')
    expect(verified.targetUrl).toBe(SEGMENT_URL)
    expect(verified.headers).toEqual(HEADERS)
  })
})
