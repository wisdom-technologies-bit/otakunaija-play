/**
 * A resolved stream is expensive: a cold `/api/watch/<playId>` pays the ani-api
 * lookup (seconds) plus the Anivexa catalog walk, and every one of those legs is
 * a live scrape of an upstream site. The payload it produces is short-lived
 * anyway (the proxy signatures inside it expire), so caching it is safe as long
 * as the cache outlives nothing else.
 *
 * Two rules keep this honest:
 *  - the cache is only consulted for a request that excluded nothing. The player
 *    sends `?exclude=provider:server` after a playback failure, and that request
 *    must re-resolve rather than be handed the stream that just failed;
 *  - a cache miss, a missing table, a permission error or a malformed row all
 *    degrade to "no cache" and the caller resolves exactly as it did before.
 *
 * The table is `stream_cache(play_id, audio, payload, expires_at)`, keyed on the
 * pair. `sql/stream-cache.sql` creates it; without that migration this module is
 * a no-op and nothing breaks.
 */

export type StreamAudio = 'sub' | 'dub'

export type StreamCacheLookup = {
  playId: string
  audio: StreamAudio
}

export type StreamCachePayload = Record<string, unknown>

/** Long enough to cover a rewatch, short enough to stay inside proxy signatures. */
export const DEFAULT_STREAM_CACHE_TTL_SECONDS = 600
/** A signed proxy URL is minted for hours; the cache must never outlive it. */
export const MAX_STREAM_CACHE_TTL_SECONDS = 900

type MaybeResult<T> = { data?: T | null; error?: unknown }
type QueryResult = { data?: unknown; error?: unknown }
type TableClient = {
  select: (columns?: string) => {
    eq: (column: string, value: unknown) => {
      eq: (column: string, value: unknown) => { maybeSingle: () => Promise<MaybeResult<unknown>> }
    }
  }
  upsert: (values: unknown, options?: { onConflict?: string }) => Promise<QueryResult> | QueryResult
}
export type StreamCacheClient = {
  from: (table: string) => TableClient
}

export const STREAM_CACHE_TABLE = 'stream_cache'

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt((value ?? '').trim(), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** `ANI_STREAM_CACHE_TTL_SECONDS`, clamped to a window the signature can honour. */
export function streamCacheTtlSeconds(env: Record<string, string | undefined> = process.env): number {
  return int(env.ANI_STREAM_CACHE_TTL_SECONDS, DEFAULT_STREAM_CACHE_TTL_SECONDS, 30, MAX_STREAM_CACHE_TTL_SECONDS)
}

function isPayload(value: unknown): value is StreamCachePayload {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function expiryMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * The cached payload, or null. Never throws: any failure is a miss.
 */
export async function readCachedStream(
  client: StreamCacheClient | null,
  lookup: StreamCacheLookup,
  now: number = Date.now(),
): Promise<StreamCachePayload | null> {
  if (!client || !lookup.playId?.trim()) return null
  try {
    const { data, error } = await client
      .from(STREAM_CACHE_TABLE)
      .select('payload, expires_at')
      .eq('play_id', lookup.playId)
      .eq('audio', lookup.audio)
      .maybeSingle()
    if (error || !data || typeof data !== 'object') return null
    const row = data as { payload?: unknown; expires_at?: unknown }
    if (!isPayload(row.payload)) return null
    const expires = expiryMs(row.expires_at)
    // A row with no readable expiry is treated as stale rather than served forever.
    if (expires === null || expires <= now) return null
    return row.payload
  } catch {
    return null
  }
}

/**
 * Store a resolved payload. Returns true only when the row was written, so a
 * caller can tell a working cache from a missing table without caring why.
 */
export async function writeCachedStream(
  client: StreamCacheClient | null,
  lookup: StreamCacheLookup,
  payload: StreamCachePayload,
  ttlSeconds: number = streamCacheTtlSeconds(),
  now: number = Date.now(),
): Promise<boolean> {
  if (!client || !lookup.playId?.trim() || !isPayload(payload)) return false
  try {
    const result = await client.from(STREAM_CACHE_TABLE).upsert(
      {
        play_id: lookup.playId,
        audio: lookup.audio,
        payload,
        expires_at: new Date(now + ttlSeconds * 1000).toISOString(),
      },
      { onConflict: 'play_id,audio' },
    )
    return !(result && typeof result === 'object' && 'error' in result && result.error)
  } catch {
    return false
  }
}
