/**
 * Shared upstream plumbing for the four player-facing proxies
 * (`/api/proxy/segment`, `/manifest`, `/subtitle`, `/ani-subtitle`).
 *
 * Why this exists: a CDN that accepts the connection and then sends nothing is
 * indistinguishable, from the route's point of view, from a CDN that is about to
 * answer. On 2026-11-21 a plain full GET of one 931 KB segment through
 * `/api/proxy/segment` sat for 20 s with 0 bytes received and no error, because
 * neither `fetch` nor the body read had a deadline. The player showed nothing at
 * all, which is worse than a fast failure it can retry.
 *
 * So every upstream call here has three bounds:
 *
 *  - `headersMs` to the response headers (AbortController, one per attempt);
 *  - `stallMs` with no bytes while reading a body, so a trickle or a dead body
 *    cannot hold the request open;
 *  - `retries` extra attempts, and only for a failure that a repeat could fix:
 *    a timeout, a network error, or an upstream 5xx. A 4xx is an answer, not a
 *    fault, and is never retried.
 *
 * A final failure is reported as a short, CORS-carrying JSON body with a status
 * the player can act on (504 for a timeout, 502 otherwise) instead of a hang.
 *
 * Logging: a target URL carries the signature, so nothing here ever logs it.
 * `describeTarget()` reduces it to `host + path`, which is what a log line may
 * contain.
 */

export type UpstreamFailure = 'timeout' | 'network' | 'server'

export class UpstreamError extends Error {
  readonly failure: UpstreamFailure
  readonly status: number | null

  constructor(failure: UpstreamFailure, message: string, status: number | null = null) {
    super(message)
    this.name = 'UpstreamError'
    this.failure = failure
    this.status = status
  }
}

/**
 * The bounds, in one place. Mutable on purpose: a test has to be able to prove a
 * timeout without waiting 10 seconds for it, and production never writes here.
 */
export const UPSTREAM_TIMEOUTS = {
  /** Time to the response headers, per attempt. */
  headersMs: 10_000,
  /** No byte for this long while reading a body means the upstream is gone. */
  stallMs: 15_000,
  /** Extra attempts after the first, for an idempotent GET only. */
  retries: 1,
}

/** `host + path`, never the query: the query is the signature. */
export function describeTarget(targetUrl: string) {
  try {
    const url = new URL(targetUrl)
    return `${url.host}${url.pathname}`
  } catch {
    return 'unknown-target'
  }
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/**
 * One `fetch` with a deadline for the response headers.
 *
 * The timer is cleared as soon as the headers arrive: the signal must not keep
 * running into the body, or a slow but healthy segment would be cut off by the
 * header deadline. The body gets its own `stallMs` watchdog.
 */
async function fetchOnce(targetUrl: string, init: RequestInit, headersMs: number): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, headersMs)
  try {
    return await fetch(targetUrl, { ...init, signal: controller.signal })
  } catch (error) {
    if (timedOut) throw new UpstreamError('timeout', `no response headers within ${headersMs} ms`)
    if (isAbortError(error)) throw new UpstreamError('timeout', `upstream aborted within ${headersMs} ms`)
    throw new UpstreamError('network', 'upstream fetch failed')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One attempt: fetch, and treat an upstream 5xx as retryable. A 4xx and a 416
 * come back as Responses so the caller can decide (416 is a range answer the
 * player recovers from, 4xx is the CDN saying no).
 */
export async function fetchUpstream(
  targetUrl: string,
  init: RequestInit,
  headersMs: number = UPSTREAM_TIMEOUTS.headersMs,
): Promise<Response> {
  const response = await fetchOnce(targetUrl, init, headersMs)
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => {})
    throw new UpstreamError('server', `upstream answered ${response.status}`, response.status)
  }
  return response
}

/**
 * Races one read against the stall deadline. The timer is cleared when the read
 * settles either way, so a healthy stream pays nothing.
 */
export async function readWithStall<T>(
  read: () => Promise<T>,
  stallMs: number = UPSTREAM_TIMEOUTS.stallMs,
  what = 'body',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new UpstreamError('timeout', `no ${what} bytes for ${stallMs} ms`)), stallMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** A reader whose every `read()` is bounded by the stall deadline. */
export type StalledReader = {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>
  cancel: (reason?: unknown) => Promise<void>
}

