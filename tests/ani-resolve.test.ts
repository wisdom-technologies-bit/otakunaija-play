import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetAniState } from '@/lib/ani/client'
import { aniBucket, withinAniPercent } from '@/lib/ani/config'
import { AniRequestError } from '@/lib/ani/errors'
import {
  ALLOWED_MASTER_HOSTS,
  aniSkipReason,
  buildAniProviderStream,
  isAllowedMasterUrl,
  needsConversion,
  orderSubtitles,
  tryAni,
  validateAniPayload,
  type TryAniInput,
  type TryAniResult,
} from '@/lib/ani/resolve'
import { readAniConfig } from '@/lib/ani/config'
import { MAL_ID, ANI_BASE, ANI_ENV, EPISODE, SENTINEL_KEY, aniStreamPayload } from './fixtures/ani'

const originalFetch = globalThis.fetch

function env(overrides: Record<string, string> = {}) {
  return { ...ANI_ENV, ...overrides }
}

function config(overrides: Record<string, string> = {}) {
  return readAniConfig(env(overrides))
}

async function codeOf(run: () => unknown) {
  try {
    await run()
    return 'RESOLVED'
  } catch (error) {
    return error instanceof AniRequestError ? error.code : `UNEXPECTED:${String(error)}`
  }
}

const expected = { malId: MAL_ID, episode: EPISODE, audio: 'sub' as const, requireSubtitle: true }

/** Narrowed reason for assertions on a union result. */
function reasonOf(result: TryAniResult): string {
  return result.status === 'ok' ? 'OK' : result.reason
}

beforeEach(() => {
  __resetAniState()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  __resetAniState()
})

describe('validateAniPayload', () => {
  it('accepts a verified payload and exposes the referer', () => {
    const validated = validateAniPayload(aniStreamPayload(), expected)
    expect(validated.masterUrl).toBe('https://hls.dramahot.top/abc/master.m3u8')
    expect(validated.referer).toBe('https://zokoanime.video/')
    expect(validated.quality).toBe('1080p')
    expect(validated.tracks).toHaveLength(5)
  })

  it('refuses a stream the provider did not verify', async () => {
    const payload = aniStreamPayload({ mal: { ...aniStreamPayload().mal!, stream_verified: false } })
    expect(await codeOf(() => validateAniPayload(payload, expected))).toBe('ANI_NOT_VERIFIED')
    expect(await codeOf(() => validateAniPayload(aniStreamPayload({ mal: null }), expected))).toBe('ANI_NOT_VERIFIED')
  })

  it('refuses a different MAL id or episode', async () => {
    const wrongId = aniStreamPayload({ mal: { ...aniStreamPayload().mal!, mal_id: 22 } })
    expect(await codeOf(() => validateAniPayload(wrongId, expected))).toBe('ANI_EPISODE_MISMATCH')

    const wrongEpisode = aniStreamPayload({ mal: { ...aniStreamPayload().mal!, mal_episode: 2 } })
    expect(await codeOf(() => validateAniPayload(wrongEpisode, expected))).toBe('ANI_EPISODE_MISMATCH')
  })

  it('refuses a non-hls stream or a host outside the allow-list', async () => {
    expect(await codeOf(() => validateAniPayload(aniStreamPayload({ stream_type: 'mp4' }), expected))).toBe('ANI_BAD_STREAM_TYPE')

    const evil = aniStreamPayload({ master_url: 'https://evil.example/abc/master.m3u8' })
    expect(await codeOf(() => validateAniPayload(evil, expected))).toBe('ANI_HOST_NOT_ALLOWED')

    const plain = aniStreamPayload({ master_url: 'http://hls.dramahot.top/abc/master.m3u8' })
    expect(await codeOf(() => validateAniPayload(plain, expected))).toBe('ANI_HOST_NOT_ALLOWED')
  })

  it('refuses a payload with no playable variant', async () => {
    const payload = aniStreamPayload({ variants: [{ quality: '1080p', playable: false }] })
    expect(await codeOf(() => validateAniPayload(payload, expected))).toBe('ANI_NO_VARIANT')
  })

  it('requires a playable subtitle track for sub, unless the switch is off', async () => {
    const payload = aniStreamPayload({
      subtitles: [{ url: 'https://hls.dramahot.top/a.vtt', id: 'x', playable: false, format: 'vtt' }],
    })
    expect(await codeOf(() => validateAniPayload(payload, expected))).toBe('ANI_NO_SUBTITLE')
    expect(await codeOf(() => validateAniPayload(payload, { ...expected, requireSubtitle: false }))).toBe('RESOLVED')
  })
})

