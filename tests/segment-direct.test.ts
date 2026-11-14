import { afterEach, describe, expect, it, vi } from 'vitest'

import { directSegmentHosts, isDirectSegment } from '@/lib/segment-direct'
import { rewriteManifest } from '@/lib/proxy-signing'

const originalEnv = { ...process.env }

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio/en.m3u8"',
  '#EXT-X-KEY:METHOD=AES-128,URI="https://hls1.drama1.cfd/abc/key.bin"',
  '#EXT-X-MAP:URI="https://hls1.drama1.cfd/abc/init.mp4"',
  '#EXT-X-TARGETDURATION:6',
  'https://hls1.drama1.cfd/abc/0001.ts.jpg',
  '/abc/0002.ts.jpg',
  '#EXT-X-ENDLIST',
  '',
].join('\n')

function setHosts(value: string | undefined) {
  if (value === undefined) delete process.env.DIRECT_SEGMENT_HOSTS
  else process.env.DIRECT_SEGMENT_HOSTS = value
  process.env.PROXY_SIGNING_SECRET = 'test-secret'
}

function lines(body: string) {
  return body.split('\n')
}

afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
})

describe('directSegmentHosts', () => {
  it('is empty for every documented "off" spelling', () => {
    for (const value of [undefined, '', 'none', 'NONE', 'off', '0', 'false', 'no', '  ']) {
      expect(directSegmentHosts(value)).toEqual([])
    }
  })

  it('parses one host, a list, case and trailing slashes', () => {
    expect(directSegmentHosts('hls1.drama1.cfd')).toEqual(['hls1.drama1.cfd'])
    expect(directSegmentHosts('HLS1.Drama1.CFD/, hls.dramahot.top')).toEqual(['hls1.drama1.cfd', 'hls.dramahot.top'])
    expect(directSegmentHosts('.drama1.cfd')).toEqual(['drama1.cfd'])
  })

  it('matches the exact host and its subdomains only', () => {
    const hosts = ['drama1.cfd']
    expect(isDirectSegment('https://drama1.cfd/a.ts', hosts)).toBe(true)
    expect(isDirectSegment('https://hls1.drama1.cfd/a.ts', hosts)).toBe(true)
    expect(isDirectSegment('https://drama1.cfd.attacker.example/a.ts', hosts)).toBe(false)
    expect(isDirectSegment('https://notdrama1.cfd/a.ts', hosts)).toBe(false)
    expect(isDirectSegment('/relative/0001.ts', hosts)).toBe(false)
    expect(isDirectSegment('https://hls1.drama1.cfd/a.ts', [])).toBe(false)
  })
})

describe('rewriteManifest without DIRECT_SEGMENT_HOSTS', () => {
  it('proxies every media URI, keeps playlist lines proxied and KEY/MAP proxied', async () => {
    setHosts(undefined)
    const body = await rewriteManifest(PLAYLIST, 'https://hls1.drama1.cfd/abc/master.m3u8', { Referer: 'https://zokoanime.video/' })
    const out = lines(body)

    expect(out[0]).toBe('#EXTM3U')
    expect(out[3]).toContain('URI="/api/proxy/segment?')
    expect(out[4]).toContain('URI="/api/proxy/segment?')
    expect(out[6]).toMatch(/^\/api\/proxy\/segment\?/)
    expect(out[7]).toMatch(/^\/api\/proxy\/segment\?/)
    // Pre-existing behaviour kept on purpose: only KEY/MAP URIs and bare media
    // lines are rewritten today, so an EXT-X-MEDIA tag passes through as-is.
    expect(out[2]).toBe('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio/en.m3u8"')
    expect(out[5]).toBe('#EXT-X-TARGETDURATION:6')
    expect(body).not.toContain('https://hls1.drama1.cfd/abc/0001.ts.jpg')
  })
})

describe('rewriteManifest with DIRECT_SEGMENT_HOSTS', () => {
  it('leaves matching segments absolute and still proxies playlists, KEY and MAP', async () => {
    setHosts('hls1.drama1.cfd')
    const body = await rewriteManifest(PLAYLIST, 'https://hls1.drama1.cfd/abc/master.m3u8', { Referer: 'https://zokoanime.video/' })
    const out = lines(body)

    expect(out[6]).toBe('https://hls1.drama1.cfd/abc/0001.ts.jpg')
    expect(out[7]).toBe('https://hls1.drama1.cfd/abc/0002.ts.jpg')
    expect(out[3]).toContain('URI="/api/proxy/segment?')
    expect(out[4]).toContain('URI="/api/proxy/segment?')
    expect(out[2]).toBe('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio/en.m3u8"')
    expect(out[0]).toBe('#EXTM3U')
  })

  it('keeps a segment host that is not on the list proxied', async () => {
    setHosts('hls.dramahot.top')
    const body = await rewriteManifest(PLAYLIST, 'https://hls1.drama1.cfd/abc/master.m3u8', { Referer: 'https://zokoanime.video/' })
    expect(lines(body)[6]).toMatch(/^\/api\/proxy\/segment\?/)
  })
})
