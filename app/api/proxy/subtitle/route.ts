import { corsHeaders, proxyJson, verifyProxySignature, withDefaultUserAgent } from '@/lib/proxy-signing'
import { fetchUpstream, readTextUpstream, runWithRetry } from '@/lib/proxy-upstream'

export const runtime = 'edge'
export const maxDuration = 30

/**
 * A subtitle track the provider already serves as WebVTT.
 *
 * Bounds, retry and the failure shape come from lib/proxy-upstream.ts: ~10 s to
 * the headers, ~15 s with no body bytes, one retry for a timeout, a network
 * error or an upstream 5xx, and a fast CORS-carrying 504/502 instead of a
 * request that never ends.
 */

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
  const targetUrl = verified.targetUrl

  const outcome = await runWithRetry(async () => {
    const response = await fetchUpstream(targetUrl, {
      headers: withDefaultUserAgent(verified.headers ?? {}),
      redirect: 'follow',
      cache: 'no-store',
    })
    if (!response.ok) return { failed: true as const }
    return { failed: false as const, text: await readTextUpstream(response) }
  }, targetUrl, 'subtitle')

  if (!outcome.ok) return proxyJson({ error: outcome.code }, outcome.status)
  if (outcome.value.failed) return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502)

  const headers = new Headers(corsHeaders())
  headers.set('Content-Type', 'text/vtt; charset=utf-8')
  headers.set('Cache-Control', 'public, max-age=3600')
  return new Response(outcome.value.text, { status: 200, headers })
}
