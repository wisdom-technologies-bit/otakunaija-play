import { corsHeaders, proxyJson, rewriteManifest, verifyProxySignature } from '@/lib/proxy-signing'
import { fetchUpstream, readTextUpstream, runWithRetry } from '@/lib/proxy-upstream'
import { withDefaultUserAgent } from '@/lib/proxy-signing'

export const runtime = 'edge'

/**
 * The playlist proxy. The rewrite lives in lib/proxy-signing.ts so this route and
 * the helper cannot drift; it honours DIRECT_SEGMENT_HOSTS, and with the default
 * `none` every media URI is still proxied through /api/proxy/segment.
 *
 * A playlist that never arrives used to hold the request open: the fetch had a
 * deadline but no retry, and the body read had none at all. It now shares the
 * upstream bounds in lib/proxy-upstream.ts - ~10 s to the headers, ~15 s with no
 * body bytes, one retry for a timeout, a network error or an upstream 5xx - and
 * fails with a fast, CORS-carrying 504/502 instead of hanging.
 */

export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders() }) }

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const verified = await verifyProxySignature(params.get('u') ?? '', params.get('h') ?? '', params.get('e') ?? '', params.get('s') ?? '')
  if (!verified.valid || !verified.targetUrl || !verified.headers) return proxyJson({ error: 'INVALID_OR_EXPIRED_SIGNATURE' }, 403)
  const targetUrl = verified.targetUrl
  const headers = verified.headers

  const outcome = await runWithRetry(async () => {
    const response = await fetchUpstream(targetUrl, {
      headers: withDefaultUserAgent(headers),
      redirect: 'follow',
      cache: 'no-store',
    })
    if (!response.ok) return { failed: true as const }
    return { failed: false as const, text: await readTextUpstream(response) }
  }, targetUrl, 'manifest')

  if (!outcome.ok) return proxyJson({ error: outcome.code }, outcome.status)
  if (outcome.value.failed) return proxyJson({ error: 'UPSTREAM_FETCH_FAILED' }, 502)

  return new Response(await rewriteManifest(outcome.value.text, targetUrl, headers), {
    status: 200,
    headers: { ...corsHeaders(), 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
  })
}
