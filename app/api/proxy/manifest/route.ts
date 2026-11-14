import { corsHeaders, proxyJson, rewriteManifest, verifyProxySignature, withDefaultUserAgent } from '@/lib/proxy-signing'

export const runtime = 'edge'

const timeoutFetch = async (url: string, headers: Record<string, string>) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    return await fetch(url, {
      headers: withDefaultUserAgent(headers),
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
    })
  } finally {
    clearTimeout(timeout)
  }
}

// The rewrite lives in lib/proxy-signing.ts so this route and the helper cannot
// drift. It honours DIRECT_SEGMENT_HOSTS: with the default `none` every media
// URI is still proxied through /api/proxy/segment, exactly as before.

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
