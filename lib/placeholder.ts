import { createAdminClient } from '@/lib/supabase/admin'
import { postOtaku, shortError } from '@/lib/otaku'
import {
  buildOtakuAnimePayload,
  upcomingExportFingerprint,
  type AnimeUpsertRow,
  type OtakuAnimeRow,
} from '@/lib/upcoming'

/**
 * Placeholder (upcoming) anime bookkeeping shared by /api/export/upcoming and
 * /api/discovery/request so a manual import and the cron export behave the same.
 */

export type AdminClient = ReturnType<typeof createAdminClient>

export const ANIME_EXPORT_COLUMNS = [
  'anilist_id',
  'mal_id',
  'title',
  'description',
  'cover_url',
  'genres',
  'status',
  'release_year',
  'studio',
  'poster_url',
  'banner_url',
  'format',
  'otaku_anime_id',
  'otaku_video_id',
  'exported_to_otaku',
  'export_attempts',
  'last_export_error',
  'is_placeholder',
  'discovery_source',
  'status_synced_to_otaku',
  'start_date',
  'start_year',
  'start_month',
  'start_day',
  'season',
  'season_year',
  'popularity',
  'trailer_site',
  'trailer_id',
  'episodes_total',
  'duration_minutes',
  'source',
  'upcoming_checked_at',
  'upcoming_exported_at',
  'upcoming_export_fingerprint',
  'anilist_synced_at',
  'updated_at',
].join(', ')

export type PlaceholderRow = OtakuAnimeRow & {
  otaku_anime_id: number | null
  exported_to_otaku: boolean | null
  export_attempts: number | null
  last_export_error: string | null
  is_placeholder: boolean | null
  status_synced_to_otaku: string | null
  upcoming_checked_at?: string | null
  upcoming_exported_at?: string | null
  upcoming_export_fingerprint?: string | null
  anilist_synced_at?: string | null
  updated_at?: string | null
  format?: string | null
}

/**
 * A placeholder needs (re-)export when it was never exported, when the status
 * OtakuNaija holds is not 'upcoming' any more, or when the AniList metadata it
 * received changed since (start date, cover, trailer, format, episode count).
 */
export function placeholderNeedsExport(row: PlaceholderRow) {
  if (row.otaku_anime_id == null) return 'not_exported' as const
  if (row.status_synced_to_otaku !== 'upcoming') return 'status_drift' as const
  if (!row.upcoming_exported_at) return 'not_exported' as const
  const current = upcomingExportFingerprint(row)
  if (row.upcoming_export_fingerprint !== current) return 'metadata_changed' as const
  return null
}

export type PlaceholderExportResult =
  | { ok: true; skipped: true; reason: string }
  | { ok: true; skipped: false; seriesId: number; payload: Record<string, unknown> }
  | { ok: false; error: string; attempts: number; gaveUp: boolean }

/**
 * Push one placeholder to OtakuNaija and record the result.
 * `dry` builds and returns the payload without calling OtakuNaija or writing.
 */
export async function exportPlaceholderAnime(
  supabase: AdminClient,
  row: PlaceholderRow,
  options: { dry?: boolean; reason?: string } = {},
): Promise<PlaceholderExportResult> {
  const payload = buildOtakuAnimePayload(row, {
    statusOverride: 'upcoming',
    isPlaceholder: true,
  }) as unknown as Record<string, unknown>

  if (options.dry) {
    return { ok: true, skipped: false, seriesId: -1, payload }
  }

  try {
    const result = await postOtaku('/api/play/anime', payload)
    const seriesId = typeof result.payload.seriesId === 'number' ? result.payload.seriesId : null

    if (![200, 201].includes(result.response.status) || seriesId === null) {
      const apiError = typeof result.payload.error === 'string' ? ` ${result.payload.error}` : ''
      throw new Error(`Anime export HTTP ${result.response.status}${apiError}`)
    }

    const now = new Date().toISOString()
    const { error } = await supabase
      .from('anime')
      .update({
        otaku_anime_id: seriesId,
        exported_to_otaku: true,
        status_synced_to_otaku: 'upcoming',
        last_export_error: null,
        export_attempts: 0,
        upcoming_exported_at: now,
        upcoming_export_fingerprint: upcomingExportFingerprint(row),
      })
      .eq('anilist_id', row.anilist_id)

    if (error) throw new Error(`Failed to record placeholder export: ${error.message}`)

    return { ok: true, skipped: false, seriesId, payload }
  } catch (error) {
    return recordPlaceholderFailure(supabase, row, shortError(error))
  }
}

/** Shared backoff bookkeeping: same rule as /api/export/run (give up after 5). */
export async function recordPlaceholderFailure(
  supabase: AdminClient,
  row: PlaceholderRow,
  message: string,
): Promise<PlaceholderExportResult> {
  const attempts = (row.export_attempts ?? 0) + 1
  const { error } = await supabase
    .from('anime')
    .update({
      export_attempts: attempts,
      last_export_error: message,
      updated_at: new Date().toISOString(),
    })
    .eq('anilist_id', row.anilist_id)

  // A bookkeeping failure must not mask the export error we are reporting.
  if (error) console.error('[placeholder] failed to record export attempt', row.anilist_id, error.message)

  return { ok: false, error: message, attempts, gaveUp: attempts >= 5 }
}

/**
 * Insert placeholders without ever touching an existing row.
 * `ignoreDuplicates` makes this a no-op for anilist_ids that already exist, so a
 * race with sync/process (which may promote a placeholder mid-run) can never
 * clobber a real anime.
 */
export async function insertAnimeRows(
  supabase: AdminClient,
  rows: AnimeUpsertRow[],
  options: { dry?: boolean } = {},
) {
  if (!rows.length || options.dry) return 0

  const { data, error } = await supabase
    .from('anime')
    .upsert(rows, { onConflict: 'anilist_id', ignoreDuplicates: true })
    .select('anilist_id')

  if (error) throw new Error(`Failed to insert placeholder anime: ${error.message}`)
  return data?.length ?? 0
}
