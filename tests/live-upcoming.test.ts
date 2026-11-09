import { describe, expect, it } from 'vitest'

import { buildOtakuAnimePayload, normalizeAniListMedia, selectUpcoming, toPlaceholderRow } from '@/lib/upcoming'
import { fetchAniListMedia, fetchAniListWithRetry, parseAniListMedia, type AniListMediaResponse } from '@/lib/supabase/admin'

/**
 * Live AniList smoke test. Skipped by default so `pnpm test` stays offline:
 *   LIVE_ANILIST=1 npx vitest run tests/live-upcoming.test.ts
 */
describe.skipIf(process.env.LIVE_ANILIST !== '1')('live AniList (opt-in)', () => {
  it('normalises a real upcoming title and builds a placeholder payload', async () => {
    const result = await fetchAniListWithRetry(
      () => fetchAniListMedia(126016),
      (payload) => parseAniListMedia(payload as AniListMediaResponse),
      { deadline: Date.now() + 20_000 },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const normalized = normalizeAniListMedia(result.parsed)
    expect(normalized).not.toBeNull()
    if (!normalized) return

    expect(normalized.anilist_id).toBe(126016)
    expect(normalized.cover_url).toBeTruthy()

    const selection = selectUpcoming([normalized], { now: Date.now() })
    expect(selection.accepted).toHaveLength(1)

    const row = toPlaceholderRow(normalized)
    const payload = buildOtakuAnimePayload(row, { statusOverride: 'upcoming', isPlaceholder: true })

    // Printed on purpose: this is the real payload the export route would POST.
    console.log('live placeholder payload:', JSON.stringify(payload, null, 2))

    expect(payload.status).toBe('upcoming')
    expect(payload.isPlaceholder).toBe(true)
  })
})