describe('isAllowedMasterUrl', () => {
  it('accepts the documented hosts and their subdomains only', () => {
    expect(isAllowedMasterUrl('https://hls.dramahot.top/x/master.m3u8')).toBe(true)
    expect(isAllowedMasterUrl('https://hls1.drama1.cfd/x/master.m3u8')).toBe(true)
    expect(isAllowedMasterUrl('https://dramahot.top.attacker.example/x.m3u8')).toBe(false)
    expect(isAllowedMasterUrl('https://attacker.example/dramahot.top.m3u8')).toBe(false)
    expect(isAllowedMasterUrl(`ftp://${ALLOWED_MASTER_HOSTS[0]}/x.m3u8`)).toBe(false)
    expect(isAllowedMasterUrl(null)).toBe(false)
  })
})

describe('orderSubtitles', () => {
  it('puts the default first, then English, then the rest in provider order', () => {
    const ordered = orderSubtitles(aniStreamPayload().subtitles!)
    expect(ordered.map((track) => track.id)).toEqual(['sub-1', 'sub-2', 'sub-3', 'sub-4'])
  })

  it('keeps signs tracks when they are the only ones', () => {
    const tracks = aniStreamPayload().subtitles!.filter((track) => track.kind === 'signs')
    expect(orderSubtitles(tracks).map((track) => track.id)).toEqual(['sub-5'])
  })

  it('drops signs when a full track exists', () => {
    const ordered = orderSubtitles(aniStreamPayload().subtitles!)
    expect(ordered.some((track) => track.kind === 'signs')).toBe(false)
  })

  it('ignores unplayable tracks', () => {
    const ordered = orderSubtitles([
      { id: 'a', playable: false, format: 'vtt', url: 'https://hls.dramahot.top/a.vtt' },
      { id: 'b', playable: true, format: 'vtt', url: 'https://hls.dramahot.top/b.vtt' },
    ])
    expect(ordered.map((track) => track.id)).toEqual(['b'])
  })
})

describe('needsConversion', () => {
  it('is true for converted or non-vtt tracks only', () => {
    const [english, , portuguese] = aniStreamPayload().subtitles!
    expect(needsConversion(english)).toBe(false)
    expect(needsConversion(portuguese)).toBe(true)
    expect(needsConversion({ format: 'vtt', converted: true })).toBe(true)
    expect(needsConversion({ format: 'vtt' })).toBe(false)
  })
})

