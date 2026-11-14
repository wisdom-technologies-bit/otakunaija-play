import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  supabase: null as unknown as { from: unknown },
  updates: [] as Array<{ table: string, values: Record<string, unknown> }>,
  selectCalls: [] as string[],
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => h.supabase,
}))

import { GET } from '@/app/api/watch/[playId]/route'
import { verifyAniSubtitleToken, verifyProxySignature } from '@/lib/proxy-signing'
import { __resetAniState } from '@/lib/ani/client'
import { ANI_BASE, ANI_ENV, MAL_ID, SENTINEL_KEY, aniStreamPayload } from './fixtures/ani'

const ANIVEXA = 'https://anivexa.otakunaija.name.ng'
const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

type Row = Record<string, unknown>

function episodeRow(overrides: Row = {}): Row {
  return {
    play_id: 'abc123',
    anilist_id: 1001,
    mal_id: MAL_ID,
    episode_number: 1,
    sub_providers: [],
    dub_providers: [],
    resolved_provider: null,
    resolved_audio: null,
    resolved_at: null,
    needs_resync: false,
    ...overrides,
  }
}

function stubSupabase(options: { episode?: Row, anime?: Row | null } = {}) {
  const episode = options.episode ?? episodeRow()
  const anime = options.anime === undefined ? { mal_id: MAL_ID } : options.anime
  h.updates = []
  h.selectCalls = []
  h.supabase = {
    from(table: string) {
      return {
        select(columns: string) {
          h.selectCalls.push(`${table}:${columns}`)
          return {
            eq() {
              return {
                async maybeSingle() {
                  return { data: table === 'episodes' ? episode : anime, error: null }
                },
              }
            },
          }
        },
        update(values: Record<string, unknown>) {
          return {
            async eq() {
              h.updates.push({ table, values })
              return { error: null }
            },
          }
        },
      }
    },
  }
}

const ANIVEXA_STREAM = {
  streams: [
    {
      url: 'https://cdn.anivexa.example/anipm/1080.m3u8',
      type: 'hls',
      server: 'hd-1',
      headers: { Referer: 'https://anipm.example/' },
      subtitles: [{ url: 'https://cdn.anivexa.example/en.vtt', label: 'English', srclang: 'en' }],
      isActive: true,
    },
  ],
}

type Route = (url: string) => unknown

function fetchRouter(overrides: Record<string, Route> = {}) {
  const calls: string[] = []
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    for (const [prefix, handler] of Object.entries(overrides)) {
      if (url === prefix || url.startsWith(prefix)) return handler(url)
    }
    if (url.startsWith(`${ANI_BASE}/v1/streams`)) return Response.json(aniStreamPayload())
    if (url === 'https://hls.dramahot.top/abc/master.m3u8') {
      return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n1080/index.m3u8\n')
    }
    if (url.startsWith(`${ANIVEXA}/watch/`)) return Response.json(ANIVEXA_STREAM)
    if (url.startsWith(`${ANIVEXA}/episodes/`)) return Response.json({})
    if (url.startsWith(`${ANIVEXA}/map/`)) return Response.json({})
    if (url.includes('.m3u8')) return new Response('#EXTM3U\n#EXT-X-VERSION:3\n')
    void init
    return new Response('', { status: 404 })
  })
  globalThis.fetch = mock as unknown as typeof fetch
  return { mock, calls }
}

function request(query = '') {
  return new Request(`https://play.otakunaija.test/api/watch/abc123${query}`)
}

async function resolveWatch(query = '') {
  const response = await GET(request(query), { params: Promise.resolve({ playId: 'abc123' }) })
  const body = await response.json() as Record<string, unknown>
  return { status: response.status, body }
}

function useAniEnv(overrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...ANI_ENV, ...overrides })) process.env[key] = value
}

function useAniOff() {
  process.env.ANI_PROVIDER_ENABLED = '0'
  process.env.ANI_API_BASE_URL = ANI_BASE
  process.env.ANI_API_KEY = SENTINEL_KEY
}

function decode(query: string) {
  const params = new URLSearchParams(query.startsWith('/') ? query.slice(query.indexOf('?') + 1) : query)
  return verifyProxySignature(params.get('u') ?? '', params.get('h') ?? '', params.get('e') ?? '', params.get('s') ?? '')
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-14T10:00:00Z') })
  process.env = { ...originalEnv }
  process.env.PROXY_SIGNING_SECRET = 'test-secret'
  __resetAniState()
  stubSupabase()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
  __resetAniState()
})

