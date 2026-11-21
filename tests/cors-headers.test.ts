import { describe, expect, it } from 'vitest'

import { corsHeaders, proxyJson } from '@/lib/proxy-signing'
import * as manifest from '@/app/api/proxy/manifest/route'
import * as segment from '@/app/api/proxy/segment/route'
import * as subtitle from '@/app/api/proxy/subtitle/route'
import * as aniSubtitle from '@/app/api/proxy/ani-subtitle/route'
import * as watch from '@/app/api/watch/[playId]/route'

/**
 * Every response the player reads must be readable cross-origin, including the
 * error ones. A browser reports a CORS failure instead of the real status when
 * the header is missing, which is what made a 5xx edge response look like a dead
 * provider.
 */

const PROXY_ROUTES = [
  ['/api/proxy/manifest', manifest],
  ['/api/proxy/segment', segment],
  ['/api/proxy/subtitle', subtitle],
  ['/api/proxy/ani-subtitle', aniSubtitle],
  ['/api/watch/[playId]', watch],
] as const

describe('corsHeaders', () => {
  it('allows the Range header, which a media element sends when seeking', () => {
    expect(corsHeaders()['Access-Control-Allow-Headers']).toContain('Range')
    expect(corsHeaders()['Access-Control-Allow-Headers']).toContain('Content-Type')
  })

  it('exposes the length, range and type headers back to the caller', () => {
    const exposed = corsHeaders()['Access-Control-Expose-Headers']
    for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Type']) {
      expect(exposed).toContain(name)
    }
  })

  it('keeps a wildcard origin', () => {
    expect(corsHeaders()['Access-Control-Allow-Origin']).toBe('*')
  })
})

describe('every route answers OPTIONS with the same CORS shape', () => {
  it.each(PROXY_ROUTES)('%s', async (_name, route) => {
    expect(typeof route.OPTIONS).toBe('function')
    const response = await route.OPTIONS()
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Range')
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Content-Range')
  })
})

describe('error responses carry CORS', () => {
  it('proxyJson keeps the headers on a 4xx and a 5xx', () => {
    for (const status of [403, 404, 502]) {
      const response = proxyJson({ error: 'X' }, status)
      expect(response.status).toBe(status)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    }
  })

  it('a rejected signature is readable by the browser', async () => {
    const response = await segment.GET(new Request('https://play.test/api/proxy/segment?u=a&h=b&e=1&s=bad'))
    expect(response.status).toBe(403)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('a watch lookup for an unknown play id is readable', async () => {
    const response = await watch.GET(new Request('https://play.test/api/watch/nope'), {
      params: Promise.resolve({ playId: 'nope' }),
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})
