import crypto from 'node:crypto'

function encode(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function decode(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8')
}

function secret() {
  const value = process.env.PROXY_SIGNING_SECRET
  if (!value) throw new Error('PROXY_SIGNING_SECRET is not configured')
  return value
}

export function signProxyUrl(targetUrl: string, headers: Record<string, string>, routeBasePath: string) {
  const u = encode(targetUrl)
  const h = encode(JSON.stringify(headers))
  const e = Math.floor(Date.now() / 1000) + 14_400
  const s = crypto.createHmac('sha256', secret()).update(`${u}.${h}.${e}`).digest('hex')
  return `${routeBasePath}?u=${u}&h=${h}&e=${e}&s=${s}`
}

export function verifyProxySignature(u: string, h: string, e: string, s: string) {
  try {
    const expected = crypto.createHmac('sha256', secret()).update(`${u}.${h}.${e}`).digest('hex')
    const provided = Buffer.from(s, 'hex')
    const expectedBytes = Buffer.from(expected, 'hex')
    if (provided.length !== expectedBytes.length || !crypto.timingSafeEqual(provided, expectedBytes)) return { valid: false }
    if (!Number.isFinite(Number(e)) || Number(e) < Math.floor(Date.now() / 1000)) return { valid: false }
    const headers = JSON.parse(decode(h))
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return { valid: false }
    return { valid: true, targetUrl: decode(u), headers: headers as Record<string, string> }
  } catch {
    return { valid: false }
  }
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