export function stalledReader(body: ReadableStream<Uint8Array>, stallMs: number = UPSTREAM_TIMEOUTS.stallMs): StalledReader {
  const reader = body.getReader()
  return {
    read: () => readWithStall(() => reader.read(), stallMs),
    cancel: async (reason?: unknown) => { await reader.cancel(reason).catch(() => {}) },
  }
}

/** Reads a whole body, refusing to buffer more than `limit` bytes. */
export async function readWholeWithStall(
  reader: StalledReader,
  limit: number,
  stallMs: number = UPSTREAM_TIMEOUTS.stallMs,
): Promise<{ overflow: false; bytes: Uint8Array } | { overflow: true; parts: Uint8Array[] }> {
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const step = await readWithStall(() => reader.read(), stallMs)
    if (step.done) break
    if (!step.value || step.value.length === 0) continue
    parts.push(step.value)
    total += step.value.length
    if (total > limit) return { overflow: true, parts }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.length }
  return { overflow: false, bytes }
}

/**
 * Streams `body` through, but fails it if the upstream sends no byte for
 * `stallMs`. Nothing is read before the consumer asks: `highWaterMark: 0` means
 * a correctly typed segment still returns with zero reads and no added latency.
 *
 * Once the Response has gone out the status cannot change, so a stall here ends
 * the stream with an error instead of a JSON body: the player sees a truncated
 * fragment, which hls.js retries, rather than a fragment that never ends.
 */
export function stallGuardedStream(body: ReadableStream<Uint8Array>, stallMs: number = UPSTREAM_TIMEOUTS.stallMs) {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const step = await readWithStall(() => reader.read(), stallMs)
        if (step.done) { controller.close(); return }
        if (step.value && step.value.length > 0) controller.enqueue(step.value)
      } catch (error) {
        controller.error(error)
        await reader.cancel().catch(() => {})
      }
    },
    cancel(reason) { return reader.cancel(reason) },
  }, { highWaterMark: 0 })
}

/** True for the failures a second identical GET could plausibly fix. */
export function isRetryable(error: unknown) {
  return error instanceof UpstreamError && (error.failure === 'timeout' || error.failure === 'network' || error.failure === 'server')
}

/** 504 for a deadline that passed, 502 for everything else. */
export function failureStatus(error: unknown) {
  return error instanceof UpstreamError && error.failure === 'timeout' ? 504 : 502
}

/** The JSON code the player shows for a final upstream failure. */
export function failureCode(error: unknown) {
  return error instanceof UpstreamError && error.failure === 'timeout' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_FETCH_FAILED'
}

/**
 * Reads a whole (small) upstream body with the stall deadline: a manifest, a
 * subtitle track. Decoded as text in order, with no assumption about chunk
 * boundaries splitting a multi-byte character.
 */
export async function readTextUpstream(response: Response, stallMs: number = UPSTREAM_TIMEOUTS.stallMs): Promise<string> {
  if (!response.body) return ''
  const reader = stalledReader(response.body, stallMs)
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const step = await reader.read()
    if (step.done) break
    if (step.value && step.value.length > 0) text += decoder.decode(step.value, { stream: true })
  }
  return text + decoder.decode()
}

export type UpstreamOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string }

/**
 * The one retry loop every proxy route shares.
 *
 * `attempt` must be safe to repeat: a GET with no side effect. A timeout, a
 * network error and an upstream 5xx are retried once; anything else (a 4xx, a
 * 416, a bug) is not, and comes back as a `Response` from `attempt` instead of
 * being thrown. On a final failure the returned status is 504 for a deadline
 * that passed and 502 otherwise, and the log line carries `host + path` only.
 */
export async function runWithRetry<T>(
  attempt: () => Promise<T>,
  targetUrl: string,
  label: string,
): Promise<UpstreamOutcome<T>> {
  const attempts = 1 + Math.max(0, UPSTREAM_TIMEOUTS.retries)
  let lastError: unknown = null
  for (let index = 1; index <= attempts; index += 1) {
    try {
      return { ok: true, value: await attempt() }
    } catch (error) {
      lastError = error
      if (!isRetryable(error) || index === attempts) break
    }
  }
  const status = failureStatus(lastError)
  if (status === 504) console.warn(`[proxy/${label}] upstream timeout`, describeTarget(targetUrl))
  return { ok: false, status, code: failureCode(lastError) }
}