describe('buildAniProviderStream', () => {
  it('keeps the provider labels, orders tracks and signs only the converted ones', async () => {
    process.env.PROXY_SIGNING_SECRET = 'test-secret'
    const validated = validateAniPayload(aniStreamPayload(), expected)
    const stream = await buildAniProviderStream(validated, { malId: MAL_ID, episode: EPISODE, audio: 'sub' })

    expect(stream.headers).toEqual({ Referer: 'https://zokoanime.video/' })
    expect(stream.server).toBeNull()
    expect(stream.subtitles.map((track) => track.label)).toEqual([
      'English (- (Crunchyroll))',
      'Spanish',
      'Portuguese - Brazil',
      'Arabic',
    ])
    expect(stream.subtitles[0].default).toBe(true)
    expect(stream.subtitles[0].srclang).toBe('en')

    // vtt track: responseFor signs its own url. srt/ass: pre-signed ani token.
    expect(stream.subtitlePaths[0]).toBeNull()
    expect(stream.subtitlePaths[1]).toBeNull()
    expect(stream.subtitlePaths[2]).toMatch(/^\/api\/proxy\/ani-subtitle\?/)
    expect(stream.subtitlePaths[3]).toMatch(/^\/api\/proxy\/ani-subtitle\?/)
  })

  it('omits srclang when the provider says the language is unknown', async () => {
    process.env.PROXY_SIGNING_SECRET = 'test-secret'
    const payload = aniStreamPayload({
      subtitles: [{ id: 'u', index: 0, label: 'Forced', language: 'und', kind: 'full', format: 'vtt', playable: true, url: 'https://hls.dramahot.top/u.vtt' }],
    })
    const stream = await buildAniProviderStream(validateAniPayload(payload, expected), { malId: MAL_ID, episode: EPISODE, audio: 'sub' })
    expect(stream.subtitles[0].srclang).toBeUndefined()
    expect(stream.subtitles[0].label).toBe('Forced')
  })
})

describe('aniSkipReason', () => {
  const base = { anilistId: 1001, audio: 'sub' as const, excluded: new Set<string>() }

  it('stops on every cheap gate, in order', () => {
    expect(aniSkipReason(base, config({ ANI_PROVIDER_ENABLED: '0' }))).toBe('ANI_DISABLED')
    expect(aniSkipReason(base, config({ ANI_API_KEY: '' }))).toBe('ANI_NOT_CONFIGURED')
    expect(aniSkipReason(base, config({ ANI_API_BASE_URL: '' }))).toBe('ANI_NOT_CONFIGURED')
    expect(aniSkipReason({ ...base, excluded: new Set(['ani:default']) }, config())).toBe('ANI_EXCLUDED')
    expect(aniSkipReason({ ...base, excluded: new Set(['aniwaves:default']) }, config())).toBeNull()
    expect(aniSkipReason({ ...base, anilistId: 0 }, config({ ANI_PROVIDER_PERCENT: '0' }))).toBe('ANI_OUT_OF_PERCENT')
    expect(aniSkipReason(base, config())).toBeNull()
  })

  it('keeps dub out unless explicitly enabled', () => {
    expect(aniSkipReason({ ...base, audio: 'dub' }, config())).toBe('ANI_DUB_DISABLED')
    expect(aniSkipReason({ ...base, audio: 'dub' }, config({ ANI_DUB_ENABLED: '1' }))).toBeNull()
  })
})

describe('rollout bucket', () => {
  it('is stable for the same AniList id and spread across 0-99', () => {
    const buckets = new Set<number>()
    for (let anilistId = 1; anilistId <= 500; anilistId += 1) {
      const bucket = aniBucket(anilistId)
      expect(bucket).toBeGreaterThanOrEqual(0)
      expect(bucket).toBeLessThan(100)
      expect(aniBucket(anilistId)).toBe(bucket)
      buckets.add(bucket)
    }
    expect(buckets.size).toBeGreaterThan(50)
  })

  it('treats 0 as off and 100 as everything', () => {
    expect(withinAniPercent(1001, 0)).toBe(false)
    expect(withinAniPercent(1001, 100)).toBe(true)
    const bucket = aniBucket(1001)
    expect(withinAniPercent(1001, bucket)).toBe(false)
    expect(withinAniPercent(1001, bucket + 1)).toBe(true)
  })
})

