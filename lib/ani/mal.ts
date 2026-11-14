/**
 * MAL id discovery for the ani provider.
 *
 * Order, cheapest first: the episode row, then the anime row, then one bounded
 * Anivexa `/map/{anilist_id}` lookup whose answer is written back to
 * `anime.mal_id` so the next viewer never pays for it again.
 *
 * Called only after every cheap gate in `aniSkipReason` has passed, so a
 * provider that is off (or out of the rollout percentage) costs no database
 * round-trip at all.
 */

const MAP_TIMEOUT_MS = 3_000

type MaybeSingle = Promise<{ data: { mal_id?: number | null } | null, error?: unknown }>
type Selectable = {
  select: (columns: string) => { eq: (column: string, value: unknown) => { maybeSingle: () => MaybeSingle } }
}
type Updatable = {
  update: (values: Record<string, unknown>) => { eq: (column: string, value: unknown) => Promise<{ error?: unknown }> }
}
/** Only the two chains this module uses, so tests can pass a stub. */
export type MinimalSupabase = { from: (table: string) => Selectable & Updatable }

function positiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Anivexa `/map/{anilist_id}` answers `{ anilistId, malId, kitsuId, ... }` at the
 * top level (verified against https://anivexa.otakunaija.name.ng/docs and a live
 * call, 2026-11-14). Some builds nest the same fields under `mappings`, so both
 * shapes are accepted; anything else is "not found", never a guess.
 */
export async function fetchAnivexaMalId(
  anilistId: number,
  baseUrl: string,
  timeoutMs = MAP_TIMEOUT_MS,
): Promise<number | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}/map/${anilistId}`, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) return null
    const body = (await response.json()) as
      | { malId?: unknown, mappings?: { malId?: unknown } }
      | null
    return positiveInt(body?.malId ?? body?.mappings?.malId)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveMalId(options: {
  anilistId: number
  episodeMalId: number | null
  supabase: MinimalSupabase
  anivexaBaseUrl: string
  /** Set false to skip the bounded Anivexa fallback entirely. */
  allowAnivexaLookup?: boolean
}): Promise<number | null> {
  const fromEpisode = positiveInt(options.episodeMalId)
  if (fromEpisode !== null) return fromEpisode

  try {
    const { data } = await options.supabase.from('anime').select('mal_id').eq('anilist_id', options.anilistId).maybeSingle()
    const fromAnime = positiveInt(data?.mal_id)
    if (fromAnime !== null) return fromAnime
  } catch {
    // A database hiccup must not block playback: ani is simply skipped.
    return null
  }

  if (options.allowAnivexaLookup === false) return null

  const discovered = await fetchAnivexaMalId(options.anilistId, options.anivexaBaseUrl)
  if (discovered === null) return null

  try {
    // Best effort: saving the id is a convenience for the next request.
    await options.supabase.from('anime').update({ mal_id: discovered }).eq('anilist_id', options.anilistId)
  } catch {
    // Ignore.
  }
  return discovered
}
