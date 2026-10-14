import { corsHeaders, proxyJson, verifyProxySignature, withDefaultUserAgent } from '@/lib/proxy-signing'

export const runtime = 'edge'

export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders() }) }

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const verified = await verifyProxySignature(params.get('u') ?? '', params.get('h') ?? '', params.get('e') ?? '', params.get('s') ?? '')
  if (!verified.valid || !verified.targetUrl || !verified.headers) return proxyJson({ error: 'INVALID_OR_EXPIRED_SIGNATURE' }, 403)
  try {
    const response = await fetch(verified.targetUrl, {
      headers: withDefaultUserAgent(verified.headers),
      redirect: 'follow',
      cache: 'no-store',
    })
    if (!response.ok) return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502)
    const headers = new Headers(corsHeaders())
    headers.set('Cache-Control', 'public, max-age=3600')
    headers.set('Content-Type', response.headers.get('Content-Type') ?? 'video/mp2t')
    return new Response(response.body, { status: 200, headers })
  } catch { return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502) }
}
