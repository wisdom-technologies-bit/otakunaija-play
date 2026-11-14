import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET } from '@/app/api/proxy/ani-subtitle/route'
import { __resetAniState } from '@/lib/ani/client'
import { signAniSubtitlePath, verifyAniSubtitleToken } from '@/lib/proxy-signing'
import { ANI_BASE, ANI_ENV, MAL_ID, SENTINEL_KEY, aniStreamPayload } from './fixtures/ani'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

const VTT = 'WEBVTT\n\n00:00.000 --> 00:01.500\nNamaste\n'

function applyEnv(overrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...ANI_ENV, PROXY_SIGNING_SECRET: 'test-secret', ...overrides })) {
    process.env[key] = value
  }
}

function route(query: string) {
  return GET(new Request(`https://play.otakunaija.test/api/proxy/ani-subtitle${query}`))
}

async function call(path: string) {
  const response = await route(path.slice(path.indexOf('?')))
  const type = response.headers.get('content-type') ?? ''
  const body = type.includes('application/json') ? await response.json() : await response.text()
  return { status: response.status, headers: response.headers, body }
}

function decodeToken(query: string) {
  const params = new URLSearchParams(query.slice(query.indexOf('?') + 1))
  return verifyAniSubtitleToken(params.get('p') ?? '', params.get('e') ?? '', params.get('s') ?? '')
}

beforeEach(() => {
  process.env = { ...originalEnv }
  applyEnv()
  __resetAniState()
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.startsWith(`${ANI_BASE}/v1/streams`)) return Response.json(aniStreamPayload())
    if (url === `${ANI_BASE}/v1/subtitles/tok3.vtt`) return new Response(VTT, { headers: { 'content-type': 'text/vtt' } })
    return new Response('', { status: 404 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
  __resetAniState()
})

describe('ani subtitle token', () => {
  it('carries the episode and the track, and nothing else', async () => {
    const path = await signAniSubtitlePath({ mal: MAL_ID, ep: 3, audio: 'sub', trackId: 'sub-3' })
    expect(path.startsWith('/api/proxy/ani-subtitle?')).toBe(true)

    const params = new URLSearchParams(path.slice(path.indexOf('?') + 1))
    const payload = JSON.parse(
      Buffer.from((params.get('p') ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    )
    expect(payload).toEqual({ mal: MAL_ID, ep: 3, audio: 'sub', trackId: 'sub-3' })

    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain(SENTINEL_KEY)
    expect(serialized).not.toContain(ANI_BASE)
    expect(path).not.toContain(SENTINEL_KEY)
    expect(path).not.toContain(ANI_BASE)
    expect(path).not.toContain('X-API-Key')

    expect(await decodeToken(path)).toEqual({ mal: MAL_ID, ep: 3, audio: 'sub', trackId: 'sub-3' })
  })

  it('rejects a tampered payload and an expired one', async () => {
    const path = await signAniSubtitlePath({ mal: MAL_ID, ep: 1, audio: 'sub', trackId: 'sub-3' })
    // Swap the track inside the payload and keep the old signature.
    const params = new URLSearchParams(path.slice(path.indexOf('?') + 1))
    const payload = JSON.parse(
      Buffer.from((params.get('p') ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as Record<string, unknown>
    payload.trackId = 'sub-1'
    const tampered = Buffer.from(JSON.stringify(payload)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(await decodeToken(`/api/proxy/ani-subtitle?p=${tampered}&e=${params.get('e')}&s=${params.get('s')}`)).toBeNull()

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 5 * 60 * 60 * 1000)
      expect(await decodeToken(path)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('GET /api/proxy/ani-subtitle', () => {
  it('serves a converted track as WebVTT with CORS and a one hour cache', async () => {
    const { status, headers, body } = await call(await signAniSubtitlePath({ mal: MAL_ID, ep: 1, audio: 'sub', trackId: 'sub-3' }))
    expect(status).toBe(200)
    expect(headers.get('content-type')).toContain('text/vtt')
    expect(headers.get('access-control-allow-origin')).toBe('*')
    expect(headers.get('cache-control')).toBe('public, max-age=3600')
    expect(body).toContain('WEBVTT')

    const fetchMock = globalThis.fetch as unknown as { mock: { calls: Array<[unknown, RequestInit]> } }
    const upstream = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1/subtitles/tok3.vtt'))
    expect(upstream).toBeTruthy()
    expect((upstream?.[1].headers as Record<string, string>)['X-API-Key']).toBe(SENTINEL_KEY)
    expect((upstream?.[1].headers as Record<string, string>).Referer).toBe('https://zokoanime.video/')
  })

  it('answers 403 without a valid token', async () => {
    const { status, body } = await call('/api/proxy/ani-subtitle?p=&e=&s=')
    expect(status).toBe(403)
    expect(body).toEqual({ error: 'INVALID_OR_EXPIRED_SIGNATURE' })
  })

  it('answers 404 when the track is no longer in the payload', async () => {
    const { status, body } = await call(await signAniSubtitlePath({ mal: MAL_ID, ep: 1, audio: 'sub', trackId: 'gone' }))
    expect(status).toBe(404)
    expect(body).toEqual({ error: 'SUBTITLE_TRACK_NOT_FOUND' })
  })

  it('answers 502 when the upstream subtitle fails', async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith(`${ANI_BASE}/v1/streams`)) return Response.json(aniStreamPayload())
      return new Response('', { status: 502 })
    }) as unknown as typeof fetch

    const { status } = await call(await signAniSubtitlePath({ mal: MAL_ID, ep: 1, audio: 'sub', trackId: 'sub-3' }))
    expect(status).toBe(502)
  })

  it('fails closed when the provider is not configured', async () => {
    process.env.ANI_API_KEY = ''
    const path = await signAniSubtitlePath({ mal: MAL_ID, ep: 1, audio: 'sub', trackId: 'sub-3' })
    const { status, body } = await call(path)
    expect(status).toBe(503)
    expect(body).toEqual({ error: 'ANI_NOT_CONFIGURED' })
  })
})
