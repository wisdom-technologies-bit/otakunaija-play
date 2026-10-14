import { createAdminClient } from '@/lib/supabase/admin'
import { signProxyUrl } from '@/lib/proxy-signing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 240

const ANIVEXA_BASE_URL = 'https://anivexa.otakunaija.name.ng'
const REQUEST_TIMEOUT_MS = 6_000
const FIRST_RESULT_GRACE_MS = 2_500
const EPISODE_LOOKUP_TIMEOUT_MS = 8_000
const STREAM_PROBE_TIMEOUT_MS = 4_000

const SUBTITLE_LABEL_TO_SRCLANG: Record<string, string> = {
  english: 'en',
  'chinese (simplified)': 'zh-Hans',
  'chinese (traditional)': 'zh-Hant',
  korean: 'ko',
  arabic: 'ar',
  german: 'de',
  spanish: 'es',
  french: 'fr',
  indonesian: 'id',
  italian: 'it',
  malay: 'ms',
  polish: 'pl',
  portuguese: 'pt',
  russian: 'ru',
  thai: 'th',
  vietnamese: 'vi',
}

const KNOWN_PROVIDERS = new Set([
  'mkissa', 'reanime', 'anikoto', 'animegg', 'animenosub', 'anizone',
  'aniwaves', 'senshi', 'kaa', 'animedunya', 'animeonsen', 'anipm', 'anibd',
])
// Fallback providers: a working stream URL is enough, no subtitle required.
const STREAM_ONLY_PROVIDERS = new Set(['aniwaves', 'senshi'])
// Order they are tried in right after anipm.
const PRIORITY_FALLBACK_PROVIDERS = ['aniwaves', 'senshi']

type ProviderEntry = {
  provider?: string
  episodeId?: string
  fallback?: boolean
}

type StreamEntry = {
  url?: string
  type?: string
  server?: string | null
  headers?: Record<string, unknown>
  referer?: string
  subtitles?: Array<{ url?: string; [key: string]: unknown }>
  isActive?: boolean
  priority?: number
}

type TimeRange = { start: number; end: number }

type WatchResponse = {
  error?: unknown
  streams?: StreamEntry[]
  intro?: TimeRange | null
  outro?: TimeRange | null
}

// Live verification (2026-10-13): senshi returned intro/outro ranges, anipm and
// aniwaves returned both fields as null, anikoto omitted both fields, and mkissa
// timed out. Across the successful responses, qualification preserved each
// winning stream's complete subtitles array; no truncation or filtering occurs.

type NormalizedStream = {
  streamUrl: string
  type: string
  server: string | null
  headers: Record<string, unknown>
  subtitles: Array<{ url?: string; [key: string]: unknown }>
}

type EpisodeRow = {
  play_id: string
  anilist_id: number
  episode_number: number
  sub_providers: ProviderEntry[] | null
  dub_providers: ProviderEntry[] | null
  resolved_provider: string | null
  resolved_audio: 'sub' | 'dub' | null
  resolved_at: string | null
  needs_resync: boolean
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: corsHeaders })
}