describe('watch resolver with ani off', () => {
  it('answers exactly the Anivexa shape it answered before, with no new fields', async () => {
    useAniOff()
    fetchRouter()
    const { status, body } = await resolveWatch()

    expect(status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(
      ['audio', 'headers', 'intro', 'outro', 'playId', 'provider', 'server', 'streamUrl', 'subtitles', 'type'].sort(),
    )
    expect(body.playId).toBe('abc123')
    expect(body.audio).toBe('sub')
    expect(body.provider).toBe('anipm')
    expect(body.server).toBe('hd-1')
    expect(body.type).toBe('hls')
    expect(body.headers).toEqual({})
    expect(body.intro).toBeNull()
    expect(body.outro).toBeNull()

    const stream = await decode(body.streamUrl as string)
    expect(stream.valid).toBe(true)
    expect(stream.targetUrl).toBe('https://cdn.anivexa.example/anipm/1080.m3u8')
    expect(stream.headers).toEqual({ Referer: 'https://anipm.example/' })

    const subtitles = body.subtitles as Array<Record<string, unknown>>
    expect(subtitles).toHaveLength(1)
    expect(subtitles[0].label).toBe('English')
    expect(subtitles[0].srclang).toBe('en')
    const subtitle = await decode(subtitles[0].url as string)
    expect(subtitle.targetUrl).toBe('https://cdn.anivexa.example/en.vtt')
  })

  it('never calls the ani-api and writes the resolved provider as before', async () => {
    useAniOff()
    const { calls } = fetchRouter()
    await resolveWatch()
    expect(calls.some((url) => url.startsWith(ANI_BASE))).toBe(false)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].values.resolved_provider).toBe('anipm')
  })

  it('does not add an ani: trace line when debug is off', async () => {
    useAniOff()
    fetchRouter()
    const { body } = await resolveWatch()
    expect(body.trace).toBeUndefined()
  })
})

describe('watch resolver with ani on', () => {
  it('serves the ani stream first, signed through the manifest proxy', async () => {
    useAniEnv()
    fetchRouter()
    const { status, body } = await resolveWatch()

    expect(status).toBe(200)
    expect(body.provider).toBe('ani')
    expect(body.server).toBeNull()
    expect(body.audio).toBe('sub')
    expect(body.type).toBe('hls')
    expect(body.headers).toEqual({})
    expect(body.intro).toBeNull()
    expect(body.outro).toBeNull()

    const stream = await decode(body.streamUrl as string)
    expect(stream.valid).toBe(true)
    expect(stream.targetUrl).toBe('https://hls.dramahot.top/abc/master.m3u8')
    expect(stream.headers).toEqual({ Referer: 'https://zokoanime.video/' })
    expect((body.streamUrl as string).startsWith('/api/proxy/manifest?')).toBe(true)

    // Every playable track, signs dropped, converted tracks through our own proxy.
    const subtitles = body.subtitles as Array<Record<string, unknown>>
    expect(subtitles.map((track) => track.label)).toEqual([
      'English (- (Crunchyroll))',
      'Spanish',
      'Portuguese - Brazil',
      'Arabic',
    ])
    expect(subtitles[0].default).toBe(true)
    expect(subtitles[0].srclang).toBe('en')
    expect(subtitles[2].srclang).toBe('pt')
    expect(subtitles[2].kind).toBe('full')
    expect((subtitles[0].url as string).startsWith('/api/proxy/subtitle?')).toBe(true)
    expect((subtitles[2].url as string).startsWith('/api/proxy/ani-subtitle?')).toBe(true)

    const token = new URLSearchParams((subtitles[2].url as string).slice((subtitles[2].url as string).indexOf('?') + 1))
    const decoded = await verifyAniSubtitleToken(token.get('p') ?? '', token.get('e') ?? '', token.get('s') ?? '')
    expect(decoded).toEqual({ mal: MAL_ID, ep: 1, audio: 'sub', trackId: 'sub-3' })
  })

  it('writes nothing to the database when ani wins', async () => {
    useAniEnv()
    fetchRouter()
    await resolveWatch()
    expect(h.updates).toHaveLength(0)
  })

  it('honours the exclusion the player sends back after a playback error', async () => {
    useAniEnv()
    const { calls } = fetchRouter()
    const { body } = await resolveWatch('?exclude=ani%3Adefault')
    expect(body.provider).toBe('anipm')
    expect(calls.some((url) => url.startsWith(ANI_BASE))).toBe(false)
  })

  it('never asks ani for dub, even when dub is enabled', async () => {
    useAniEnv({ ANI_DUB_ENABLED: '1' })
    stubSupabase({
      episode: episodeRow({
        sub_providers: [],
        dub_providers: [{ provider: 'anipm', episodeId: 'watch/anipm/1001/dub/anipm-1' }],
      }),
    })
    const { calls } = fetchRouter({
      // No Anivexa sub provider works, so the resolver reaches the dub path.
      [`${ANIVEXA}/watch/`]: (url: string) =>
        url.includes('/dub/') ? Response.json(ANIVEXA_STREAM) : Response.json({ streams: [] }),
      // ani cannot serve sub here, either.
      [`${ANI_BASE}/v1/streams`]: () => Response.json({ code: 'MAL_NOT_MAPPED', title: 'no mapping' }, { status: 404 }),
    })
    const { body } = await resolveWatch()

    expect(body.audio).toBe('dub')
    expect(body.provider).toBe('anipm')
    expect(calls.some((url) => url.includes('audio=dub') && url.startsWith(ANI_BASE))).toBe(false)
  })

  it('falls through to Anivexa on any ani failure and traces it', async () => {
    useAniEnv()
    fetchRouter({
      [`${ANI_BASE}/v1/streams`]: () => Response.json({ code: 'MAL_NOT_MAPPED', title: 'no mapping' }, { status: 404 }),
    })
    const { status, body } = await resolveWatch('?debug=1')
    expect(status).toBe(200)
    expect(body.provider).toBe('anipm')
    const trace = body.trace as string[]
    expect(trace[0]).toMatch(/^ani: failed MAL_NOT_MAPPED \d+ms$/)
  })

  it('records the trace line when the provider is simply not configured', async () => {
    useAniEnv({ ANI_API_KEY: '' })
    fetchRouter()
    const { body } = await resolveWatch('?debug=1')
    expect(body.provider).toBe('anipm')
    expect((body.trace as string[])[0]).toMatch(/^ani: skipped ANI_NOT_CONFIGURED \d+ms$/)
  })
})

