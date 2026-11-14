/**
 * DIRECT_SEGMENT_HOSTS — which segment hosts may be handed to the browser
 * directly instead of being proxied through Vercel.
 *
 * Kept in its own module (no Node built-ins, no `lib/ani/*` imports) because the
 * manifest proxy runs on the edge runtime and must not pull in anything heavier.
 * Both manifest rewriters import from here, so the two copies of the rewrite
 * logic cannot drift.
 *
 * Default is `none`: every segment keeps going through /api/proxy/segment, which
 * is exactly what the deployment does today. Only when the owner sets
 * `DIRECT_SEGMENT_HOSTS=hls1.drama1.cfd` are matching media URIs left absolute,
 * so the browser fetches them from the CDN and no longer spends Vercel
 * bandwidth on them.
 *
 * Note for the edge routes that read it: on the edge runtime Next.js inlines
 * `process.env` at build time, so changing the variable takes effect after a
 * redeploy. That matches the documented switch procedure.
 */

const DISABLED_VALUES = new Set(['', 'none', 'off', '0', 'false', 'no'])

/** Parsed allow-list of hosts that may be served directly. Empty = disabled. */
export function directSegmentHosts(raw: string | undefined = process.env.DIRECT_SEGMENT_HOSTS): string[] {
  const value = (raw ?? '').trim().toLowerCase()
  if (DISABLED_VALUES.has(value)) return []
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .map((entry) => entry.replace(/^\.+/, ''))
    .map((entry) => entry.replace(/\/.*$/, ''))
    .filter((entry) => entry.length > 0 && !DISABLED_VALUES.has(entry))
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * True when `uri` is an absolute URL whose host is on the allow-list.
 *
 * An entry matches its exact host and any subdomain of it, so
 * `DIRECT_SEGMENT_HOSTS=drama1.cfd` also covers `hls1.drama1.cfd`.
 * Relative URIs never match: they are resolved against the playlist first, so
 * the caller passes an absolute URL.
 */
export function isDirectSegment(uri: string, hosts: string[]): boolean {
  if (hosts.length === 0) return false
  const host = hostOf(uri)
  if (!host) return false
  return hosts.some((entry) => host === entry || host.endsWith(`.${entry}`))
}
