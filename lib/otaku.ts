/**
 * OtakuNaija export helpers shared by /api/export/run,
 * /api/export/upcoming and /api/discovery/request.
 *
 * The retry/backoff rules are the ones /api/export/run already used, lifted
 * here so both export paths behave identically (429/5xx retried twice with the
 * Retry-After header honoured, then the row backs off exponentially by
 * export_attempts and gives up after 5 attempts).
 */

export const REQUEST_TIMEOUT_MS = 10_000
export const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000
export const MAX_EXPORT_ATTEMPTS = 5

export function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function retryDelayMs(attempts: number) {
  const exponential = Math.min(MAX_RETRY_DELAY_MS, 30_000 * 2 ** Math.min(attempts, 8))
  return Math.round(exponential * (0.8 + Math.random() * 0.4))
}

export function isRetryEligible(updatedAt: string | null, attempts: number) {
  if (!updatedAt) return true
  return Date.now() - new Date(updatedAt).getTime() >= retryDelayMs(attempts)
}

export function shortError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

export type OtakuPostResult = {
  response: Response
  payload: Record<string, unknown>
}

/** POST to the OtakuNaija API. Never logs the key. */
export async function postOtaku(
  path: string,
  body: Record<string, unknown>,
  retryCount = 0,
): Promise<OtakuPostResult> {
  const baseUrl = process.env.OTAKUNAIJA_API_URL
  const apiKey = process.env.OTAKUNAIJA_API_KEY
  if (!baseUrl || !apiKey) throw new Error('OtakuNaija API credentials are not configured')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-play-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    })
    let payload: Record<string, unknown> = {}
    try {
      payload = (await response.json()) as Record<string, unknown>
    } catch {
      // treated as an invalid response by the caller
    }
    if ((response.status === 429 || response.status >= 500) && retryCount < 2) {
      const retryAfter = Number(response.headers.get('retry-after'))
      const delay = Number.isFinite(retryAfter)
        ? Math.min(60_000, retryAfter * 1000)
        : 1_000 + Math.random() * 2_000
      await wait(delay)
      return postOtaku(path, body, retryCount + 1)
    }
    return { response, payload }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('OtakuNaija request timed out')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