async function fetchEpisodeCatalog(anilistId: number): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), EPISODE_LOOKUP_TIMEOUT_MS)
  try {
    const response = await fetch(`${ANIVEXA_BASE_URL}/episodes/${anilistId}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    return body && typeof body === 'object' ? body as Record<string, unknown> : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function providersFromCatalog(catalog: Record<string, unknown> | null, episodeNumber: number) {
  const sub: ProviderEntry[] = []
  const dub: ProviderEntry[] = []
  for (const [provider, value] of Object.entries(catalog ?? {})) {
    if (!KNOWN_PROVIDERS.has(provider) || !value || typeof value !== 'object') continue
    const episodes = (value as { episodes?: { sub?: unknown[]; dub?: unknown[] } }).episodes
    for (const audio of ['sub', 'dub'] as const) {
      const match = episodes?.[audio]?.find((entry) => {
        if (!entry || typeof entry !== 'object') return false
        const item = entry as { id?: unknown; number?: unknown }
        return typeof item.id === 'string' && item.number === episodeNumber
      }) as { id: string } | undefined
      if (match) (audio === 'sub' ? sub : dub).push({ provider, episodeId: match.id })
    }
  }
  const rank = (entry: ProviderEntry) => {
    const index = PRIORITY_FALLBACK_PROVIDERS.indexOf(entry.provider ?? '')
    return index === -1 ? PRIORITY_FALLBACK_PROVIDERS.length : index
  }
  sub.sort((a, b) => rank(a) - rank(b))
  dub.sort((a, b) => rank(a) - rank(b))
  return { sub, dub }
}

async function fetchWatch(episodeId: string): Promise<WatchResponse | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${ANIVEXA_BASE_URL}/${episodeId}`, { signal: controller.signal })
    if (!response.ok) return null
    const body: unknown = await response.json()
    return body && typeof body === 'object' ? body as WatchResponse : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function qualify(body: WatchResponse | null, requireSubtitle: boolean, providerName: string, excluded: Set<string>, streamOnly = false): NormalizedStream | null {
  if (!body || 'error' in body || !Array.isArray(body.streams) || body.streams.length === 0) return null
  const candidates = body.streams.filter((entry) =>
    typeof entry?.url === 'string' && entry.url.length > 0 &&
    (!STREAM_ONLY_PROVIDERS.has(providerName) || entry.type !== 'embed') &&
    (!requireSubtitle || streamOnly || (Array.isArray(entry.subtitles) && entry.subtitles.some((subtitle) => typeof subtitle?.url === 'string' && subtitle.url.length > 0))) &&
    !excluded.has(`${providerName}:${entry.server ?? 'default'}`),
  )
  if (candidates.length === 0) return null
  const active = candidates.filter((entry) => entry.isActive === true)
  const pool = active.length > 0 ? active : candidates
  const hasPriority = pool.some((entry) => typeof entry.priority === 'number')
  const winner = hasPriority
    ? pool.reduce((best, entry) => (typeof entry.priority === 'number' && (typeof best.priority !== 'number' || entry.priority > best.priority) ? entry : best), pool[0])
    : pool[0]
  const headers: Record<string, unknown> = entryHeaders(winner.headers)
  if (typeof winner.referer === 'string' && winner.referer.length > 0 && !Object.keys(headers).some((key) => key.toLowerCase() === 'referer')) {
    headers.Referer = winner.referer
  }
  return {
    streamUrl: winner.url as string,
    type: winner.type ?? '',
    server: winner.server ?? null,
    headers,
    subtitles: winner.subtitles ?? [],
  }
}

function entryHeaders(headers: unknown): Record<string, unknown> {
  return headers && typeof headers === 'object' && !Array.isArray(headers) ? { ...(headers as Record<string, unknown>) } : {}
}

function ageMs(value: string) {
  return Date.now() - new Date(value).getTime()
}

async function responseFor(playId: string, audio: 'sub' | 'dub', provider: string, stream: NormalizedStream, intro: TimeRange | null = null, outro: TimeRange | null = null) {
  const headers = stream.headers as Record<string, string>
  const proxied = Object.keys(headers).length > 0
  const subtitles = await Promise.all(stream.subtitles.map(async (subtitle) => {
    const label = typeof subtitle.label === 'string' ? subtitle.label.trim().toLowerCase() : null
    const correctedSrclang = label ? SUBTITLE_LABEL_TO_SRCLANG[label] : undefined
    const correctedSubtitle = correctedSrclang ? { ...subtitle, srclang: correctedSrclang } : subtitle
    if (typeof subtitle.url !== 'string' || subtitle.url.length === 0) return correctedSubtitle
    return {
      ...correctedSubtitle,
      url: await signProxyUrl(subtitle.url, headers, '/api/proxy/subtitle'),
    }
  }))
  return {
    playId,
    audio,
    provider,
    ...stream,
    streamUrl: proxied
      ? await signProxyUrl(
          stream.streamUrl,
          headers,
          stream.type === 'hls' || stream.streamUrl.toLowerCase().includes('.m3u8')
            ? '/api/proxy/manifest'
            : '/api/proxy/segment',
        )
      : stream.streamUrl,
    headers: proxied ? {} : stream.headers,
    subtitles,
    intro,
    outro,
  }
}

async function probeStream(stream: NormalizedStream) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), STREAM_PROBE_TIMEOUT_MS)
  try {
    const headers = withProbeHeaders(stream.headers)
    const response = await fetch(stream.streamUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) return false
    if (stream.type !== 'hls' && !stream.streamUrl.toLowerCase().includes('.m3u8')) return true
    const sample = await response.text()
    return sample.includes('#EXTM3U')
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function withProbeHeaders(headers: Record<string, unknown>) {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') result[key] = value
  }
  if (!Object.keys(result).some((key) => key.toLowerCase() === 'user-agent')) {
    result['User-Agent'] = 'Mozilla/5.0'
  }
  return result
}