describe('MAL id discovery', () => {
  it('looks the MAL id up on the anime row without the Anivexa fallback', async () => {
    useAniEnv()
    stubSupabase({ episode: episodeRow({ mal_id: null }), anime: { mal_id: MAL_ID } })
    const { calls } = fetchRouter()
    const { body } = await resolveWatch()
    expect(body.provider).toBe('ani')
    expect(calls.some((url) => url.startsWith(`${ANIVEXA}/map/`))).toBe(false)
  })

  it('asks Anivexa /map once and saves the id back when both rows are empty', async () => {
    useAniEnv()
    stubSupabase({ episode: episodeRow({ mal_id: null }), anime: { mal_id: null } })
    fetchRouter({ [`${ANIVEXA}/map/`]: () => Response.json({ anilistId: 1001, malId: MAL_ID }) })
    const { body } = await resolveWatch()

    expect(body.provider).toBe('ani')
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]).toMatchObject({ table: 'anime', values: { mal_id: MAL_ID } })
  })

  it('skips ani when no MAL id can be found', async () => {
    useAniEnv()
    stubSupabase({ episode: episodeRow({ mal_id: null }), anime: { mal_id: null } })
    const { calls } = fetchRouter({ [`${ANIVEXA}/map/`]: () => Response.json({ anilistId: 1001 }) })
    const { body } = await resolveWatch('?debug=1')

    expect(body.provider).toBe('anipm')
    expect(calls.some((url) => url.startsWith(ANI_BASE))).toBe(false)
    expect((body.trace as string[])[0]).toMatch(/^ani: skipped ANI_NO_MAL_ID \d+ms$/)
  })
})

describe('key containment', () => {
  it('keeps the key out of the payload, the trace and the kept URLs', async () => {
    useAniEnv()
    fetchRouter()
    const { body } = await resolveWatch('?debug=1')
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(SENTINEL_KEY)
    expect(serialized).not.toContain('X-API-Key')
    expect(serialized).not.toContain(ANI_BASE)
    expect(serialized).not.toContain('/v1/subtitles/')

    const stream = await decode(body.streamUrl as string)
    expect(JSON.stringify(stream.headers)).not.toContain(SENTINEL_KEY)
    const subtitles = body.subtitles as Array<Record<string, unknown>>
    for (const track of subtitles) {
      expect(String(track.url)).not.toContain(SENTINEL_KEY)
      expect(String(track.url)).not.toContain(ANI_BASE)
    }
  })
})

describe('error bodies', () => {
  it('keeps the key and every ani detail out of a NO_WORKING_STREAM body', async () => {
    useAniEnv()
    stubSupabase({ episode: episodeRow({ sub_providers: [], dub_providers: [] }) })
    fetchRouter({
      [`${ANIVEXA}/watch/`]: () => Response.json({ streams: [] }),
      [`${ANI_BASE}/v1/streams`]: () => new Response('', { status: 500 }),
    })
    const { status, body } = await resolveWatch('?debug=1')

    expect(status).toBe(404)
    expect(body.error).toBe('NO_WORKING_STREAM')
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(SENTINEL_KEY)
    expect(serialized).not.toContain(ANI_BASE)
    expect(serialized).not.toContain('X-API-Key')
    expect((body.trace as string[])[0]).toMatch(/^ani: failed /)
  })
})
