import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Cron/write-route auth.
 *
 * The repo's existing write route (app/api/episodes/check) accepts
 * `Authorization: Bearer ${EPISODE_CHECK_SECRET}`. The new upcoming/seasonal/
 * export/request routes use the same header with `CRON_SECRET`, falling back to
 * `EPISODE_CHECK_SECRET` so an existing deployment keeps one shared cron secret.
 *
 * Unlike episodes/check (which stays open when no secret is configured), these
 * routes fail closed: an unset secret would otherwise leave endpoints that write
 * rows and push to OtakuNaija open to the internet.
 */

export function getCronSecret(): string | null {
  const secret = process.env.CRON_SECRET?.trim() || process.env.EPISODE_CHECK_SECRET?.trim() || ''
  return secret.length > 0 ? secret : null
}

function digest(value: string) {
  return createHash('sha256').update(value).digest()
}

function safeEqual(a: string, b: string) {
  // Hash first so differently sized inputs still compare in constant time.
  return timingSafeEqual(digest(a), digest(b))
}

export function readBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

/** Returns a Response when the caller must be rejected, otherwise null. */
export function authorizeCron(request: Request): Response | null {
  const secret = getCronSecret()
  if (!secret) {
    return Response.json(
      {
        error: 'CRON_SECRET_NOT_CONFIGURED',
        message: 'Set CRON_SECRET (or EPISODE_CHECK_SECRET) before calling this route.',
      },
      { status: 503 },
    )
  }

  const token = readBearerToken(request)
  if (!token || !safeEqual(token, secret)) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  return null
}

/** True when a cron secret is configured; used in responses/diagnostics only. */
export function isCronAuthEnforced() {
  return getCronSecret() !== null
}