async function findWinner(entries: ProviderEntry[], requireSubtitle: boolean, excluded: Set<string>) {
  type Winner = { provider: string; stream: NormalizedStream; intro: TimeRange | null; outro: TimeRange | null }
  if (entries.length === 0) return null

  return new Promise<Winner | null>((resolve) => {
    // undefined = still pending, null = failed or unusable
    const results: Array<Winner | null | undefined> = new Array(entries.length).fill(undefined)
    let done = false
    let graceTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (value: Winner | null) => {
      if (done) return
      done = true
      if (graceTimer) clearTimeout(graceTimer)
      resolve(value)
    }

    const evaluate = (force: boolean) => {
      if (done) return
      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        if (result === undefined) {
          if (force) continue
          // A higher-priority provider is still pending. If a later one is already
          // usable, give the earlier one a short grace period, then take what we have.
          if (!graceTimer && results.some((item) => item)) {
            graceTimer = setTimeout(() => evaluate(true), FIRST_RESULT_GRACE_MS)
          }
          return
        }
        if (result) return finish(result)
      }
      if (results.every((item) => item !== undefined)) finish(null)
    }

    entries.forEach((entry, index) => {
      ;(async (): Promise<Winner | null> => {
        const provider = entry.provider ?? ''
        const body = await fetchWatch(entry.episodeId ?? '')
        const stream = qualify(body, requireSubtitle, provider, excluded, entry.fallback === true)
        if (!stream) return null
        if (!(await probeStream(stream))) return null
        return { provider, stream, intro: body?.intro ?? null, outro: body?.outro ?? null }
      })()
        .catch(() => null)
        .then((result) => {
          results[index] = result
          evaluate(false)
        })
    })
  })
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders })
}

