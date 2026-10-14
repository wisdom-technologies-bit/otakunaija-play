import { corsHeaders, proxyJson, verifyProxySignature, withDefaultUserAgent } from '@/lib/proxy-signing'

export const runtime = 'edge'

const PASSTHROUGH_HEADERS = ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']

export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders() }) }

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const verified = await verifyProxySignature(params.get('u') ?? '', params.get('h') ?? '', params.get('e') ?? '', params.get('s') ?? '')
  if (!verified.valid || !verified.targetUrl || !verified.headers) return proxyJson({ error: 'INVALID_OR_EXPIRED_SIGNATURE' }, 403)
  try {
    const upstreamHeaders = withDefaultUserAgent(verified.headers)
    const range = request.headers.get('Range')
    if (range) upstreamHeaders.Range = range

    const response = await fetch(verified.targetUrl, {
      headers: upstreamHeaders,
      redirect: 'follow',
      cache: 'no-store',
    })
    // 200 and 206 are both ok; let 416 (bad range) through so the player can recover.
    if (!response.ok && response.status !== 416) return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502)

    const headers = new Headers(corsHeaders())
    for (const name of PASSTHROUGH_HEADERS) {
      const value = response.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', verified.targetUrl.toLowerCase().includes('.ts') ? 'video/mp2t' : 'video/mp4')
    }
    if (!headers.has('Accept-Ranges')) headers.set('Accept-Ranges', 'bytes')
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
    headers.set('Cache-Control', 'public, max-age=3600')
    return new Response(response.body, { status: response.status, headers })
  } catch { return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502) }
}
