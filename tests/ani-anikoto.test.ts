import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetAniState, cacheTtlMsFor, getAniStream } from '@/lib/ani/client'
import { readAniConfig } from '@/lib/ani/config'
import { AniRequestError } from '@/lib/ani/errors'
import {
  allowedMasterHosts,
  buildAniProviderStream,
  isAllowedMasterUrl,
  normalizeTimeRange,
  tryAni,
  validateAniPayload,
  type TryAniInput,
} from '@/lib/ani/resolve'
import { verifyProxySignature } from '@/lib/proxy-signing'
import {
  ANI_BASE,
  ANI_ENV,
  ANIKOTO_MASTER_HOST,
  ANIKOTO_MASTER_URL,
  ANIKOTO_REFERER,
  EPISODE,
  MAL_ID,
  SENTINEL_KEY,
  SOLO_LEVELING_MAL,
  anikotoNoSubtitlePayload,
  anikotoStreamPayload,
  attackOnTitanPayload,
  identicalSubDubPair,
  narutoPayload,
  soloLevelingPayload,
} from './fixtures/ani'

/**
 * AniKoto is the ani-api's new FIRST source (ZokoAnime is the fallback). Its
 * payloads differ from ZokoAnime in ways that broke playback under PLAY-2, so
 * everything asserted here comes from real curl output captured 2026-11-15.
 */

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

function env(overrides: Record<string, string> = {}) {
  return { ...ANI_ENV, ...overrides }
}

function expected(overrides: Partial<Parameters<typeof validateAniPayload>[1]> = {}) {
  return { malId: MAL_ID, episode: EPISODE, audio: 'sub' as const, requireSubtitle: true, ...overrides }
}

async function codeOf(run: () => unknown) {
  try {
    await run()
    return 'RESOLVED'
  } catch (error) {
    return error instanceof AniRequestError ? error.code : `UNEXPECTED:${String(error)}`
  }
}

async function decodeSignedSubtitle(path: string) {
  const params = new URLSearchParams(path.slice(path.indexOf('?') + 1))
  return verifyProxySignature(params.get('u') ?? '', params.get('h') ?? '', params.get('e') ?? '', params.get('s') ?? '')
}

beforeEach(() => {
  process.env = { ...originalEnv, PROXY_SIGNING_SECRET: 'test-secret', ...env() }
  __resetAniState()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
  __resetAniState()
})