export async function GET(_request: Request, { params }: { params: Promise<{ playId: string }> }) {
  const { playId } = await params
  const supabase = createAdminClient()
  const { data: episode, error } = await supabase
    .from('episodes')
    .select('play_id, anilist_id, episode_number, sub_providers, dub_providers, resolved_provider, resolved_audio, resolved_at, needs_resync')
    .eq('play_id', playId)
    .maybeSingle<EpisodeRow>()

  if (error) return json({ error: 'LOOKUP_FAILED' }, 500)
  if (!episode) return json({ error: 'EPISODE_NOT_FOUND' }, 404)

  const excludeParam = new URL(_request.url).searchParams.get('exclude') ?? ''
  const excluded = new Set(excludeParam.split(',').map((value) => value.trim()).filter(Boolean))
  const hasExclusions = excluded.size > 0

  let subProviders = episode.sub_providers ?? []
  let dubProviders = episode.dub_providers ?? []

  const mergeProviders = (stored: ProviderEntry[], discoveredEntries: ProviderEntry[]) => {
    const seen = new Set(stored.map((entry) => `${entry.provider}:${entry.episodeId}`))
    return [...stored, ...discoveredEntries.filter((entry) => {
      const key = `${entry.provider}:${entry.episodeId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })]
  }

  // Only pay for the catalog lookup when the row has no usable provider data.
  // This keeps normal watch requests fast while allowing newly added Anivexa
  // providers to resolve episodes whose database record is empty.
  // Ani.pm uses a deterministic episode id in Anivexa 2.3. Add it as a
  // last-resort candidate even when the database/catalog does not list it.
  // Anivexa will return an error quickly when that episode is unavailable.
  const anipmFallback: ProviderEntry = {
    provider: 'anipm',
    episodeId: `watch/anipm/${episode.anilist_id}/sub/anipm-${episode.episode_number}`,
  }
  const streamOnlyFallbacks: ProviderEntry[] = PRIORITY_FALLBACK_PROVIDERS.map((provider) => ({
    provider,
    episodeId: `watch/${provider}/${episode.anilist_id}/sub/${provider}-${episode.episode_number}`,
    fallback: true,
  }))
  subProviders = mergeProviders(subProviders, [anipmFallback, ...streamOnlyFallbacks])

  if (subProviders.length === 0 && dubProviders.length === 0) return json({ error: 'NO_PROVIDERS_AVAILABLE' }, 404)

  if (!hasExclusions && episode.resolved_provider && episode.resolved_audio && episode.resolved_at && ageMs(episode.resolved_at) < 6 * 60 * 60 * 1000) {
    const entries = episode.resolved_audio === 'sub' ? subProviders : dubProviders
    const cached = entries.find((entry) => entry.provider === episode.resolved_provider)
    if (cached?.episodeId) {
      const cachedResponse = await fetchWatch(cached.episodeId)
      const stream = qualify(cachedResponse, episode.resolved_audio === 'sub', episode.resolved_provider, excluded, cached.fallback === true)
      if (stream) {
        if (episode.needs_resync) {
          const { error: resyncClearError } = await supabase.from('episodes').update({ needs_resync: false, resync_requested_at: null }).eq('play_id', playId)
          if (resyncClearError) return json({ error: 'RESOLUTION_UPDATE_FAILED' }, 500)
        }
        return json(await responseFor(playId, episode.resolved_audio, episode.resolved_provider, stream, cachedResponse?.intro ?? null, cachedResponse?.outro ?? null))
      }
    }
  }

  let subWinner = subProviders.length > 0 ? await findWinner(subProviders, true, excluded) : null
  let dubWinner = !subWinner && dubProviders.length > 0 ? await findWinner(dubProviders, false, excluded) : null

  // Provider availability can change without the episode row being resynced. If
  // the stored providers fail, refresh the catalog and retry newly discovered
  // providers (including Ani.pm) before declaring the episode unavailable.
  if (!subWinner && !dubWinner) {
    const discovered = providersFromCatalog(await fetchEpisodeCatalog(episode.anilist_id), episode.episode_number)
    const triedSubCount = subProviders.length
    const triedDubCount = dubProviders.length
    subProviders = mergeProviders(subProviders, discovered.sub)
    dubProviders = mergeProviders(dubProviders, discovered.dub)
    const newSub = subProviders.slice(triedSubCount)
    const newDub = dubProviders.slice(triedDubCount)
    subWinner = newSub.length > 0 ? await findWinner(newSub, true, excluded) : null
    dubWinner = !subWinner && newDub.length > 0 ? await findWinner(newDub, false, excluded) : null
  }

  const winner = subWinner
    ? { audio: 'sub' as const, provider: subWinner.provider, stream: subWinner.stream, intro: subWinner.intro, outro: subWinner.outro }
    : dubWinner
      ? { audio: 'dub' as const, provider: dubWinner.provider, stream: dubWinner.stream, intro: dubWinner.intro, outro: dubWinner.outro }
      : null
  if (!winner) {
    await supabase.from('episodes').update({ needs_resync: true, resync_requested_at: new Date().toISOString() }).eq('play_id', playId)
    return json({ error: 'NO_WORKING_STREAM' }, 404)
  }

  const { error: updateError } = await supabase
    .from('episodes')
    .update({
      resolved_provider: winner.provider,
      resolved_audio: winner.audio,
      resolved_at: new Date().toISOString(),
      ...(episode.needs_resync ? { needs_resync: false, resync_requested_at: null } : {}),
    })
    .eq('play_id', playId)
  if (updateError) return json({ error: 'RESOLUTION_UPDATE_FAILED' }, 500)

  return json(await responseFor(playId, winner.audio, winner.provider, winner.stream, winner.intro, winner.outro))
}
