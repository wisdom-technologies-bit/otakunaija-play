import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  fetchAniListWithRetry,
  parseAniListMedia,
  parseAniListMediaPage,
} from '@/lib/supabase/admin'

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('fetchAniListWithRetry', () => {
  it('returns the parsed page on success', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        data: { Page: { pageInfo: { hasNextPage: true }, media: [{ id: 1 }] } },
      }),
    ) as unknown as typeof fetch

    const result = await fetchAniListWithRetry(
      () => fetch('https://graphql.anilist.co'),
      (payload) => parseAniListMediaPage(payload as never),
      { deadline: Date.now() + 5_000 },
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.parsed.hasNextPage).toBe(true)
      expect(result.parsed.media).toHaveLength(1)
      expect(result.rateLimited).toBe(false)
    }
  })

  it('honours Retry-After on 429 and succeeds on the retry', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        return new Response('', { status: 429, headers: { 'retry-after': '0.05' } })
      }
      return jsonResponse({ data: { Page: { pageInfo: { hasNextPage: false }, media: [] } } })
    }) as unknown as typeof fetch

    const startedAt = Date.now()
    const result = await fetchAniListWithRetry(
      () => fetch('https://graphql.anilist.co'),
      (payload) => parseAniListMediaPage(payload as never),
      { deadline: Date.now() + 5_000 },
    )

    expect(calls).toBe(2)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.rateLimited).toBe(true)
    // Waited for Retry-After rather than the 60 s default.
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it('stops instead of sleeping past the deadline', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('', { status: 429, headers: { 'retry-after': '3600' } }),
    ) as unknown as typeof fetch

    const startedAt = Date.now()
    const result = await fetchAniListWithRetry(
      () => fetch('https://graphql.anilist.co'),
      (payload) => parseAniListMediaPage(payload as never),
      { deadline: Date.now() + 1_000 },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rateLimited).toBe(true)
      expect(result.error).toMatch(/time budget/i)
    }
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('gives up after the retry budget on a persistent 429', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('', { status: 429, headers: { 'retry-after': '0.01' } }),
    ) as unknown as typeof fetch

    const result = await fetchAniListWithRetry(
      () => fetch('https://graphql.anilist.co'),
      (payload) => parseAniListMediaPage(payload as never),
      { deadline: Date.now() + 10_000, maxRetries: 1 },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/retry exhausted/i)
  })

  it('reports a non-429 HTTP failure without throwing', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch

    const result = await fetchAniListWithRetry(
      () => fetch('https://graphql.anilist.co'),
      (payload) => parseAniListMediaPage(payload as never),
      { deadline: Date.now() + 5_000 },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(500)
      expect(result.error).toBe('AniList request failed with HTTP 500')
    }
  })

  it('swallows a network error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch

    const result = await fetchAniListWithRetry(
      () => fetch('https://graphql.anilist.co'),
      (payload) => parseAniListMediaPage(payload as never),
      { deadline: Date.now() + 5_000 },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('ECONNRESET')
  })

  it('turns a GraphQL error payload into a failure result', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ errors: [{ message: 'Too many requests' }] }),
    ) as unknown as typeof fetch

    const result = await fetchAniListWithRetry(
      () => fetch('https://graphql.anilist.co'),
      (payload) => parseAniListMediaPage(payload as never),
      { deadline: Date.now() + 5_000 },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Too many requests')
  })

  it('parses a single-media lookup used by manual imports', async () => {
    const parsed = parseAniListMedia({ data: { Media: { id: 12345, status: 'NOT_YET_RELEASED' } } })
    expect(parsed).toEqual({ id: 12345, status: 'NOT_YET_RELEASED' })

    expect(parseAniListMedia({ data: { Media: null } })).toBeNull()
    expect(() => parseAniListMedia({ errors: [{ message: 'Not Found.' }] })).toThrow('Not Found.')
  })
})
