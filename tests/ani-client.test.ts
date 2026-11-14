import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetAniState, getAniStatus, getAniStream } from '@/lib/ani/client'
import { AniRequestError } from '@/lib/ani/errors'
import { ANI_BASE, ANI_ENV, ANI_ERROR_BODIES, EPISODE, MAL_ID, SENTINEL_KEY, aniStreamPayload } from './fixtures/ani'

const originalFetch = globalThis.fetch

function env(overrides: Record<string, string> = {}) {
  return { ...ANI_ENV, ...overrides }
}

function ok(payload: unknown) {
  return Response.json(payload)
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise
    return 'RESOLVED'
  } catch (error) {
    return error instanceof AniRequestError ? error.code : `UNEXPECTED:${String(error)}`
  }
}

beforeEach(() => {
  __resetAniState()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  __resetAniState()
})

describe('getAniStream', () => {
  it('sends the key as a header and caches the payload for 10 minutes', async () => {
    const fetchMock = vi.fn(async () => ok(aniStreamPayload()))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const first = await getAniStream(MAL_ID, EPISODE, 'sub', { env: env() })
    const second = await getAniStream(MAL_ID, EPISODE, 'sub', { env: env() })

    expect(first.mal?.stream_verified).toBe(true)
    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${ANI_BASE}/v1/streams/mal/21/episode/1?audio=sub&quality=best`)
    const headers = init.headers as Record<string, string>
    expect(headers['X-API-Key']).toBe(SENTINEL_KEY)
    expect(headers['User-Agent']).toBe('OtakuNaijaPlay')
  })

  it('collapses concurrent cold requests into one upstream call', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchMock = vi.fn(async () => {
      await gate
      return ok(aniStreamPayload())
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const calls = [
      getAniStream(MAL_ID, EPISODE, 'sub', { env: env() }),
      getAniStream(MAL_ID, EPISODE, 'sub', { env: env() }),
      getAniStream(MAL_ID, EPISODE, 'sub', { env: env() }),
    ]
    release()
    const results = await Promise.all(calls)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new Set(results).size).toBe(1)
  })

  it('remembers an unmapped MAL id for 30 minutes without asking again', async () => {
    const fetchMock = vi.fn(async () => Response.json(ANI_ERROR_BODIES.MAL_NOT_MAPPED.body, { status: 404 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    expect(await codeOf(getAniStream(MAL_ID, EPISODE, 'sub', { env: env() }))).toBe('MAL_NOT_MAPPED')
    expect(await codeOf(getAniStream(MAL_ID, EPISODE, 'sub', { env: env() }))).toBe('MAL_NOT_MAPPED')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getAniStatus(env()).counters.negativeHits).toBe(1)
  })

  it('remembers an episode mismatch for only 60 seconds', async () => {
    const fetchMock = vi.fn(async () => Response.json(ANI_ERROR_BODIES.MAL_EPISODE_MISMATCH.body, { status: 409 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    expect(await codeOf(getAniStream(MAL_ID, EPISODE, 'sub', { env: env() }))).toBe('MAL_EPISODE_MISMATCH')
    expect(await codeOf(getAniStream(MAL_ID, EPISODE, 'sub', { env: env() }))).toBe('MAL_EPISODE_MISMATCH')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 61_000)
      expect(await codeOf(getAniStream(MAL_ID, EPISODE, 'sub', { env: env() }))).toBe('MAL_EPISODE_MISMATCH')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries exactly once on 503 and succeeds', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response('', { status: 503 })
      return ok(aniStreamPayload())
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const payload = await getAniStream(MAL_ID, EPISODE, 'sub', { env: env() })
    expect(payload.mal?.stream_verified).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getAniStatus(env()).counters.retries).toBe(1)
  })

  it('never retries a 401', async () => {
    const fetchMock = vi.fn(async () => Response.json({ code: 'UNAUTHORIZED' }, { status: 401 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    expect(await codeOf(getAniStream(MAL_ID, EPISODE, 'sub', { env: env() }))).toBe('UNAUTHORIZED')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('opens the breaker after five failures in a minute', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 500 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const config = env({ ANI_RATE_PER_MIN: '600' })

    for (let malId = 1; malId <= 5; malId += 1) {
      await codeOf(getAniStream(malId, 1, 'sub', { env: config }))
    }
    const callsBefore = fetchMock.mock.calls.length
    expect(await codeOf(getAniStream(99, 1, 'sub', { env: config }))).toBe('ANI_BREAKER_OPEN')
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
    expect(getAniStatus(config).breaker.open).toBe(true)
  })

  it('skips instead of queueing when the per-minute budget is spent', async () => {
    const fetchMock = vi.fn(async () => ok(aniStreamPayload()))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const config = env({ ANI_RATE_PER_MIN: '2' })

    await getAniStream(1, 1, 'sub', { env: config })
    await getAniStream(2, 1, 'sub', { env: config })
    expect(await codeOf(getAniStream(3, 1, 'sub', { env: config }))).toBe('ANI_SATURATED')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('pauses on 429 for the Retry-After window', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    expect(await codeOf(getAniStream(MAL_ID, EPISODE, 'sub', { env: env() }))).toBe('ANI_RATE_LIMITED')
    expect(await codeOf(getAniStream(22, 1, 'sub', { env: env() }))).toBe('ANI_RATE_LIMITED')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getAniStatus(env()).paused.paused).toBe(true)
  })

  it('reports a timeout as ANI_TIMEOUT', async () => {
    const fetchMock = vi.fn(async () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    expect(await codeOf(getAniStream(MAL_ID, EPISODE, 'sub', { env: env() }))).toBe('ANI_TIMEOUT')
  })

  it('refuses to run without a base URL or key', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    expect(await codeOf(getAniStream(MAL_ID, EPISODE, 'sub', { env: env({ ANI_API_KEY: '' }) }))).toBe('ANI_NOT_CONFIGURED')
    expect(await codeOf(getAniStream(MAL_ID, EPISODE, 'sub', { env: env({ ANI_API_BASE_URL: '' }) }))).toBe('ANI_NOT_CONFIGURED')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the in-memory cache under 500 entries', async () => {
    globalThis.fetch = vi.fn(async () => ok(aniStreamPayload())) as unknown as typeof fetch
    const config = env({ ANI_RATE_PER_MIN: '600' })

    for (let malId = 1; malId <= 505; malId += 1) {
      await getAniStream(malId, 1, 'sub', { env: config })
    }
    expect(getAniStatus(config).cacheSize).toBe(500)
  })

  it('never puts the key in an error', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch
    try {
      await getAniStream(MAL_ID, EPISODE, 'sub', { env: env() })
    } catch (error) {
      const text = `${(error as Error).message} ${(error as Error).stack ?? ''} ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`
      expect(text).not.toContain(SENTINEL_KEY)
    }
    expect(JSON.stringify(getAniStatus(env()))).not.toContain(SENTINEL_KEY)
  })
})
