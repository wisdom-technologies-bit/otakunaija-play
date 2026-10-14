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
  if (!Object.keys(next).some((key) => key.toLowerCase() === 'accept')) next.Accept = '*/*'
  if (!Object.keys(next).some((key) => key.toLowerCase() === 'origin')) {
    const refererKey = Object.keys(next).find((key) => key.toLowerCase() === 'referer')
    const referer = refererKey ? next[refererKey] : undefined
    if (typeof referer === 'string') {
      try {
        next.Origin = new URL(referer).origin
      } catch {
        // Ignore malformed optional referers.
      }
    }
  }
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

export function rewriteManifest(body: string, targetUrl: string, headers: Record<string, string>) {
  const baseUrl = targetUrl.slice(0, targetUrl.lastIndexOf('/') + 1)
  const resolve = (value: string) => /^https?:/i.test(value) ? value : new URL(value, baseUrl).toString()
  return body.split(/\r?\n/).map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') && !/^#EXT-X-(KEY|MAP)/.test(trimmed)) return line
    if (/^#EXT-X-(KEY|MAP)/.test(line)) return line.replace(/URI="([^"]+)"/, (_, uri) => `URI="${signProxyUrl(resolve(uri), headers, '/api/proxy/segment')}"`)
    const absolute = resolve(trimmed)
    return signProxyUrl(absolute, headers, absolute.toLowerCase().endsWith('.m3u8') ? '/api/proxy/manifest' : '/api/proxy/segment')
  }).join('\n')
}
