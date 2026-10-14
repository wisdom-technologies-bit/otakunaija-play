import { corsHeaders, proxyJson, verifyProxySignature, withDefaultUserAgent } from '@/lib/proxy-signing'

export const runtime = 'edge'
export const maxDuration = 30

const REQUEST_TIMEOUT_MS = 10_000

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const verified = await verifyProxySignature(
    params.get('u') ?? '',
    params.get('h') ?? '',
    params.get('e') ?? '',
    params.get('s') ?? '',
  )

  if (!verified.valid || !verified.targetUrl || !verified.headers) {
    return proxyJson({ error: 'INVALID_OR_EXPIRED_SIGNATURE' }, 403)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(verified.targetUrl, {
      headers: withDefaultUserAgent(verified.headers),
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
    })
    if (!response.ok) return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502)

    const headers = new Headers(corsHeaders())
    headers.set('Content-Type', 'text/vtt; charset=utf-8')
    headers.set('Cache-Control', 'public, max-age=3600')
    return new Response(await response.text(), { status: 200, headers })
  } catch {
    return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502)
  } finally {
    clearTimeout(timeout)
  }
}

