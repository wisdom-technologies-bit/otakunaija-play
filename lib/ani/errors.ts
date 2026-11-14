/**
 * Typed failures for the ani provider.
 *
 * Two families share one class:
 *  - codes the ani-api itself returns (`MAL_NOT_FOUND`, `MAL_EPISODE_MISMATCH`, …)
 *  - codes produced locally (timeout, breaker open, saturation, host refusal, …)
 *
 * A message carries the code only. The API key, the request URL and the upstream
 * URL never enter an error: they must not be able to reach a log line, a trace
 * entry or a response body.
 */

export type AniErrorCode =
  // ani-api taxonomy
  | 'MAL_NOT_FOUND'
  | 'MAL_NOT_MAPPED'
  | 'MAL_MAPPING_AMBIGUOUS'
  | 'MAL_EPISODE_NOT_FOUND'
  | 'MAL_EPISODE_MISMATCH'
  | 'MAL_TITLE_SOURCE_UNAVAILABLE'
  | 'MAL_TITLE_SOURCE_DISABLED'
  | 'NO_STREAM'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_OBJECT_BLOCKED'
  | 'UPSTREAM_BLOCKED'
  // produced locally
  | 'ANI_NOT_CONFIGURED'
  | 'ANI_DISABLED'
  | 'ANI_TIMEOUT'
  | 'ANI_NETWORK'
  | 'ANI_HTTP_ERROR'
  | 'ANI_UNAUTHORIZED'
  | 'ANI_RATE_LIMITED'
  | 'ANI_BREAKER_OPEN'
  | 'ANI_SATURATED'
  | 'ANI_BAD_JSON'
  | 'ANI_NOT_VERIFIED'
  | 'ANI_EPISODE_MISMATCH'
  | 'ANI_BAD_STREAM_TYPE'
  | 'ANI_NO_VARIANT'
  | 'ANI_NO_SUBTITLE'
  | 'ANI_HOST_NOT_ALLOWED'
  | 'ANI_PROBE_FAILED'
  | 'ANI_UNKNOWN'

export class AniRequestError extends Error {
  readonly code: AniErrorCode
  readonly status: number
  readonly retryAfterMs: number | null

  constructor(code: AniErrorCode, status = 0, retryAfterMs: number | null = null) {
    super(`ani ${code}`)
    this.name = 'AniRequestError'
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Codes whose answer will not change soon, so the failure is remembered for
 * 30 minutes instead of being retried on the next viewer.
 */
export const LONG_NEGATIVE_CODES: ReadonlySet<AniErrorCode> = new Set<AniErrorCode>([
  'MAL_NOT_FOUND',
  'MAL_NOT_MAPPED',
  'MAL_EPISODE_NOT_FOUND',
  'MAL_MAPPING_AMBIGUOUS',
])

/** Codes remembered for 60 seconds only. */
export const SHORT_NEGATIVE_CODES: ReadonlySet<AniErrorCode> = new Set<AniErrorCode>([
  'MAL_EPISODE_MISMATCH',
  'ANI_HTTP_ERROR',
  'ANI_TIMEOUT',
  'ANI_NETWORK',
  'ANI_BAD_JSON',
])

export function isAniError(value: unknown): value is AniRequestError {
  return value instanceof AniRequestError
}

/** Map an HTTP status/body pair from the ani-api onto a typed error. */
export function errorForResponse(status: number, body: unknown): AniRequestError {
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined
  if (typeof code === 'string' && code.length <= 40 && /^[A-Z0-9_]+$/.test(code)) {
    return new AniRequestError(code as AniErrorCode, status)
  }
  if (status === 401 || status === 403) return new AniRequestError('ANI_UNAUTHORIZED', status)
  if (status === 404) return new AniRequestError('MAL_NOT_FOUND', status)
  return new AniRequestError('ANI_HTTP_ERROR', status)
}
