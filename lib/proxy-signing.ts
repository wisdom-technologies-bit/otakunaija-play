import { directSegmentHosts, isDirectSegment } from '@/lib/segment-direct'

function encode(value: string) {
  return btoa(unescape(encodeURIComponent(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decode(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  return decodeURIComponent(escape(atob(padded)))
}

function secret() {
  const value = process.env.PROXY_SIGNING_SECRET
  if (!value) throw new Error('PROXY_SIGNING_SECRET is not configured')
  return value
}

async function hmac(message: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function signProxyUrl(targetUrl: string, headers: Record<string, string>, routeBasePath: string) {
  const u = encode(targetUrl)
  const h = encode(JSON.stringify(headers))
  const e = Math.floor(Date.now() / 1000) + 14_400
  const s = await hmac(`${u}.${h}.${e}`)
  return `${routeBasePath}?u=${u}&h=${h}&e=${e}&s=${s}`
}

export async function verifyProxySignature(u: string, h: string, e: string, s: string) {
  try {
    const expected = await hmac(`${u}.${h}.${e}`)
    if (s.length !== expected.length || !/^[0-9a-f]+$/i.test(s)) return { valid: false }
    let mismatch = 0
    for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ s.toLowerCase().charCodeAt(index)
    if (mismatch !== 0) return { valid: false }
    if (!Number.isFinite(Number(e)) || Number(e) < Math.floor(Date.now() / 1000)) return { valid: false }
    const headers = JSON.parse(decode(h))
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return { valid: false }
    return { valid: true, targetUrl: decode(u), headers: headers as Record<string, string> }
  } catch {
    return { valid: false }
  }
}

export async function proxyUrl(targetUrl: string, headers: Record<string, string>, routeBasePath: string) {
  return signProxyUrl(targetUrl, headers, routeBasePath)
}


export function withDefaultUserAgent(headers: Record<string, string>) {
  const next = { ...headers }
  if (!Object.keys(next).some((key) => key.toLowerCase() === 'user-agent')) next['User-Agent'] = 'Mozilla/5.0'
  return next
}

export function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
}

export function proxyJson(data: unknown, status: number) {
  return Response.json(data, { status, headers: corsHeaders() })
}

export function signedResourceUrl(targetUrl: string, headers: Record<string, string>) {
  return signProxyUrl(targetUrl, headers, targetUrl.toLowerCase().endsWith('.m3u8') ? '/api/proxy/manifest' : '/api/proxy/segment')
}

/**
 * The single implementation of the playlist rewrite, shared with
 * app/api/proxy/manifest/route.ts so the two copies cannot drift.
 *
 * Rule: playlists, #EXT-X-KEY and #EXT-X-MAP are always proxied. A media URI on
 * a DIRECT_SEGMENT_HOSTS host is left absolute so the browser fetches it from
 * the CDN directly; with the default `none` every media URI is proxied exactly
 * as before.
 */
export async function rewriteManifest(body: string, targetUrl: string, headers: Record<string, string>) {
  const baseUrl = targetUrl.slice(0, targetUrl.lastIndexOf('/') + 1)
  const resolve = (value: string) => /^https?:/i.test(value) ? value : new URL(value, baseUrl).toString()
  const directHosts = directSegmentHosts()
  const lines = body.split(/\r?\n/)
  const rewritten: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || (trimmed.startsWith('#') && !/^#EXT-X-(KEY|MAP)/.test(trimmed))) {
      rewritten.push(line)
      continue
    }
    if (/^#EXT-X-(KEY|MAP)/.test(trimmed)) {
      const match = line.match(/URI="([^"]+)"/)
      if (!match) {
        rewritten.push(line)
        continue
      }
      rewritten.push(line.replace(match[0], `URI="${await signProxyUrl(resolve(match[1]), headers, '/api/proxy/segment')}"`))
      continue
    }
    const absolute = resolve(trimmed)
    if (absolute.toLowerCase().includes('.m3u8')) {
      rewritten.push(await signProxyUrl(absolute, headers, '/api/proxy/manifest'))
      continue
    }
    if (isDirectSegment(absolute, directHosts)) {
      rewritten.push(absolute)
      continue
    }
    rewritten.push(await signProxyUrl(absolute, headers, '/api/proxy/segment'))
  }

  return rewritten.join('\n')
}

/**
 * The ani subtitle token.
 *
 * Carries `{mal, ep, audio, trackId}` and nothing else: no API key, no upstream
 * URL, no ani proxy token. `/api/proxy/ani-subtitle` re-resolves the track from
 * the ani cache and fetches it server-side with the key, so the browser only
 * ever holds this opaque, expiring handle.
 */
export type AniSubtitleToken = {
  mal: number
  ep: number
  audio: 'sub' | 'dub'
  trackId: string
}

export async function signAniSubtitlePath(payload: AniSubtitleToken) {
  const p = encode(JSON.stringify({
    mal: Math.trunc(payload.mal),
    ep: Math.trunc(payload.ep),
    audio: payload.audio,
    trackId: payload.trackId,
  }))
  const e = Math.floor(Date.now() / 1000) + 14_400
  const s = await hmac(`${p}.${e}`)
  return `/api/proxy/ani-subtitle?p=${p}&e=${e}&s=${s}`
}

export async function verifyAniSubtitleToken(p: string, e: string, s: string): Promise<AniSubtitleToken | null> {
  if (!p || !e || !s) return null
  try {
    const expected = await hmac(`${p}.${e}`)
    if (s.length !== expected.length || !/^[0-9a-f]+$/i.test(s)) return null
    let mismatch = 0
    for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ s.toLowerCase().charCodeAt(index)
    if (mismatch !== 0) return null
    if (!Number.isFinite(Number(e)) || Number(e) < Math.floor(Date.now() / 1000)) return null
    const payload = JSON.parse(decode(p)) as Partial<AniSubtitleToken>
    if (!payload || typeof payload !== 'object') return null
    if (!Number.isInteger(payload.mal) || !Number.isInteger(payload.ep)) return null
    if (payload.audio !== 'sub' && payload.audio !== 'dub') return null
    if (typeof payload.trackId !== 'string' || payload.trackId.length === 0) return null
    return { mal: payload.mal as number, ep: payload.ep as number, audio: payload.audio, trackId: payload.trackId }
  } catch {
    return null
  }
}
