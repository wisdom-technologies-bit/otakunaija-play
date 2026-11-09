import { authorizeCron } from '@/lib/auth'
import { UPCOMING_EXPORT_TIME_BUDGET_MS, createAdminClient, getErrorMessage } from '@/lib/supabase/admin'
import { isRetryEligible } from '@/lib/otaku'
import {
  ANIME_EXPORT_COLUMNS,
  exportPlaceholderAnime,
  placeholderNeedsExport,
  type PlaceholderRow,
} from '@/lib/placeholder'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 25
const MAX_ATTEMPTS = 5

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max)
}

/**
 * GET /api/export/upcoming
 *
 * Exports anime that exist on AniList but have no streamable episode yet, so
 * OtakuNaija can list them as upcoming. Every format (including MOVIE/OVA/
 * SPECIAL) goes to /api/play/anime with `format` so OtakuNaija decides how to
 * present it: these rows have no episodes, so the video flow in /api/export/run
 * would never pick them up.
 *
 * Params: limit (default 10), dry=1.
 */
export async function GET(request: Request) {
  const unauthorized = authorizeCron(request)
  if (unauthorized) return unauthorized

  const startedAt = Date.now()
  const url = new URL(request.url)
  const dry = url.searchParams.get('dry') === '1'
  const limit = clamp(Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT), 1, MAX_LIMIT)

  const errors: string[] = []

  try {
    const supabase = createAdminClient()
    // Never-exported placeholders first, then the ones whose status OtakuNaija
    // does not hold as 'upcoming' yet.
    const { data: queueRows, error: queueError } = await supabase
      .from('anime')
      .select(ANIME_EXPORT_COLUMNS)
      .eq('is_placeholder', true)
      .or('otaku_anime_id.is.null,status_synced_to_otaku.is.null,status_synced_to_otaku.neq.upcoming')
      .order('upcoming_checked_at', { ascending: true, nullsFirst: true })
      .limit(limit * 3)

    if (queueError) throw new Error(`Failed to read placeholder queue: ${queueError.message}`)

    // Then placeholders whose AniList metadata moved since the last push.
    const { data: refreshRows, error: refreshError } = await supabase
      .from('anime')
      .select(ANIME_EXPORT_COLUMNS)
      .eq('is_placeholder', true)
      .eq('status_synced_to_otaku', 'upcoming')
      .not('otaku_anime_id', 'is', null)
      .order('anilist_synced_at', { ascending: false, nullsFirst: false })
      .limit(limit * 5)

    if (refreshError) throw new Error(`Failed to read placeholder refresh queue: ${refreshError.message}`)

    const seen = new Set<number>()
    const selected: Array<{ row: PlaceholderRow; reason: string }> = []

    for (const row of (queueRows ?? []) as unknown as PlaceholderRow[]) {
      const reason = placeholderNeedsExport(row)
      if (!reason) continue
      if (seen.has(row.anilist_id)) continue
      seen.add(row.anilist_id)
      selected.push({ row, reason })
    }

    for (const row of (refreshRows ?? []) as unknown as PlaceholderRow[]) {
      if (selected.length >= limit) break
      if (seen.has(row.anilist_id)) continue
      const reason = placeholderNeedsExport(row)
      if (reason !== 'metadata_changed') continue
      seen.add(row.anilist_id)
      selected.push({ row, reason })
    }

    const batch = selected.slice(0, limit)

    let exported = 0
    let refreshed = 0
    let failed = 0
    let gaveUp = 0
    let skippedBackoff = 0
    const results: Array<Record<string, unknown>> = []

    for (const entry of batch) {
      if (Date.now() - startedAt >= UPCOMING_EXPORT_TIME_BUDGET_MS) break

      const { row, reason } = entry
      const attempts = row.export_attempts ?? 0

      if (attempts >= MAX_ATTEMPTS) {
        gaveUp += 1
        results.push({ anilistId: row.anilist_id, title: row.title, skipped: 'max_attempts' })
        continue
      }
      if (!isRetryEligible(row.updated_at ?? null, attempts)) {
        skippedBackoff += 1
        results.push({ anilistId: row.anilist_id, title: row.title, skipped: 'backoff' })
        continue
      }

      const result = await exportPlaceholderAnime(supabase, row, { dry })

      if (!result.ok) {
        failed += 1
        if (result.gaveUp) gaveUp += 1
        errors.push(`${row.anilist_id}: ${result.error}`)
        results.push({ anilistId: row.anilist_id, title: row.title, mode: 'error', error: result.error })
        continue
      }

      if (result.skipped) {
        results.push({ anilistId: row.anilist_id, title: row.title, skipped: result.reason })
        continue
      }

      if (reason === 'metadata_changed') refreshed += 1
      else exported += 1

      results.push({
        anilistId: row.anilist_id,
        title: row.title,
        mode: reason,
        seriesId: dry ? null : result.seriesId,
        payload: dry ? result.payload : undefined,
      })
    }

    return Response.json({
      dry,
      selected: batch.length,
      candidates: selected.length,
      exported,
      refreshed,
      failed,
      gaveUp,
      skippedBackoff,
      otakuConfigured: Boolean(process.env.OTAKUNAIJA_API_URL && process.env.OTAKUNAIJA_API_KEY),
      ms: Date.now() - startedAt,
      errors,
      results,
    })
  } catch (error) {
    const message = getErrorMessage(error)
    const missingDatabase = message.includes('Supabase server credentials')
    return Response.json(
      { error: missingDatabase ? 'SUPABASE_NOT_CONFIGURED' : 'EXPORT_FAILED', message, dry },
      { status: missingDatabase ? 503 : 500 },
    )
  }
}
