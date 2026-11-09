import { authorizeCron } from '@/lib/auth'
import {
  createAdminClient,
  fetchAniListMedia,
  fetchAniListWithRetry,
  getErrorMessage,
  insertPendingSyncWithSource,
  parseAniListMedia,
  type AniListMediaResponse,
} from '@/lib/supabase/admin'
import {
  ANIME_EXPORT_COLUMNS,
  exportPlaceholderAnime,
  insertAnimeRows,
  placeholderNeedsExport,
  type PlaceholderRow,
} from '@/lib/placeholder'
import {
  episodesToQueue,
  mergeAnimeMetadata,
  normalizeAniListMedia,
  parseAniListId,
  toAnimeRow,
  toPlaceholderRow,
  type NormalizedMedia,
} from '@/lib/upcoming'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const EPISODES_CAP = 3

type RequestBody = {
  anilistId?: number | string | null
  anilist_id?: number | string | null
  url?: string | null
}

function requestedBy(request: Request) {
  const header = request.headers.get('x-requested-by') ?? request.headers.get('x-admin-user')
  const value = (header ?? 'otakunaija-admin').trim()
  return value.slice(0, 120) || 'otakunaija-admin'
}

async function recordRequest(
  supabase: ReturnType<typeof createAdminClient>,
  anilistId: number,
  status: string,
  requested: string,
  error: string | null = null,
) {
  const { error: writeError } = await supabase.from('discovery_requests').upsert(
    {
      anilist_id: anilistId,
      requested_by: requested,
      status,
      error,
      processed_at: new Date().toISOString(),
    },
    { onConflict: 'anilist_id' },
  )

  // Bookkeeping must not hide the actual import result.
  if (writeError) console.error('[discovery/request] failed to record request', writeError.message)
}

/** Store/refresh a placeholder row for one media item (no episodes, AniList data only). */
async function upsertPlaceholder(
  supabase: ReturnType<typeof createAdminClient>,
  item: NormalizedMedia,
  dry: boolean,
) {
  const row = toPlaceholderRow(item, { discoverySource: 'manual' })

  const { data: existing, error: readError } = await supabase
    .from('anime')
    .select(ANIME_EXPORT_COLUMNS)
    .eq('anilist_id', item.anilist_id)
    .maybeSingle()

  if (readError) throw new Error(`Failed to read anime row: ${readError.message}`)

  if (!existing) {
    if (!dry) await insertAnimeRows(supabase, [row])
    return { mode: 'inserted' as const }
  }

  const current = existing as unknown as PlaceholderRow

  // An existing real anime keeps its own metadata; nothing to do here.
  if (current.is_placeholder !== true) return { mode: 'existing' as const }

  const merged = mergeAnimeMetadata(current, item)
  const now = new Date().toISOString()
  if (!dry) {
    const { error } = await supabase
      .from('anime')
      .update({ ...merged, anilist_synced_at: now, upcoming_checked_at: now, updated_at: now })
      .eq('anilist_id', item.anilist_id)
      .eq('is_placeholder', true)
    if (error) throw new Error(`Failed to refresh placeholder: ${error.message}`)
  }
  return { mode: 'refreshed' as const }
}

async function loadExportRow(
  supabase: ReturnType<typeof createAdminClient>,
  anilistId: number,
): Promise<PlaceholderRow | null> {
  const { data, error } = await supabase
    .from('anime')
    .select(ANIME_EXPORT_COLUMNS)
    .eq('anilist_id', anilistId)
    .maybeSingle()
  if (error) throw new Error(`Failed to read anime row: ${error.message}`)
  return (data as unknown as PlaceholderRow) ?? null
}

/**
 * POST /api/discovery/request
 *
 * Manual "Import by AniList ID" for the OtakuNaija admin.
 * Body: { anilistId: number } | { url: "https://anilist.co/anime/12345/..." }
 * - NOT_YET_RELEASED (or nothing aired yet): store a placeholder and export it
 *   immediately, exactly like /api/export/upcoming (mode 'placeholder').
 * - anything else: queue episodes 1..N (cap 3) and upsert the anime row
 *   (mode 'queued'); /api/sync/process resolves the providers.
 * Idempotent: repeat calls only refresh the row / re-queue missing episodes.
 */