describe('DEFECT 1: a track that needs no conversion is signed from its raw url', () => {
  it('signs the ABSOLUTE mysubsplay url through /api/proxy/subtitle with the subtitle Referer', async () => {
    const validated = validateAniPayload(anikotoStreamPayload(), expected())
    const stream = await buildAniProviderStream(validated, { malId: MAL_ID, episode: EPISODE, audio: 'sub' })

    const path = stream.subtitlePaths[0]
    expect(path).toBeTruthy()
    expect(path as string).toMatch(/^\/api\/proxy\/subtitle\?/)
    // The old bug: a converted-path token would carry the ani-api route instead.
    expect(path as string).not.toContain('/api/proxy/ani-subtitle')

    const verified = await decodeSignedSubtitle(path as string)
    expect(verified.valid).toBe(true)
    // The browser now downloads the public CDN file, not a relative ani-api path.
    expect(verified.targetUrl).toBe('https://subs1.mysubsplay.com/anikoto/one-piece-1-ptbr.vtt')
    expect(verified.targetUrl).not.toContain('/v1/subtitles')
    expect(verified.targetUrl).not.toContain(ANI_BASE)
    expect(verified.headers).toEqual({ Referer: ANIKOTO_REFERER })

    const serialized = JSON.stringify(verified)
    expect(serialized).not.toContain(SENTINEL_KEY)
    expect(serialized).not.toContain('X-API-Key')
    expect(serialized).not.toContain('/v1/subtitles')
    expect(path as string).not.toContain('/v1/subtitles')
  })

  it('still routes a converted track through our own ani-subtitle token', async () => {
    const payload = anikotoStreamPayload({
      subtitles: [
        {
          url: 'https://subs1.mysubsplay.com/anikoto/one-piece-1-ar.srt',
          proxied_url: '/v1/subtitles/ak-ar.vtt',
          id: 'ak-ar',
          index: 0,
          label: 'Arabic',
          language: 'en',
          kind: 'full',
          format: 'srt',
          converted: true,
          playable: true,
          default: true,
        },
      ],
    })
    const validated = validateAniPayload(payload, expected())
    const stream = await buildAniProviderStream(validated, { malId: MAL_ID, episode: EPISODE, audio: 'sub' })

    expect(stream.subtitlePaths[0]).toMatch(/^\/api\/proxy\/ani-subtitle\?/)
    // Nothing the browser holds mentions the key or the ani-api.
    expect(stream.subtitlePaths[0] as string).not.toContain(SENTINEL_KEY)
    expect(stream.subtitlePaths[0] as string).not.toContain(ANI_BASE)
  })

  it('falls back to the ani token when a track has no absolute url at all', async () => {
    const payload = anikotoStreamPayload({
      subtitles: [{
        proxied_url: '/v1/subtitles/only-relative.vtt',
        id: 'only-relative',
        index: 0,
        label: 'English',
        language: 'en',
        format: 'vtt',
        converted: false,
        playable: true,
        default: true,
      }],
    })
    const stream = await buildAniProviderStream(validateAniPayload(payload, expected()), { malId: MAL_ID, episode: EPISODE, audio: 'sub' })
    expect(stream.subtitlePaths[0]).toMatch(/^\/api\/proxy\/ani-subtitle\?/)
  })

  it('signs a ZokoAnime vtt track the same way, from its raw url', async () => {
    const payload = anikotoStreamPayload({
      provider: 'zokoanime',
      masterUrl: 'https://hls.dramahot.top/abc/master.m3u8',
      subtitles: [{
        url: 'https://hls.dramahot.top/abc/subs/english.vtt',
        proxied_url: '/v1/subtitles/tok1.vtt',
        id: 'sub-1',
        index: 0,
        label: 'English',
        language: 'en',
        kind: 'full',
        format: 'vtt',
        converted: false,
        playable: true,
        default: true,
      }],
    })
    const stream = await buildAniProviderStream(validateAniPayload(payload, expected()), { malId: MAL_ID, episode: EPISODE, audio: 'sub' })
    const verified = await decodeSignedSubtitle(stream.subtitlePaths[0] as string)
    expect(verified.targetUrl).toBe('https://hls.dramahot.top/abc/subs/english.vtt')
    expect(verified.headers).toEqual({ Referer: ANIKOTO_REFERER })
  })
})

describe('AniKoto srclang comes from the label, never from `language`', () => {
  it('derives pt/es/en from the One Piece labels (all reported as en)', async () => {
    const validated = validateAniPayload(anikotoStreamPayload(), expected())
    const stream = await buildAniProviderStream(validated, { malId: MAL_ID, episode: EPISODE, audio: 'sub' })
    const byLabel = Object.fromEntries(stream.subtitles.map((track) => [track.label, track.srclang]))
    expect(byLabel['Portuguese (- Portuguese(Brazil))']).toBe('pt')
    expect(byLabel['Spanish (- Spanish(Latin America))']).toBe('es')
    expect(byLabel['English']).toBe('en')
  })

  it('gives Arabic/French/Thai their own codes on Attack on Titan', async () => {
    const validated = validateAniPayload(attackOnTitanPayload(), { ...expected(), malId: 16498 })
    const stream = await buildAniProviderStream(validated, { malId: 16498, episode: EPISODE, audio: 'sub' })
    expect(stream.subtitles.map((track) => track.srclang)).toEqual(['ar', 'fr', 'th'])
  })

  it('maps all nine Naruto labels without ever echoing `en`', async () => {
    const validated = validateAniPayload(narutoPayload(), { ...expected(), malId: 20 })
    const stream = await buildAniProviderStream(validated, { malId: 20, episode: EPISODE, audio: 'sub' })
    const byLabel = Object.fromEntries(stream.subtitles.map((track) => [track.label, track.srclang]))
    expect(byLabel).toEqual({
      Arabic: 'ar',
      English: 'en',
      French: 'fr',
      Indonesian: 'id',
      Italian: 'it',
      'Portuguese (- Portuguese(Brazil))': 'pt',
      Russian: 'ru',
      'Spanish (- Spanish(Latin America))': 'es',
      Thai: 'th',
    })
  })

  it('keeps the declared language for every other provider, false or not', async () => {
    const payload = anikotoStreamPayload({
      provider: 'zokoanime',
      masterUrl: 'https://hls.dramahot.top/abc/master.m3u8',
      subtitles: [{
        url: 'https://hls.dramahot.top/abc/subs/x.vtt',
        id: 'z-1',
        index: 0,
        label: 'Arabic',
        language: 'en',
        kind: 'full',
        format: 'vtt',
        converted: false,
        playable: true,
        default: true,
      }],
    })
    const stream = await buildAniProviderStream(validateAniPayload(payload, expected()), { malId: MAL_ID, episode: EPISODE, audio: 'sub' })
    expect(stream.subtitles[0].srclang).toBe('en')
  })
})

