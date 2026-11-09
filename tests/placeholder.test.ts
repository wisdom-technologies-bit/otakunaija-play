import { describe, expect, it } from 'vitest'

import { placeholderNeedsExport, type PlaceholderRow } from '@/lib/placeholder'

function row(overrides: Partial<PlaceholderRow> = {}): PlaceholderRow {
  const base = {
    anilist_id: 1234,
    title: 'Some Upcoming Show',
    cover_url: 'https://img/cover.jpg',
    banner_url: null,
    format: 'TV',
    start_date: '2027-01-10',
    start_year: 2027,
    season: 'WINTER',
    season_year: 2027,
    episodes_total: 12,
    duration_minutes: 24,
    trailer_site: null,
    trailer_id: null,
    popularity: 3000,
    otaku_anime_id: 777,
    exported_to_otaku: true,
    export_attempts: 0,
    last_export_error: null,
    is_placeholder: true,
    status_synced_to_otaku: 'upcoming',
    upcoming_exported_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
  }
  // Fingerprint as written by a previous successful export.
  const fingerprint = [
    base.title ?? '',
    base.start_date ?? '',
    base.start_year ?? '',
    base.cover_url ?? '',
    base.banner_url ?? '',
    `${base.trailer_site ?? ''}:${base.trailer_id ?? ''}`,
    base.format ?? '',
    base.episodes_total ?? '',
    base.duration_minutes ?? '',
    base.season ?? '',
    base.season_year ?? '',
  ].join('|')

  return { ...base, upcoming_export_fingerprint: fingerprint, ...overrides } as PlaceholderRow
}

describe('placeholderNeedsExport (placeholder export selection)', () => {
  it('skips a placeholder that OtakuNaija already has, unchanged', () => {
    expect(placeholderNeedsExport(row())).toBeNull()
  })

  it('exports a placeholder that was never exported', () => {
    expect(placeholderNeedsExport(row({ otaku_anime_id: null }))).toBe('not_exported')
    expect(
      placeholderNeedsExport(row({ upcoming_exported_at: null, upcoming_export_fingerprint: null })),
    ).toBe('not_exported')
  })

  it('re-exports when OtakuNaija does not hold it as upcoming any more', () => {
    expect(placeholderNeedsExport(row({ status_synced_to_otaku: 'ongoing' }))).toBe('status_drift')
    expect(placeholderNeedsExport(row({ status_synced_to_otaku: null }))).toBe('status_drift')
  })

  it('re-exports when AniList moved the start date', () => {
    // Refresh written row keeps the old fingerprint, new date differs.
    const previous = row()
    expect(placeholderNeedsExport({ ...previous, start_date: '2027-04-01' })).toBe('metadata_changed')
  })

  it('re-exports when the cover, trailer or format changed', () => {
    const previous = row()
    expect(placeholderNeedsExport({ ...previous, cover_url: 'https://img/new.jpg' })).toBe('metadata_changed')
    expect(placeholderNeedsExport({ ...previous, trailer_site: 'youtube', trailer_id: 'xyz' })).toBe(
      'metadata_changed',
    )
    expect(placeholderNeedsExport({ ...previous, format: 'MOVIE' })).toBe('metadata_changed')
    expect(placeholderNeedsExport({ ...previous, episodes_total: 24 })).toBe('metadata_changed')
  })

  it('does not re-export for fields OtakuNaija never received', () => {
    const previous = row()
    expect(placeholderNeedsExport({ ...previous, popularity: 9999 })).toBeNull()
    expect(placeholderNeedsExport({ ...previous, anilist_id: 9999 })).toBeNull()
  })
})
