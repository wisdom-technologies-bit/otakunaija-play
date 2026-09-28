import { corsHeaders, proxyJson, signProxyUrl, verifyProxySignature, withDefaultUserAgent } from '@/lib/proxy-signing'

export const runtime = 'edge'

const timeoutFetch = async (url: string, headers: Record<string, string>) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try { return await fetch(url, { headers: withDefaultUserAgent(headers), signal: controller.signal }) } finally { clearTimeout(timeout) }
}

async function rewriteManifest(body: string, targetUrl: string, headers: Record<string, string>) {
  const baseUrl = targetUrl.slice(0, targetUrl.lastIndexOf('/') + 1)
  const resolve = (value: string) => /^https?:/i.test(value) ? value : new URL(value, baseUrl).toString()
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
      const proxyUrl = await signProxyUrl(resolve(match[1]), headers, '/api/proxy/segment')
      rewritten.push(line.replace(match[0], `URI="${proxyUrl}"`))
      continue
    }

    const absolute = resolve(trimmed)
    const route = absolute.toLowerCase().endsWith('.m3u8') ? '/api/proxy/manifest' : '/api/proxy/segment'
    rewritten.push(await signProxyUrl(absolute, headers, route))
  }

  return rewritten.join('\n')
}

export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders() }) }

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const verified = await verifyProxySignature(params.get('u') ?? '', params.get('h') ?? '', params.get('e') ?? '', params.get('s') ?? '')
  if (!verified.valid || !verified.targetUrl || !verified.headers) return proxyJson({ error: 'INVALID_OR_EXPIRED_SIGNATURE' }, 403)
  try {
    const response = await timeoutFetch(verified.targetUrl, verified.headers)
    if (!response.ok) return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502)
    const text = await response.text()
    return new Response(await rewriteManifest(text, verified.targetUrl, verified.headers), { status: 200, headers: { ...corsHeaders(), 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' } })
  } catch { return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502) }
}
