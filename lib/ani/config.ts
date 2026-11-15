/**
 * ani provider configuration.
 *
 * Every value is read from `process.env` at request time (never at module load,
 * never with a NEXT_PUBLIC_ prefix), so a changed Vercel variable plus a
 * redeploy is all it takes to flip the provider or reshuffle the percentage.
 *
 * This module is server-only by construction: it is imported exclusively from
 * `runtime = 'nodejs'` route handlers, never from an edge route or client code.
 */

/** Just the env lookup, so tests can pass their own map. */
export type AniEnv = Record<string, string | undefined>

export type AniConfig = {
  /** Feature flag. Unset/0 keeps the provider completely out of the resolver. */
  enabled: boolean
  /** e.g. https://ani-api.kumoritv.top — no default: unset means the provider is off. */
  baseUrl: string | null
  /** The Play service's own key. Never logged, never returned, never in a URL. */
  apiKey: string | null
  /** 0-100, stable per AniList id. */
  percent: number
  /** Dub through ani stays off until the owner verifies the audio language by ear. */
  dubEnabled: boolean
  /** A sub stream needs at least one playable subtitle track, like Anivexa sub providers. */
  requireSubtitle: boolean
  /**
   * AniKoto only. Some episodes return zero subtitle tracks (hard-sub or no
   * subs, the API cannot say). `1` keeps the strict rule, `0` lets those
   * episodes play. The owner flips it after checking by eye.
   */
  anikotoRequireSubtitle: boolean
  timeoutMs: number
  maxConcurrency: number
  /**
   * Requests per minute this instance will send. Vercel runs several instances,
   * so this is NOT the real ceiling: the API allows 60 req/min per key, and the
   * owner uses a separate key for Play so it never shares KumoriTV's budget.
   */
  ratePerMin: number
  /**
   * Hosts a `master_url` may live on, subdomains included. `ANI_MASTER_HOSTS`
   * replaces the built-in list; segments are NOT host-checked because those
   * hosts rotate (the signed proxy only ever fetches what we signed).
   */
  masterHosts: string[]
}

/**
 * The master hosts the service has actually served: `nexabloom.top` (AniKoto,
 * the new first source), plus the older ZokoAnime hosts. `ANI_MASTER_HOSTS`
 * replaces this list entirely; a host not on it is refused, never probed.
 */
export const DEFAULT_MASTER_HOSTS = ['nexabloom.top', 'dramahot.top', 'drama1.cfd'] as const

function masterHosts(value: string | undefined): string[] {
  const parsed = hostList(value)
  return parsed.length > 0 ? parsed : [...DEFAULT_MASTER_HOSTS]
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

function flag(value: string | undefined, fallback: boolean): boolean {
  const trimmed = (value ?? '').trim().toLowerCase()
  if (trimmed === '') return fallback
  return TRUE_VALUES.has(trimmed)
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt((value ?? '').trim(), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function text(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Comma-separated host list; empty means "use the defaults". */
function hostList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .map((entry) => entry.replace(/^\.+/, ''))
    .map((entry) => entry.replace(/\/.*$/, ''))
    .filter((entry) => entry.length > 0)
}

function baseUrl(value: string | undefined): string | null {
  const raw = text(value)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin + url.pathname.replace(/\/+$/, '')
  } catch {
    return null
  }
}

export function readAniConfig(env: AniEnv = process.env): AniConfig {
  return {
    enabled: flag(env.ANI_PROVIDER_ENABLED, false),
    baseUrl: baseUrl(env.ANI_API_BASE_URL),
    apiKey: text(env.ANI_API_KEY),
    percent: int(env.ANI_PROVIDER_PERCENT, 100, 0, 100),
    dubEnabled: flag(env.ANI_DUB_ENABLED, false),
    requireSubtitle: flag(env.ANI_REQUIRE_SUBTITLE, true),
    anikotoRequireSubtitle: flag(env.ANI_ANIKOTO_REQUIRE_SUBTITLE, true),
    timeoutMs: int(env.ANI_API_TIMEOUT_MS, 12_000, 1_000, 60_000),
    maxConcurrency: int(env.ANI_MAX_CONCURRENCY, 3, 1, 32),
    ratePerMin: int(env.ANI_RATE_PER_MIN, 30, 1, 600),
    masterHosts: masterHosts(env.ANI_MASTER_HOSTS),
  }
}

/** Stable 0-99 bucket for an AniList id. Same id, same bucket, every instance. */
export function aniBucket(anilistId: number): number {
  const value = String(Math.trunc(Number(anilistId) || 0))
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 100
}

/** True when this AniList id falls inside the configured rollout percentage. */
export function withinAniPercent(anilistId: number, percent: number): boolean {
  if (percent >= 100) return true
  if (percent <= 0) return false
  return aniBucket(anilistId) < percent
}