describe('intro / outro markers', () => {
  it('normalises [31, 111] and [1376, 1447] into the player shape', async () => {
    const validated = validateAniPayload(anikotoStreamPayload(), expected())
    const stream = await buildAniProviderStream(validated, { malId: MAL_ID, episode: EPISODE, audio: 'sub' })
    expect(stream.intro).toEqual({ start: 31, end: 111 })
    expect(stream.outro).toEqual({ start: 1376, end: 1447 })
  })

  it('treats [0, 0] as unknown and keeps the valid half (Solo Leveling)', async () => {
    const validated = validateAniPayload(soloLevelingPayload(), { ...expected(), malId: SOLO_LEVELING_MAL })
    const stream = await buildAniProviderStream(validated, { malId: SOLO_LEVELING_MAL, episode: EPISODE, audio: 'sub' })
    expect(stream.intro).toBeNull()
    expect(stream.outro).toEqual({ start: 1325, end: 1414 })
  })

  it('rejects every malformed range', () => {
    expect(normalizeTimeRange([0, 0])).toBeNull()
    expect(normalizeTimeRange([111, 31])).toBeNull()
    expect(normalizeTimeRange([31])).toBeNull()
    expect(normalizeTimeRange([Number.NaN, 40])).toBeNull()
    expect(normalizeTimeRange([31, Number.POSITIVE_INFINITY])).toBeNull()
    expect(normalizeTimeRange(null)).toBeNull()
    expect(normalizeTimeRange('31,111')).toBeNull()
    expect(normalizeTimeRange([31, 111])).toEqual({ start: 31, end: 111 })
    // A provider that nests the same numbers under start/end works too.
    expect(normalizeTimeRange({ start: 5, end: 6 })).toEqual({ start: 5, end: 6 })
  })

  it('is null for a payload that omits both fields', () => {
    const payload = anikotoStreamPayload({ intro: null, outro: null })
    const validated = validateAniPayload(payload, expected())
    expect(validated.intro).toBeNull()
    expect(validated.outro).toBeNull()
  })
})

describe('ANI_ANIKOTO_REQUIRE_SUBTITLE', () => {
  it('refuses a zero-subtitle AniKoto episode by default', async () => {
    expect(await codeOf(() => validateAniPayload(anikotoNoSubtitlePayload(), expected()))).toBe('ANI_NO_SUBTITLE')
  })

  it('lets it through when the owner flips the switch to 0', async () => {
    const payload = anikotoNoSubtitlePayload()
    const validated = validateAniPayload(payload, { ...expected(), anikotoRequireSubtitle: false })
    expect(validated.tracks).toHaveLength(0)

    const stream = await buildAniProviderStream(validated, { malId: MAL_ID, episode: EPISODE, audio: 'sub' })
    expect(stream.subtitles).toEqual([])
    expect(stream.subtitlePaths).toEqual([])
  })

  it('does not relax the rule for ZokoAnime', async () => {
    const payload = anikotoStreamPayload({
      provider: 'zokoanime',
      masterUrl: 'https://hls.dramahot.top/abc/master.m3u8',
      subtitles: [],
    })
    expect(await codeOf(() => validateAniPayload(payload, { ...expected(), anikotoRequireSubtitle: false }))).toBe('ANI_NO_SUBTITLE')
  })

  it('reads the variable at request time', () => {
    expect(readAniConfig(env()).anikotoRequireSubtitle).toBe(true)
    expect(readAniConfig(env({ ANI_ANIKOTO_REQUIRE_SUBTITLE: '0' })).anikotoRequireSubtitle).toBe(false)
    expect(readAniConfig(env({ ANI_ANIKOTO_REQUIRE_SUBTITLE: '' })).anikotoRequireSubtitle).toBe(true)
  })
})