export async function POST(request: Request) {
  const unauthorized = authorizeCron(request)
  if (unauthorized) return unauthorized

  const url = new URL(request.url)
  const dry = url.searchParams.get('dry') === '1'
  const skipExport = url.searchParams.get('export') === '0' || dry

  let body: RequestBody
  try {
    body = (await request.json()) as RequestBody
  } catch {
    return Response.json({ error: 'INVALID_JSON' }, { status: 400 })
  }

  const raw = body.anilistId ?? body.anilist_id ?? body.url ?? null
  const anilistId = parseAniListId(raw as string | number | null)
  if (anilistId === null) {
    return Response.json(
      { error: 'INVALID_ANILIST_ID', message: 'Provide { "anilistId": 12345 } or { "url": "https://anilist.co/anime/12345" }' },
      { status: 400 },
    )
  }

  const requested = requestedBy(request)

  let supabase: ReturnType<typeof createAdminClient> | null = null
  let databaseError: string | null = null
  try {
    supabase = createAdminClient()
  } catch (error) {
    databaseError = getErrorMessage(error)
  }

  const result = await fetchAniListWithRetry(
    () => fetchAniListMedia(anilistId),
    (payload) => parseAniListMedia(payload as AniListMediaResponse),
    { deadline: Date.now() + 20_000 },
  )

  if (!result.ok) {
    if (supabase) await recordRequest(supabase, anilistId, 'failed', requested, result.error)
    return Response.json(
      { error: 'ANILIST_LOOKUP_FAILED', anilistId, message: result.error },
      { status: result.status === 404 ? 404 : 502 },
    )
  }

  const media = result.parsed
  const item = normalizeAniListMedia(media)
  if (!item) {
    if (supabase) await recordRequest(supabase, anilistId, 'failed', requested, 'AniList returned no media')
    return Response.json({ error: 'NOT_FOUND', anilistId }, { status: 404 })
  }
  // The AniList half runs before the database is touched, so a machine without
  // credentials still reports what the import would do.
  if (!supabase) {
    const mode = item.status === 'NOT_YET_RELEASED' ? 'placeholder' : 'queued'
    return Response.json(
      {
        error: 'SUPABASE_NOT_CONFIGURED',
        message: databaseError,
        anilistId,
        title: item.title,
        mode,
        status: item.status,
        otakuAnimeId: null,
        database: 'unavailable',
      },
      { status: 503 },
    )
  }

  if (item.is_adult) {
    await recordRequest(supabase, anilistId, 'failed', requested, 'adult media rejected')
    return Response.json({ error: 'ADULT_MEDIA_NOT_SUPPORTED', anilistId }, { status: 422 })
  }

  try {
    const hasAiredEpisode =
      item.status !== 'NOT_YET_RELEASED' &&
      (item.next_airing_episode !== null || (item.episodes_total ?? 0) > 0 || item.status === 'RELEASING' || item.status === 'FINISHED')

    if (!hasAiredEpisode) {
      // Placeholder import: metadata only, pushed to OtakuNaija right away.
      const store = await upsertPlaceholder(supabase, item, dry)
      let otakuAnimeId: number | null = null

      const row = dry ? null : await loadExportRow(supabase, anilistId)
      // Only a placeholder may be pushed as 'upcoming': if a real anime already
      // owns this id, its status must not be downgraded by a manual import.
      if (row && row.is_placeholder === true && placeholderNeedsExport(row) && !skipExport) {
        const exported = await exportPlaceholderAnime(supabase, row)
        if (exported.ok && !exported.skipped) otakuAnimeId = exported.seriesId
        else if (!exported.ok) {
          await recordRequest(supabase, anilistId, 'placeholder', requested, exported.error)
          return Response.json(
            {
              anilistId,
              title: item.title,
              mode: 'placeholder',
              otakuAnimeId: null,
              stored: store.mode,
              error: 'EXPORT_FAILED',
              message: exported.error,
              dry,
            },
            { status: 502 },
          )
        }
      } else if (row) {
        otakuAnimeId = row.otaku_anime_id ?? null
      }

      await recordRequest(supabase, anilistId, 'placeholder', requested)
      return Response.json({
        anilistId,
        title: item.title,
        mode: 'placeholder',
        otakuAnimeId,
        status: item.status,
        stored: store.mode,
        dry,
      })
    }

    // Airing/finished: queue the first episodes and let sync/process resolve them.
    const numbers = episodesToQueue(
      item.episodes_total,
      item.next_airing_episode?.episode ?? null,
      EPISODES_CAP,
    )
    let pendingSyncInserted = 0
    if (!dry) {
      pendingSyncInserted = await insertPendingSyncWithSource(
        numbers.map((episode_number) => ({ anilist_id: anilistId, episode_number })),
        'manual',
      )
    }

    const existing = dry ? null : await loadExportRow(supabase, anilistId)
    if (!existing) {
      if (!dry) await insertAnimeRows(supabase, [toAnimeRow(item, { discoverySource: 'manual', placeholder: false })])
    } else {
      const merged = mergeAnimeMetadata(existing, item)
      if (!dry) {
        const { error } = await supabase
          .from('anime')
          .update({ ...merged, anilist_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('anilist_id', anilistId)
        if (error) throw new Error(`Failed to update anime row: ${error.message}`)
      }
    }

    await recordRequest(supabase, anilistId, 'queued', requested)
    return Response.json({
      anilistId,
      title: item.title,
      mode: 'queued',
      otakuAnimeId: existing?.otaku_anime_id ?? null,
      status: item.status,
      episodesQueued: numbers,
      pendingSyncInserted,
      dry,
    })
  } catch (error) {
    const message = getErrorMessage(error)
    await recordRequest(supabase, anilistId, 'failed', requested, message)
    return Response.json({ error: 'REQUEST_FAILED', anilistId, message }, { status: 500 })
  }
}

/** GET /api/discovery/request?anilist_id=12345 — read the state of one import. */
export async function GET(request: Request) {
  const unauthorized = authorizeCron(request)
  if (unauthorized) return unauthorized

  const url = new URL(request.url)
  const anilistId = parseAniListId(url.searchParams.get('anilist_id') ?? url.searchParams.get('anilistId'))
  if (anilistId === null) {
    return Response.json({ error: 'INVALID_ANILIST_ID' }, { status: 400 })
  }

  try {
    const supabase = createAdminClient()
    const { data: requestRow } = await supabase
      .from('discovery_requests')
      .select('anilist_id, requested_by, status, error, created_at, processed_at')
      .eq('anilist_id', anilistId)
      .maybeSingle()

    const { data: animeRow } = await supabase
      .from('anime')
      .select('anilist_id, title, status, is_placeholder, discovery_source, otaku_anime_id, exported_to_otaku, status_synced_to_otaku, start_date, popularity, last_export_error')
      .eq('anilist_id', anilistId)
      .maybeSingle()

    const { data: pending } = await supabase
      .from('pending_sync')
      .select('episode_number, status')
      .eq('anilist_id', anilistId)

    const { data: episodes } = await supabase
      .from('episodes')
      .select('episode_number, exported_to_otaku')
      .eq('anilist_id', anilistId)

    return Response.json({
      anilistId,
      request: requestRow ?? null,
      anime: animeRow ?? null,
      pendingSync: {
        total: pending?.length ?? 0,
        done: (pending ?? []).filter((row) => row.status === 'done').length,
        pending: (pending ?? []).filter((row) => row.status === 'pending').length,
        episodes: (pending ?? []).map((row) => row.episode_number).sort((a, b) => a - b),
      },
      episodes: {
        total: episodes?.length ?? 0,
        exported: (episodes ?? []).filter((row) => row.exported_to_otaku === true).length,
      },
    })
  } catch (error) {
    const message = getErrorMessage(error)
    const missingDatabase = message.includes('Supabase server credentials')
    return Response.json(
      { error: missingDatabase ? 'SUPABASE_NOT_CONFIGURED' : 'REQUEST_LOOKUP_FAILED', message },
      { status: missingDatabase ? 503 : 500 },
    )
  }
}
