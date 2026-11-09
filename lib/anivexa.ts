/**
 * Anivexa helper for the seasonal sweep: does this AniList id have any playable
 * episodes right now? Mirrors the provider walk in app/api/episodes/check so
 * "has providers" means the same thing everywhere.
 */

export const ANIVEXA_BASE_URL = process.env.ANIVEXA_BASE_URL ?? 'https://anivexa.otakunaija.name.ng'

const NON_PROVIDER_KEYS = new Set(['mappings', 'page', 'type'])

export type AnivexaAvailability = {
  /** episode number -> how many providers list it */
  counts: Map<number, number>
  providersWithData: number
  maxEpisode: number | null
}

export async function fetchAnivexaAvailability(
  anilistId: number,
  timeoutMs = 20_000,
): Promise<AnivexaAvailability> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${ANIVEXA_BASE_URL}/episodes/${anilistId}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Anivexa HTTP ${response.status}`)

    const json = (await response.json()) as Record<string, unknown>
    const counts = new Map<number, number>()
    let providersWithData = 0

    for (const [key, raw] of Object.entries(json)) {
      if (NON_PROVIDER_KEYS.has(key) || !raw || typeof raw !== 'object') continue
      const holder = raw as { episodes?: { sub?: unknown; dub?: unknown } }
      const seen = new Set<number>()
      for (const list of [holder.episodes?.sub, holder.episodes?.dub]) {
        if (!Array.isArray(list)) continue
        for (const entry of list) {
          const number = Number((entry as { number?: unknown })?.number)
          if (Number.isInteger(number) && number >= 1) seen.add(number)
        }
      }
      if (seen.size === 0) continue
      providersWithData += 1
      for (const number of seen) counts.set(number, (counts.get(number) ?? 0) + 1)
    }

    const numbers = [...counts.keys()].sort((a, b) => a - b)
    return {
      counts,
      providersWithData,
      maxEpisode: numbers.length ? numbers[numbers.length - 1] : null,
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Anivexa request timed out')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Lowest episode a provider cluster agrees on, used to decide whether the anime
 * is playable at all (2+ providers must agree when more than one answered).
 */
export function lowestPlayableEpisode(availability: AnivexaAvailability, from = 1) {
  const minAgree = availability.providersWithData >= 2 ? 2 : 1
  for (const [number, providerCount] of [...availability.counts].sort((a, b) => a[0] - b[0])) {
    if (number >= from && providerCount >= minAgree) return number
  }
  return null
}
