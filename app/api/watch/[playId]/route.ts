import { createAdminClient } from '@/lib/supabase/admin'
import { signProxyUrl } from '@/lib/proxy-signing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 240

const ANIVEXA_BASE_URL = 'https://anivexa.otakunaija.name.ng'
const REQUEST_TIMEOUT_MS = 25_000

type ProviderEntry = {
  provider?: string
  episodeId?: string
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

type WatchResponse = {
  error?: unknown
  streams?: StreamEntry[]
}

type NormalizedStream = {
  streamUrl: string
  type: string
  server: string | null
  headers: Record<string, unknown>
  subtitles: Array<{ url?: string; [key: string]: unknown }>
}

type EpisodeRow = {
  play_id: string
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

function qualify(body: WatchResponse | null, requireSubtitle: boolean, providerName: string, excluded: Set<string>): NormalizedStream | null {
  if (!body || 'error' in body || !Array.isArray(body.streams) || body.streams.length === 0) return null
  const candidates = body.streams.filter((entry) =>
    typeof entry?.url === 'string' && entry.url.length > 0 &&
    (!requireSubtitle || (Array.isArray(entry.subtitles) && entry.subtitles.some((subtitle) => typeof subtitle?.url === 'string' && subtitle.url.length > 0))) &&
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

async function responseFor(playId: string, audio: 'sub' | 'dub', provider: string, stream: NormalizedStream) {
  const headers = stream.headers as Record<string, string>
  const proxied = Object.keys(headers).length > 0
  const subtitles = await Promise.all(stream.subtitles.map(async (subtitle) => {
    if (typeof subtitle.url !== 'string' || subtitle.url.length === 0) return subtitle
    return {
      ...subtitle,
      url: await signProxyUrl(subtitle.url, headers, '/api/proxy/subtitle'),
    }
  }))
  return {
    playId,
    audio,
    provider,
    ...stream,
    streamUrl: proxied ? await signProxyUrl(stream.streamUrl, headers, '/api/proxy/manifest') : stream.streamUrl,
    headers: proxied ? {} : stream.headers,
    subtitles,
  }
}

async function findWinner(entries: ProviderEntry[], requireSubtitle: boolean, excluded: Set<string>) {
  const responses = await Promise.allSettled(entries.map((entry) => fetchWatch(entry.episodeId ?? '')))
  for (let index = 0; index < entries.length; index += 1) {
    const settled = responses[index]
    if (settled.status === 'fulfilled') {
      const stream = qualify(settled.value, requireSubtitle, entries[index].provider ?? '', excluded)
      if (stream) return { provider: entries[index].provider ?? '', stream }
    }
  }
  return null
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders })
}

export async function GET(_request: Request, { params }: { params: Promise<{ playId: string }> }) {
  const { playId } = await params
  const supabase = createAdminClient()
  const { data: episode, error } = await supabase
    .from('episodes')
    .select('play_id, sub_providers, dub_providers, resolved_provider, resolved_audio, resolved_at, needs_resync')
    .eq('play_id', playId)
    .maybeSingle<EpisodeRow>()

  if (error) return json({ error: 'LOOKUP_FAILED' }, 500)
  if (!episode) return json({ error: 'EPISODE_NOT_FOUND' }, 404)

  const excludeParam = new URL(_request.url).searchParams.get('exclude') ?? ''
  const excluded = new Set(excludeParam.split(',').map((value) => value.trim()).filter(Boolean))
  const hasExclusions = excluded.size > 0

  const subProviders = episode.sub_providers ?? []
  const dubProviders = episode.dub_providers ?? []
  if (subProviders.length === 0 && dubProviders.length === 0) return json({ error: 'NO_PROVIDERS_AVAILABLE' }, 404)

  if (!hasExclusions && episode.resolved_provider && episode.resolved_audio && episode.resolved_at && ageMs(episode.resolved_at) < 6 * 60 * 60 * 1000) {
    const entries = episode.resolved_audio === 'sub' ? subProviders : dubProviders
    const cached = entries.find((entry) => entry.provider === episode.resolved_provider)
    if (cached?.episodeId) {
      const stream = qualify(await fetchWatch(cached.episodeId), episode.resolved_audio === 'sub', episode.resolved_provider, excluded)
      if (stream) {
        if (episode.needs_resync) {
          const { error: resyncClearError } = await supabase.from('episodes').update({ needs_resync: false, resync_requested_at: null }).eq('play_id', playId)
          if (resyncClearError) return json({ error: 'RESOLUTION_UPDATE_FAILED' }, 500)
        }
        return json(await responseFor(playId, episode.resolved_audio, episode.resolved_provider, stream))
      }
    }
  }

  const subWinner = subProviders.length > 0 ? await findWinner(subProviders, true, excluded) : null
  const dubWinner = !subWinner && dubProviders.length > 0 ? await findWinner(dubProviders, false, excluded) : null
  const winner = subWinner
    ? { audio: 'sub' as const, provider: subWinner.provider, stream: subWinner.stream }
    : dubWinner
      ? { audio: 'dub' as const, provider: dubWinner.provider, stream: dubWinner.stream }
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

  return json(await responseFor(playId, winner.audio, winner.provider, winner.stream))
}