describe('tryAni', () => {
  function input(overrides: Partial<TryAniInput> = {}): TryAniInput {
    return {
      anilistId: 1001,
      episodeNumber: EPISODE,
      malId: MAL_ID,
      audio: 'sub',
      excluded: new Set<string>(),
      probe: async () => true,
      env: env(),
      ...overrides,
    }
  }

  it('resolves a verified stream', async () => {
    globalThis.fetch = vi.fn(async () => Response.json(aniStreamPayload())) as unknown as typeof fetch
    const result = await tryAni(input())
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.stream.streamUrl).toBe('https://hls.dramahot.top/abc/master.m3u8')
  })

  it('does not touch the database when a cheap gate fails', async () => {
    const lookupMalId = vi.fn(async () => MAL_ID)
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const disabled = await tryAni(input({ env: env({ ANI_PROVIDER_ENABLED: '0' }), malId: null, lookupMalId }))
    expect(disabled.status).toBe('skipped')
    expect(reasonOf(disabled)).toBe('ANI_DISABLED')

    const excluded = await tryAni(input({ excluded: new Set(['ani:default']), malId: null, lookupMalId }))
    expect(reasonOf(excluded)).toBe('ANI_EXCLUDED')

    const outOfPercent = await tryAni(input({ env: env({ ANI_PROVIDER_PERCENT: '0' }), malId: null, lookupMalId }))
    expect(reasonOf(outOfPercent)).toBe('ANI_OUT_OF_PERCENT')

    expect(lookupMalId).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('looks the MAL id up only after the gates passed', async () => {
    globalThis.fetch = vi.fn(async () => Response.json(aniStreamPayload())) as unknown as typeof fetch
    const lookupMalId = vi.fn(async () => MAL_ID)

    const ok = await tryAni(input({ malId: null, lookupMalId }))
    expect(lookupMalId).toHaveBeenCalledTimes(1)
    expect(ok.status).toBe('ok')

    const missing = vi.fn(async () => null)
    const skipped = await tryAni(input({ malId: null, lookupMalId: missing }))
    expect(skipped.status).toBe('skipped')
    expect(reasonOf(skipped)).toBe('ANI_NO_MAL_ID')
  })

  it('skips when the playlist probe fails', async () => {
    globalThis.fetch = vi.fn(async () => Response.json(aniStreamPayload())) as unknown as typeof fetch
    const result = await tryAni(input({ probe: async () => false }))
    expect(result.status).toBe('failed')
    expect(reasonOf(result)).toBe('ANI_PROBE_FAILED')
  })

  it('reports each documented ani-api error code as a skip', async () => {
    for (const [code, fixture] of Object.entries({
      MAL_NOT_FOUND: 'MAL_NOT_FOUND',
      MAL_NOT_MAPPED: 'MAL_NOT_MAPPED',
      MAL_MAPPING_AMBIGUOUS: 'MAL_MAPPING_AMBIGUOUS',
      MAL_EPISODE_NOT_FOUND: 'MAL_EPISODE_NOT_FOUND',
      MAL_EPISODE_MISMATCH: 'MAL_EPISODE_MISMATCH',
    })) {
      __resetAniState()
      const { body, status } = (await import('./fixtures/ani')).ANI_ERROR_BODIES[fixture]
      globalThis.fetch = vi.fn(async () => Response.json(body, { status })) as unknown as typeof fetch
      const result = await tryAni(input())
      expect(result.status).toBe('failed')
      expect(reasonOf(result)).toBe(code)
    }
  })

  it('skips an unverified stream instead of guessing', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json(aniStreamPayload({ mal: { ...aniStreamPayload().mal!, stream_verified: false } })),
    ) as unknown as typeof fetch
    const result = await tryAni(input())
    expect(result.status).toBe('failed')
    expect(reasonOf(result)).toBe('ANI_NOT_VERIFIED')
  })

  it('never leaks the key into an outcome or the console line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    globalThis.fetch = vi.fn(async () => Response.json(aniStreamPayload())) as unknown as typeof fetch
    await tryAni(input())
    const lines = JSON.stringify(log.mock.calls)
    expect(lines).toContain('ani_outcome')
    expect(lines).not.toContain(SENTINEL_KEY)
    expect(lines).not.toContain(ANI_BASE)
  })
})