describe('dub guard: the dub must not be the sub', () => {
  function input(overrides: Partial<TryAniInput> = {}): TryAniInput {
    return {
      anilistId: 1001,
      episodeNumber: EPISODE,
      malId: SOLO_LEVELING_MAL,
      audio: 'dub',
      excluded: new Set<string>(),
      probe: async () => true,
      env: env({ ANI_DUB_ENABLED: '1' }),
      ...overrides,
    }
  }

  function router(pair: { sub: unknown, dub: unknown }) {
    return vi.fn(async (upstream: unknown) => {
      const url = String(upstream)
      if (url.includes('audio=dub')) return Response.json(pair.dub)
      if (url.includes('audio=sub')) return Response.json(pair.sub)
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
  }

  it('rejects a dub payload whose master_url equals the sub payload s', async () => {
    globalThis.fetch = router(identicalSubDubPair())
    const result = await tryAni(input())
    expect(result.status).toBe('failed')
    expect(result.status === 'ok' ? '' : result.reason).toBe('ANI_DUB_SAME_AS_SUB')
  })

  it('accepts a dub payload with its own master_url', async () => {
    const { sub } = identicalSubDubPair()
    const dub = { ...soloLevelingPayload(), master_url: `https://${ANIKOTO_MASTER_HOST}/hls/solo-leveling/ep1/dub/master.m3u8` }
    globalThis.fetch = router({ sub, dub })
    const result = await tryAni(input())
    expect(result.status).toBe('ok')
  })

  it('does not run at all for a sub request', async () => {
    const fetchMock = router(identicalSubDubPair())
    globalThis.fetch = fetchMock
    const result = await tryAni(input({ audio: 'sub' }))
    expect(result.status).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('lets the payload through when the sub cannot be read, rather than guessing', async () => {
    globalThis.fetch = vi.fn(async (upstream: unknown) => {
      const url = String(upstream)
      if (url.includes('audio=dub')) return Response.json(identicalSubDubPair().dub)
      return new Response('', { status: 500 })
    }) as unknown as typeof fetch
    const result = await tryAni(input())
    expect(result.status).toBe('ok')
  })
})

describe('master host allow-list', () => {
  it('accepts nexabloom.top and the older hosts, subdomains included', () => {
    expect(isAllowedMasterUrl(ANIKOTO_MASTER_URL)).toBe(true)
    expect(isAllowedMasterUrl('https://mbox-2.nexabloom.top/x/master.m3u8')).toBe(true)
    expect(isAllowedMasterUrl('https://hls.dramahot.top/x/master.m3u8')).toBe(true)
    expect(isAllowedMasterUrl('https://hls1.drama1.cfd/x/master.m3u8')).toBe(true)
  })

  it('still refuses rotations, lookalikes and plain http', () => {
    expect(isAllowedMasterUrl('https://seg1.twilightharbor.space/x/master.m3u8')).toBe(false)
    expect(isAllowedMasterUrl('https://nexabloom.top.attacker.example/x.m3u8')).toBe(false)
    expect(isAllowedMasterUrl('https://evil.example/x.m3u8')).toBe(false)
    expect(isAllowedMasterUrl('http://fetch.nexabloom.top/x.m3u8')).toBe(false)
  })

  it('lets ANI_MASTER_HOSTS replace the list entirely', () => {
    const hosts = allowedMasterHosts({ ANI_MASTER_HOSTS: 'example.test, .mbox.example.test' })
    expect(hosts).toEqual(['example.test', 'mbox.example.test'])
    expect(isAllowedMasterUrl('https://a.example.test/x.m3u8', hosts)).toBe(true)
    expect(isAllowedMasterUrl(ANIKOTO_MASTER_URL, hosts)).toBe(false)
  })

  it('enforces the configured list inside validation', async () => {
    const payload = anikotoStreamPayload()
    expect(await codeOf(() => validateAniPayload(payload, { ...expected(), masterHosts: ['dramahot.top'] }))).toBe('ANI_HOST_NOT_ALLOWED')
    expect(await codeOf(() => validateAniPayload(payload, { ...expected(), masterHosts: ['nexabloom.top'] }))).toBe('RESOLVED')
  })

  it('applies the ANI_MASTER_HOSTS env value through tryAni', async () => {
    globalThis.fetch = vi.fn(async () => Response.json(anikotoStreamPayload())) as unknown as typeof fetch
    const result = await tryAni({
      anilistId: 1001,
      episodeNumber: EPISODE,
      malId: MAL_ID,
      audio: 'sub',
      excluded: new Set<string>(),
      probe: async () => true,
      env: env({ ANI_MASTER_HOSTS: 'dramahot.top' }),
    })
    expect(result.status === 'ok' ? 'OK' : result.reason).toBe('ANI_HOST_NOT_ALLOWED')
  })
})

describe('cache lifetime', () => {
  it('caps AniKoto at 10 minutes and never extends it from url_lifetime', () => {
    expect(cacheTtlMsFor(anikotoStreamPayload())).toBe(10 * 60 * 1000)
    expect(cacheTtlMsFor(anikotoStreamPayload({ urlLifetime: { observed_valid_for_minutes: 60 } }))).toBe(10 * 60 * 1000)
  })

  it('honours a shorter claim from a provider that publishes one', () => {
    expect(cacheTtlMsFor(anikotoStreamPayload({ provider: 'zokoanime', urlLifetime: { observed_valid_for_minutes: 28 } }))).toBe(10 * 60 * 1000)
    expect(cacheTtlMsFor(anikotoStreamPayload({ provider: 'zokoanime', urlLifetime: { observed_valid_for_minutes: 4 } }))).toBe(2 * 60 * 1000)
  })

  it('re-resolves an AniKoto episode after ten minutes and not before', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-15T10:00:00Z') })
    try {
      const fetchMock = vi.fn(async () => Response.json(anikotoStreamPayload()))
      globalThis.fetch = fetchMock as unknown as typeof fetch
      const options = { env: env({ ANI_MASTER_HOSTS: 'nexabloom.top' }) }

      await getAniStream(MAL_ID, EPISODE, 'sub', options)
      vi.setSystemTime(new Date('2026-11-15T10:09:59Z'))
      await getAniStream(MAL_ID, EPISODE, 'sub', options)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      vi.setSystemTime(new Date('2026-11-15T10:10:01Z'))
      await getAniStream(MAL_ID, EPISODE, 'sub', options)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('tryAni on an AniKoto payload', () => {
  it('logs the RESOLVED mal id, not the null input', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    globalThis.fetch = vi.fn(async () => Response.json(anikotoStreamPayload())) as unknown as typeof fetch

    const result = await tryAni({
      anilistId: 1001,
      episodeNumber: EPISODE,
      malId: null,
      audio: 'sub',
      excluded: new Set<string>(),
      probe: async () => true,
      lookupMalId: async () => MAL_ID,
      env: env(),
    })
    expect(result.status).toBe('ok')

    const lines = log.mock.calls
      .filter((call) => call[0] === 'ani_outcome')
      .map((call) => String(call[1]))
    const ok = lines.map((line) => JSON.parse(line) as { outcome: string, mal_id: number | null }).find((line) => line.outcome === 'ok')
    expect(ok?.mal_id).toBe(MAL_ID)
    // Still no key, no ani-api host.
    expect(lines.join('')).not.toContain(SENTINEL_KEY)
    expect(lines.join('')).not.toContain(ANI_BASE)
  })

  it('serves the AniKoto master url with the megaplay Referer', async () => {
    globalThis.fetch = vi.fn(async () => Response.json(anikotoStreamPayload())) as unknown as typeof fetch
    const result = await tryAni({
      anilistId: 1001,
      episodeNumber: EPISODE,
      malId: MAL_ID,
      audio: 'sub',
      excluded: new Set<string>(),
      probe: async () => true,
      env: env(),
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.stream.streamUrl).toBe(ANIKOTO_MASTER_URL)
    expect(result.stream.headers).toEqual({ Referer: ANIKOTO_REFERER })
    expect(result.stream.intro).toEqual({ start: 31, end: 111 })
    expect(result.stream.outro).toEqual({ start: 1376, end: 1447 })
  })
})
