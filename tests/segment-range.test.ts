import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET } from '@/app/api/proxy/segment/route'
import { signProxyUrl } from '@/lib/proxy-signing'

/**
 * Measured on the live CDN: one host honours `Range` and answers 206, another
 * ignores it and answers 200 with the whole 3,047,480-byte segment. The proxy
 * must answer 206 with a Content-Range either way, and must not change at all
 * when no Range is sent.
 */

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
const TARGET = 'https://seg1.example.space/anime/x/seg-f1-00001.html'
const FULL = new Uint8Array(500).map((_value, index) => index % 256)

beforeEach(() => {
  process.env = { ...originalEnv, PROXY_SIGNING_SECRET: 'test-secret' }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
})

async function path() {
  return signProxyUrl(TARGET, { Referer: 'https://megaplay.buzz/' }, '/api/proxy/segment')
}

function stub(status: number, body: Uint8Array | null, headers: Record<string, string> = {}) {
  globalThis.fetch = vi.fn(async () => new Response(body, { status, headers })) as unknown as typeof fetch
}

function call(signed: string, range?: string) {
  return GET(new Request(`https://play.test${signed}`, { headers: range ? { Range: range } : {} }))
}

describe('a Range request when the CDN ignores it', () => {
  it('answers 206 with a real Content-Range and only the requested bytes', async () => {
    stub(200, FULL, { 'Content-Type': 'video/mp2t', 'Content-Length': String(FULL.length) })
    const response = await call(await path(), 'bytes=100-199')

    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 100-199/500')
    expect(response.headers.get('Content-Length')).toBe('100')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')

    const body = new Uint8Array(await response.arrayBuffer())
    expect(body.length).toBe(100)
    expect(body[0]).toBe(100)
    expect(body[99]).toBe(199)
  })

  it('answers an open-ended range to the end of the body', async () => {
    stub(200, FULL, { 'Content-Type': 'video/mp2t', 'Content-Length': String(FULL.length) })
    const response = await call(await path(), 'bytes=450-')

    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 450-499/500')
    expect(new Uint8Array(await response.arrayBuffer()).length).toBe(50)
  })

  it('answers 416 when the start is past the end', async () => {
    stub(200, FULL, { 'Content-Type': 'video/mp2t', 'Content-Length': String(FULL.length) })
    const response = await call(await path(), 'bytes=900-')
    expect(response.status).toBe(416)
    expect(response.headers.get('Content-Range')).toBe('bytes */500')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('clamps an end that runs past the body', async () => {
    stub(200, FULL, { 'Content-Type': 'video/mp2t', 'Content-Length': String(FULL.length) })
    const response = await call(await path(), 'bytes=0-9999')
    expect(response.headers.get('Content-Range')).toBe('bytes 0-499/500')
    expect(new Uint8Array(await response.arrayBuffer()).length).toBe(500)
  })
})

describe('a Range request the CDN honours', () => {
  it('passes the upstream 206 through with its own Content-Range', async () => {
    stub(206, FULL.subarray(100, 200), {
      'Content-Type': 'video/mp2t',
      'Content-Length': '100',
      'Content-Range': 'bytes 100-199/500',
    })
    const response = await call(await path(), 'bytes=100-199')
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 100-199/500')
    expect(response.headers.get('Content-Length')).toBe('100')
    expect(new Uint8Array(await response.arrayBuffer()).length).toBe(100)
  })

  it('keeps a 416 from upstream and its own reason', async () => {
    stub(416, null, { 'Content-Range': 'bytes */500' })
    const response = await call(await path(), 'bytes=900-')
    expect(response.status).toBe(416)
    expect(response.headers.get('Content-Range')).toBe('bytes */500')
  })

  it('reports an upstream failure as a CORS-readable 502', async () => {
    stub(403, new Uint8Array([1, 2, 3]), { 'Content-Type': 'text/html' })
    const response = await call(await path(), 'bytes=0-10')
    expect(response.status).toBe(502)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})

describe('no Range header', () => {
  it('leaves the previous behaviour untouched: full body, upstream status', async () => {
    stub(200, FULL, { 'Content-Type': 'video/mp2t', 'Content-Length': String(FULL.length) })
    const response = await call(await path())
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe('500')
    expect(new Uint8Array(await response.arrayBuffer()).length).toBe(500)
  })

  it('ignores a multi-range request instead of mis-slicing it', async () => {
    stub(200, FULL, { 'Content-Type': 'video/mp2t', 'Content-Length': String(FULL.length) })
    const response = await call(await path(), 'bytes=0-10,20-30')
    expect(response.status).toBe(200)
  })
})
