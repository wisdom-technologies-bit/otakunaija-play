/**
 * ani-api HTTP client: the only place that talks to the service and the only
 * place that ever reads `ANI_API_KEY`.
 *
 * Node-runtime only. `lib/ani/*` must never be imported from an edge route or
 * from client code (there is a test that enforces it), because the key lives in
 * this process's environment and nowhere else.
 *
 * What lives here, and why:
 *  - a 10 minute response cache (URLs are observed valid for about 28 minutes,
 *    so it is never allowed past 15)
 *  - single-flight per (mal, episode, audio): ten viewers of a cold episode cost
 *    one upstream resolve, not ten
 *  - a negative cache, so an unmapped MAL id is not re-asked on every request
 *  - a circuit breaker and a small token bucket: when the provider is down or
 *    the budget is spent, viewers fall straight through to Anivexa instead of
 *    queueing behind a slow upstream
 *  - a bounded outcome log for `GET /api/admin/ani-status`
 *
 * All of it is per serverless instance. Vercel runs several, so the counters in
 * ani-status describe one instance, not the fleet.
 */

import { readAniConfig, type AniConfig, type AniEnv } from './config'
import {
  AniRequestError,
  LONG_NEGATIVE_CODES,
  SHORT_NEGATIVE_CODES,
  errorForResponse,
  isAniError,
  type AniErrorCode,
} from './errors'
import type { AniAudio, AniStreamPayload } from './types'

const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX = 500
const NEGATIVE_LONG_MS = 30 * 60 * 1000
const NEGATIVE_SHORT_MS = 60 * 1000
const BREAKER_WINDOW_MS = 60 * 1000
const BREAKER_THRESHOLD = 5
const BREAKER_OPEN_MS = 60 * 1000
const RATE_WINDOW_MS = 60 * 1000
const MAX_PAUSE_MS = 5 * 60 * 1000
const OUTCOME_LOG_MAX = 20

type CacheEntry = { at: number; payload: AniStreamPayload }
type NegativeEntry = { until: number; code: AniErrorCode }
export type AniOutcome = {
  at: string
  anilistId: number | null
  malId: number | null
  episode: number
  audio: AniAudio
  outcome: string
  reason: string | null
  ms: number
}

type State = {
  cache: Map<string, CacheEntry>
  negative: Map<string, NegativeEntry>
  inflight: Map<string, Promise<AniStreamPayload>>
  failures: number[]
  recentRequests: number[]
  breakerOpenUntil: number
  pausedUntil: number
  active: number
  outcomes: AniOutcome[]
  counters: {
    requests: number
    cacheHits: number
    cacheMisses: number
    negativeHits: number
    ok: number
    failures: number
    retries: number
    byCode: Record<string, number>
  }
}

function freshState(): State {
  return {
    cache: new Map(),
    negative: new Map(),
    inflight: new Map(),
    failures: [],
    recentRequests: [],
    breakerOpenUntil: 0,
    pausedUntil: 0,
    active: 0,
    outcomes: [],
    counters: {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      negativeHits: 0,
      ok: 0,
      failures: 0,
      retries: 0,
      byCode: {},
    },
  }
}

let state: State = freshState()

/** Test seam: forget cache, breaker, limiter and counters. */
export function __resetAniState() {
  state = freshState()
}

function cacheKey(malId: number, episode: number, audio: AniAudio) {
  return `${malId}:${episode}:${audio}`
}

function trim() {
  while (state.cache.size > CACHE_MAX) {
    const oldest = state.cache.keys().next()
    if (oldest.done) break
    state.cache.delete(oldest.value)
  }
  while (state.negative.size > CACHE_MAX) {
    const oldest = state.negative.keys().next()
    if (oldest.done) break
    state.negative.delete(oldest.value)
  }
}

function noteCode(code: AniErrorCode) {
  state.counters.byCode[code] = (state.counters.byCode[code] ?? 0) + 1
}

function recordFailure(now: number) {
  state.failures.push(now)
  const cutoff = now - BREAKER_WINDOW_MS
  while (state.failures.length > 0 && state.failures[0] < cutoff) state.failures.shift()
  if (state.failures.length >= BREAKER_THRESHOLD) {
    state.breakerOpenUntil = now + BREAKER_OPEN_MS
    state.failures = []
  }
}

function rememberNegative(key: string, code: AniErrorCode, now: number) {
  const ttl = LONG_NEGATIVE_CODES.has(code) ? NEGATIVE_LONG_MS : SHORT_NEGATIVE_CODES.has(code) ? NEGATIVE_SHORT_MS : 0
  if (ttl === 0) return
  state.negative.set(key, { until: now + ttl, code })
  trim()
}

function takeBudget(config: AniConfig, now: number) {
  if (state.breakerOpenUntil > now) throw new AniRequestError('ANI_BREAKER_OPEN')
  if (state.pausedUntil > now) throw new AniRequestError('ANI_RATE_LIMITED')

  const cutoff = now - RATE_WINDOW_MS
  while (state.recentRequests.length > 0 && state.recentRequests[0] < cutoff) state.recentRequests.shift()
  if (state.recentRequests.length >= config.ratePerMin) throw new AniRequestError('ANI_SATURATED')
  if (state.active >= config.maxConcurrency) throw new AniRequestError('ANI_SATURATED')

  state.recentRequests.push(now)
  state.active += 1
}

function release() {
  state.active = Math.max(0, state.active - 1)
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_PAUSE_MS, seconds * 1000)
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.min(MAX_PAUSE_MS, Math.max(0, date - Date.now()))
  return null
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * One HTTP attempt. Network errors, timeouts and 502/503/504 surface as
 * retryable local errors; 4xx never does (a retry cannot fix a 401 or a
 * MAL_NOT_MAPPED).
 */
async function attempt(config: AniConfig, url: string): Promise<AniStreamPayload> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-API-Key': config.apiKey as string,
        'User-Agent': 'OtakuNaijaPlay',
        accept: 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    })

    if (response.status === 429) {
      const wait = retryAfterMs(response.headers.get('retry-after')) ?? 30_000
      state.pausedUntil = Date.now() + wait
      await response.body?.cancel().catch(() => {})
      throw new AniRequestError('ANI_RATE_LIMITED', 429, wait)
    }

    if (!response.ok) {
      // The body is a flat {code, title}; the status decides retryability.
      throw errorForResponse(response.status, await readBody(response))
    }

    const body = await readBody(response)
    if (!body || typeof body !== 'object') throw new AniRequestError('ANI_BAD_JSON', response.status)
    return body as AniStreamPayload
  } catch (error) {
    if (isAniError(error)) throw error
    const name = error instanceof Error ? error.name : ''
    if (name === 'AbortError') throw new AniRequestError('ANI_TIMEOUT')
    throw new AniRequestError('ANI_NETWORK')
  } finally {
    clearTimeout(timer)
  }
}

function isRetryable(error: unknown) {
  if (!isAniError(error)) return false
  if (error.code === 'ANI_NETWORK' || error.code === 'ANI_TIMEOUT') return true
  return error.status === 502 || error.status === 503 || error.status === 504
}

/**
 * Resolve one MAL episode to a verified ani-api stream payload.
 *
 * Throws `AniRequestError` with a typed code. Never includes the key, the
 * request URL or the upstream URL in the error.
 */
export async function getAniStream(
  malId: number,
  episode: number,
  audio: AniAudio,
  options: { refresh?: boolean; env?: AniEnv } = {},
): Promise<AniStreamPayload> {
  const config = readAniConfig(options.env)
  if (!config.baseUrl || !config.apiKey) throw new AniRequestError('ANI_NOT_CONFIGURED')

  const key = cacheKey(malId, episode, audio)
  const now = Date.now()

  if (!options.refresh) {
    const cached = state.cache.get(key)
    if (cached && now - cached.at < CACHE_TTL_MS) {
      state.counters.cacheHits += 1
      // Refresh LRU position.
      state.cache.delete(key)
      state.cache.set(key, cached)
      return cached.payload
    }
    if (cached) state.cache.delete(key)

    const negative = state.negative.get(key)
    if (negative) {
      if (negative.until > now) {
        state.counters.negativeHits += 1
        throw new AniRequestError(negative.code)
      }
      state.negative.delete(key)
    }

    const pending = state.inflight.get(key)
    if (pending) {
      state.counters.cacheHits += 1
      return pending
    }
  }

  takeBudget(config, now)
  state.counters.requests += 1
  state.counters.cacheMisses += 1

  const url =
    `${config.baseUrl}/v1/streams/mal/${Math.trunc(malId)}/episode/${Math.trunc(episode)}` +
    `?audio=${audio}&quality=best${options.refresh ? '&refresh=true' : ''}`

  const run = (async (): Promise<AniStreamPayload> => {
    try {
      let payload: AniStreamPayload
      try {
        payload = await attempt(config, url)
      } catch (error) {
        if (!isRetryable(error)) throw error
        state.counters.retries += 1
        payload = await attempt(config, url)
      }
      state.cache.set(key, { at: Date.now(), payload })
      state.negative.delete(key)
      state.counters.ok += 1
      trim()
      return payload
    } catch (error) {
      const failure = isAniError(error) ? error : new AniRequestError('ANI_UNKNOWN')
      noteCode(failure.code)
      state.counters.failures += 1
      if (failure.code !== 'ANI_BREAKER_OPEN' && failure.code !== 'ANI_SATURATED' && failure.code !== 'ANI_RATE_LIMITED') {
        recordFailure(Date.now())
        rememberNegative(key, failure.code, Date.now())
      }
      throw failure
    } finally {
      release()
    }
  })()

  state.inflight.set(key, run)
  try {
    return await run
  } finally {
    state.inflight.delete(key)
  }
}

/** Only for tests and ani-status: is a usable response cached for this episode? */
export function peekAniCache(malId: number, episode: number, audio: AniAudio): AniStreamPayload | null {
  const cached = state.cache.get(cacheKey(malId, episode, audio))
  if (!cached) return null
  return Date.now() - cached.at < CACHE_TTL_MS ? cached.payload : null
}

/** Record one attempt for `ani_outcome` console lines and ani-status. */
export function logAniOutcome(entry: {
  anilistId: number | null
  malId: number | null
  episode: number
  audio: AniAudio
  outcome: string
  reason: string | null
  ms: number
}) {
  const record: AniOutcome = {
    at: new Date().toISOString(),
    anilistId: entry.anilistId,
    malId: entry.malId,
    episode: entry.episode,
    audio: entry.audio,
    outcome: entry.outcome,
    reason: entry.reason,
    ms: entry.ms,
  }
  state.outcomes.push(record)
  while (state.outcomes.length > OUTCOME_LOG_MAX) state.outcomes.shift()

  // One structured line per attempt. No key, no URLs, no tokens: only ids and
  // the typed outcome, so Vercel logs stay searchable and safe.
  try {
    console.log(
      'ani_outcome',
      JSON.stringify({
        anilist_id: record.anilistId,
        mal_id: record.malId,
        episode: record.episode,
        audio: record.audio,
        outcome: record.outcome,
        reason: record.reason,
        ms: record.ms,
      }),
    )
  } catch {
    // Logging must never break playback.
  }
  return record
}

export type AniStatus = {
  enabled: boolean
  percent: number
  dubEnabled: boolean
  requireSubtitle: boolean
  configured: boolean
  breaker: { open: boolean, opensInMs: number, recentFailures: number }
  paused: { paused: boolean, resumesInMs: number }
  limiter: { windowRequests: number, ratePerMin: number, active: number, maxConcurrency: number }
  cacheSize: number
  negativeCacheSize: number
  lastOutcomes: AniOutcome[]
  counters: State['counters']
  scope: string
}

/** Snapshot for `GET /api/admin/ani-status`. Contains no secrets. */
export function getAniStatus(env: AniEnv = process.env): AniStatus {
  const config = readAniConfig(env)
  const now = Date.now()
  return {
    enabled: config.enabled,
    percent: config.percent,
    dubEnabled: config.dubEnabled,
    requireSubtitle: config.requireSubtitle,
    configured: Boolean(config.baseUrl && config.apiKey),
    breaker: {
      open: state.breakerOpenUntil > now,
      opensInMs: Math.max(0, state.breakerOpenUntil - now),
      recentFailures: state.failures.length,
    },
    paused: {
      paused: state.pausedUntil > now,
      resumesInMs: Math.max(0, state.pausedUntil - now),
    },
    limiter: {
      windowRequests: state.recentRequests.length,
      ratePerMin: config.ratePerMin,
      active: state.active,
      maxConcurrency: config.maxConcurrency,
    },
    cacheSize: state.cache.size,
    negativeCacheSize: state.negative.size,
    lastOutcomes: [...state.outcomes].reverse(),
    counters: { ...state.counters, byCode: { ...state.counters.byCode } },
    scope: 'per serverless instance',
  }
}
