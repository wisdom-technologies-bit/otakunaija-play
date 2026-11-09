import { describe, expect, it } from 'vitest'

import {
  buildOtakuAnimePayload,
  changedAnimeFields,
  decodeHtmlText,
  episodesToQueue,
  mapAniListStatus,
  mapStoredStatus,
  mergeAnimeMetadata,
  normalizeAniListMedia,
  parseAniListId,
  previousSeason,
  seasonalTargets,
  selectUpcoming,
  stripHtmlText,
  toPlaceholderRow,
  upcomingExportFingerprint,
} from '@/lib/upcoming'

const NOW = Date.parse('2026-11-09T12:00:00Z')

function media(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    idMal: 501,
    title: { romaji: 'Romaji Title', english: 'English Title' },
    coverImage: { extraLarge: 'https://img/cover-xl.jpg', large: 'https://img/cover.jpg' },
    bannerImage: 'https://img/banner.jpg',
    startDate: { year: 2027, month: 1, day: 10 },
    season: 'WINTER',
    seasonYear: 2027,
    format: 'TV',
    status: 'NOT_YET_RELEASED',
    episodes: 12,
    duration: 24,
    genres: ['Action'],
    studios: { nodes: [{ name: 'Studio X' }] },
    description: '<i>Line one</i><br>Line two &amp; more',
    popularity: 5000,
    trailer: { id: 'abc123', site: 'youtube' },
    source: 'ORIGINAL',
    nextAiringEpisode: null,
    isAdult: false,
    ...overrides,
  }
}

describe('normalizeAniListMedia', () => {
  it('maps a complete AniList object onto anime columns', () => {
    const row = normalizeAniListMedia(media() as never)!

    expect(row.anilist_id).toBe(1001)
    expect(row.mal_id).toBe(501)
    expect(row.title).toBe('English Title')
    expect(row.cover_url).toBe('https://img/cover-xl.jpg')
    expect(row.poster_url).toBe('https://img/cover-xl.jpg')
    expect(row.banner_url).toBe('https://img/banner.jpg')
    expect(row.start_date).toBe('2027-01-10')
    expect(row.start_year).toBe(2027)
    expect(row.start_month).toBe(1)
    expect(row.start_day).toBe(10)
    expect(row.season).toBe('WINTER')
    expect(row.season_year).toBe(2027)
    expect(row.format).toBe('TV')
    expect(row.popularity).toBe(5000)
    expect(row.trailer_site).toBe('youtube')
    expect(row.trailer_id).toBe('abc123')
    expect(row.episodes_total).toBe(12)
    expect(row.duration_minutes).toBe(24)
    expect(row.source).toBe('ORIGINAL')
    expect(row.studio).toBe('Studio X')
    expect(row.release_year).toBe(2027)
  })

  it('keeps partial dates without inventing a calendar date', () => {
    const yearOnly = normalizeAniListMedia(media({ startDate: { year: 2027, month: null, day: null } }) as never)!
    expect(yearOnly.start_date).toBeNull()
    expect(yearOnly.start_year).toBe(2027)
    expect(yearOnly.start_month).toBeNull()
    expect(yearOnly.start_day).toBeNull()

    const yearMonth = normalizeAniListMedia(media({ startDate: { year: 2027, month: 4, day: null } }) as never)!
    expect(yearMonth.start_date).toBeNull()
    expect(yearMonth.start_month).toBe(4)
    expect(yearMonth.start_day).toBeNull()

    const tba = normalizeAniListMedia(media({ startDate: null }) as never)!
    expect(tba.start_date).toBeNull()
    expect(tba.start_year).toBeNull()
  })

  it('rejects impossible calendar dates instead of rolling them over', () => {
    const row = normalizeAniListMedia(media({ startDate: { year: 2027, month: 2, day: 31 } }) as never)!
    expect(row.start_date).toBeNull()
    expect(row.start_year).toBe(2027)
    expect(row.start_month).toBe(2)
  })

  it('falls back to the large cover and reports a missing cover', () => {
    const large = normalizeAniListMedia(media({ coverImage: { extraLarge: null, large: 'https://img/l.jpg' } }) as never)!
    expect(large.cover_url).toBe('https://img/l.jpg')

    const none = normalizeAniListMedia(media({ coverImage: null }) as never)!
    expect(none.cover_url).toBeNull()
    expect(none.poster_url).toBeNull()
  })

  it('flags adult media and strips HTML from the description', () => {
    const row = normalizeAniListMedia(media({ isAdult: true }) as never)!
    expect(row.is_adult).toBe(true)
    expect(row.description).toBe('Line one\nLine two & more')
  })

  it('returns null when AniList sends no usable id', () => {
    expect(normalizeAniListMedia(null)).toBeNull()
    expect(normalizeAniListMedia({ title: { romaji: 'x' } } as never)).toBeNull()
  })

  it('falls back to romaji then a placeholder title', () => {
    expect(normalizeAniListMedia(media({ title: { english: null, romaji: 'Romaji Only' } }) as never)!.title).toBe('Romaji Only')
    expect(normalizeAniListMedia(media({ title: null }) as never)!.title).toBe('Anime 1001')
  })
})

describe('selectUpcoming', () => {
  const options = { now: NOW, minPopularity: 2000, windowMonths: 9 }

  it('keeps a dated title inside the window', () => {
    const row = normalizeAniListMedia(media({ startDate: { year: 2027, month: 1, day: 10 } }) as never)!
    const result = selectUpcoming([row], options)
    expect(result.accepted).toHaveLength(1)
    expect(result.skippedOutOfWindow).toBe(0)
  })

  it('drops adult media and media without a cover', () => {
    const adult = normalizeAniListMedia(media({ id: 1, isAdult: true }) as never)!
    const noCover = normalizeAniListMedia(media({ id: 2, coverImage: null }) as never)!
    const result = selectUpcoming([adult, noCover], options)
    expect(result.accepted).toHaveLength(0)
    expect(result.skippedAdult).toBe(1)
    expect(result.skippedNoCover).toBe(1)
    expect(result.reasons.map((r) => r.reason)).toEqual(['adult', 'no_cover'])
  })

  it('drops a start date that is stale in the past and one beyond the window', () => {
    const stale = normalizeAniListMedia(media({ id: 3, startDate: { year: 2025, month: 1, day: 1 } }) as never)!
    const far = normalizeAniListMedia(media({ id: 4, startDate: { year: 2029, month: 6, day: 1 } }) as never)!
    const result = selectUpcoming([stale, far], options)
    expect(result.accepted).toHaveLength(0)
    expect(result.skippedOutOfWindow).toBe(2)
  })

  it('keeps TBA titles only above the popularity threshold', () => {
    const popular = normalizeAniListMedia(media({ id: 5, startDate: null, popularity: 2100 }) as never)!
    const quiet = normalizeAniListMedia(media({ id: 6, startDate: null, popularity: 1999 }) as never)!
    const result = selectUpcoming([popular, quiet], options)
    expect(result.accepted.map((row) => row.anilist_id)).toEqual([5])
    expect(result.skippedLowPopularity).toBe(1)
  })

  it('drops formats outside the allowed list', () => {
    const music = normalizeAniListMedia(media({ format: 'MUSIC' }) as never)!
    const result = selectUpcoming([music], options)
    expect(result.accepted).toHaveLength(0)
    expect(result.skippedFormat).toBe(1)
  })

  it('honours a custom popularity threshold', () => {
    const row = normalizeAniListMedia(media({ startDate: null, popularity: 500 }) as never)!
    expect(selectUpcoming([row], { now: NOW, minPopularity: 100 }).accepted).toHaveLength(1)
    expect(selectUpcoming([row], { now: NOW, minPopularity: 600 }).accepted).toHaveLength(0)
  })
})

describe('status mapping', () => {
  it('maps AniList statuses onto the OtakuNaija vocabulary', () => {
    expect(mapAniListStatus('NOT_YET_RELEASED')).toBe('upcoming')
    expect(mapAniListStatus('RELEASING')).toBe('ongoing')
    expect(mapAniListStatus('FINISHED')).toBe('completed')
    expect(mapAniListStatus('HIATUS')).toBe('ongoing')
    expect(mapAniListStatus('CANCELLED')).toBe('completed')
    expect(mapAniListStatus(null)).toBeNull()
    expect(mapAniListStatus('SOMETHING_ELSE')).toBeNull()
  })

  it('also understands the Jikan vocabulary stored by the sync path', () => {
    expect(mapStoredStatus('Currently Airing')).toBe('ongoing')
    expect(mapStoredStatus('Finished Airing')).toBe('completed')
    expect(mapStoredStatus('Not yet aired')).toBe('upcoming')
    expect(mapStoredStatus('RELEASING')).toBe('ongoing')
    expect(mapStoredStatus('  finished  ')).toBe('completed')
    expect(mapStoredStatus('')).toBeNull()
    expect(mapStoredStatus('weird')).toBeNull()
  })
})

describe('buildOtakuAnimePayload', () => {
  const row = {
    anilist_id: 1001,
    mal_id: 501,
    title: 'English Title',
    description: 'Desc',
    cover_url: 'https://img/cover.jpg',
    genres: ['Action'],
    status: 'NOT_YET_RELEASED',
    release_year: 2027,
    studio: 'Studio X',
    poster_url: 'https://img/cover.jpg',
    banner_url: 'https://img/banner.jpg',
    format: 'TV',
    start_date: '2027-01-10',
    start_year: 2027,
    season: 'WINTER',
    season_year: 2027,
    popularity: 5000,
    trailer_site: 'youtube',
    trailer_id: 'abc123',
    episodes_total: 12,
    duration_minutes: 24,
    source: 'ORIGINAL',
  }

  it('sends a placeholder as status upcoming with the new fields', () => {
    const payload = buildOtakuAnimePayload(row, { statusOverride: 'upcoming', isPlaceholder: true })
    expect(payload).toMatchObject({
      anilistId: 1001,
      title: 'English Title',
      coverUrl: 'https://img/cover.jpg',
      status: 'upcoming',
      format: 'TV',
      startDate: '2027-01-10',
      startYear: 2027,
      season: 'WINTER',
      seasonYear: 2027,
      popularity: 5000,
      trailerSite: 'youtube',
      trailerId: 'abc123',
      episodesTotal: 12,
      durationMinutes: 24,
      source: 'ORIGINAL',
      isPlaceholder: true,
    })
  })

  it('keeps the legacy fields for a real anime export', () => {
    const payload = buildOtakuAnimePayload(row, { statusOverride: 'ongoing' })
    expect(payload.status).toBe('ongoing')
    expect(payload).not.toHaveProperty('isPlaceholder')
    expect(payload).not.toHaveProperty('startDate')
    expect(payload.anilistId).toBe(1001)
    expect(payload.bannerUrl).toBe('https://img/banner.jpg')
  })

  it('never emits undefined for a sparse row', () => {
    const payload = buildOtakuAnimePayload({ anilist_id: 7 })
    expect(payload.title).toBeNull()
    expect(payload.genres).toBeNull()
    expect(payload.status).toBeNull()
  })

  it('builds a fingerprint that changes with the exported metadata only', () => {
    const base = upcomingExportFingerprint(row)
    expect(upcomingExportFingerprint({ ...row, start_date: '2027-02-01' })).not.toBe(base)
    expect(upcomingExportFingerprint({ ...row, cover_url: 'https://img/new.jpg' })).not.toBe(base)
    expect(upcomingExportFingerprint({ ...row, trailer_id: 'zzz' })).not.toBe(base)
    expect(upcomingExportFingerprint({ ...row, anilist_id: 9999 })).toBe(base)
  })
})

describe('parseAniListId', () => {
  it('accepts bare ids and AniList urls', () => {
    expect(parseAniListId(12345)).toBe(12345)
    expect(parseAniListId('12345')).toBe(12345)
    expect(parseAniListId(' https://anilist.co/anime/12345/Some-Title ')).toBe(12345)
    expect(parseAniListId('https://anilist.co/anime/12345')).toBe(12345)
    expect(parseAniListId('anilist.co/anime/12345?foo=bar')).toBe(12345)
    expect(parseAniListId('http://anilist.co/anime/12345/#reviews')).toBe(12345)
  })

  it('rejects anything that is not an AniList anime id', () => {
    expect(parseAniListId('')).toBeNull()
    expect(parseAniListId('abc')).toBeNull()
    expect(parseAniListId('0')).toBeNull()
    expect(parseAniListId('-5')).toBeNull()
    expect(parseAniListId(null)).toBeNull()
    expect(parseAniListId('https://myanimelist.net/anime/12345')).toBeNull()
    expect(parseAniListId('https://anilist.co/manga/12345')).toBeNull()
  })
})

describe('mergeAnimeMetadata (merge, do not blank)', () => {
  const existing = {
    title: 'Kept Title',
    description: 'Kept description',
    cover_url: 'https://img/kept.jpg',
    genres: ['Action'],
    start_date: '2027-01-10',
    popularity: 4000,
    mal_id: 501,
  }

  it('keeps existing values when the incoming value is blank', () => {
    const merged = mergeAnimeMetadata(existing, {
      title: null,
      description: '',
      cover_url: undefined,
      genres: [],
      start_date: null,
      popularity: null,
      mal_id: null,
    })
    expect(merged).toEqual({
      title: 'Kept Title',
      description: 'Kept description',
      cover_url: 'https://img/kept.jpg',
      genres: ['Action'],
      start_date: '2027-01-10',
      popularity: 4000,
      mal_id: 501,
    })
  })

  it('takes the incoming value when it is present', () => {
    const merged = mergeAnimeMetadata(existing, { title: 'New Title', start_date: '2027-03-01', popularity: 9000 })
    expect(merged.title).toBe('New Title')
    expect(merged.start_date).toBe('2027-03-01')
    expect(merged.popularity).toBe(9000)
  })

  it('only reports fields that really changed', () => {
    const same = mergeAnimeMetadata(existing, { title: 'Kept Title', popularity: 4000 })
    expect(changedAnimeFields(existing, same)).toEqual([])

    const changed = mergeAnimeMetadata(existing, { title: 'Other', start_date: null })
    expect(changedAnimeFields(existing, changed)).toEqual(['title'])
  })

  it('works on a first insert (no existing row)', () => {
    const merged = mergeAnimeMetadata(null, { title: 'Fresh', cover_url: null })
    expect(merged).toEqual({ title: 'Fresh', cover_url: null })
  })
})

describe('toPlaceholderRow', () => {
  it('only carries real anime columns (no helper fields)', () => {
    const row = toPlaceholderRow(normalizeAniListMedia(media() as never)!)
    // is_adult / next_airing_episode are normalisation helpers, not columns:
    // spreading them into a PostgREST insert would fail the whole batch.
    expect(row).not.toHaveProperty('is_adult')
    expect(row).not.toHaveProperty('next_airing_episode')
    expect(Object.keys(row).sort()).toEqual(
      [
        'anilist_id',
        'mal_id',
        'title',
        'description',
        'cover_url',
        'poster_url',
        'banner_url',
        'genres',
        'status',
        'release_year',
        'studio',
        'format',
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
        'is_placeholder',
        'discovery_source',
        'upcoming_checked_at',
        'anilist_synced_at',
      ].sort(),
    )
  })

  it('marks the row as a placeholder and never invents episodes', () => {
    const row = toPlaceholderRow(normalizeAniListMedia(media() as never)!, {
      now: '2026-11-09T12:00:00.000Z',
      discoverySource: 'upcoming',
    })
    expect(row.is_placeholder).toBe(true)
    expect(row.discovery_source).toBe('upcoming')
    expect(row.status).toBe('NOT_YET_RELEASED')
    expect(row.upcoming_checked_at).toBe('2026-11-09T12:00:00.000Z')
    expect(row.anilist_synced_at).toBe('2026-11-09T12:00:00.000Z')
    expect(row).not.toHaveProperty('episode_number')
  })
})

describe('season helpers', () => {
  it('returns the current and previous season', () => {
    expect(seasonalTargets(new Date('2026-11-09T00:00:00Z'))).toEqual([
      { season: 'FALL', year: 2026 },
      { season: 'SUMMER', year: 2026 },
    ])
  })

  it('handles the year boundary', () => {
    expect(previousSeason('WINTER', 2027)).toEqual({ season: 'FALL', year: 2026 })
    expect(seasonalTargets(new Date('2027-02-01T00:00:00Z'))).toEqual([
      { season: 'WINTER', year: 2027 },
      { season: 'FALL', year: 2026 },
    ])
  })

  it('backfills a given year, newest season first and capped', () => {
    expect(seasonalTargets(new Date('2026-11-09T00:00:00Z'), { year: 2020 })).toEqual([
      { season: 'FALL', year: 2020 },
      { season: 'SUMMER', year: 2020 },
      { season: 'SPRING', year: 2020 },
    ])
    expect(seasonalTargets(new Date('2026-11-09T00:00:00Z'), { year: 2020, season: 'SPRING' })).toEqual([
      { season: 'SPRING', year: 2020 },
      { season: 'WINTER', year: 2020 },
    ])
  })
})

describe('episodesToQueue', () => {
  it('caps the queued episodes at three', () => {
    expect(episodesToQueue(12, null)).toEqual([1, 2, 3])
    expect(episodesToQueue(2, null)).toEqual([1, 2])
    expect(episodesToQueue(null, 5)).toEqual([1, 2, 3])
    expect(episodesToQueue(null, 2)).toEqual([1])
    expect(episodesToQueue(null, null)).toEqual([1])
    expect(episodesToQueue(0, null)).toEqual([1])
  })
})

describe('text helpers', () => {
  it('decodes entities like the existing export path does', () => {
    expect(decodeHtmlText('A &amp; B &#039;quoted&#039; &#x27;x&#x27;')).toBe("A & B 'quoted' 'x'")
    expect(decodeHtmlText(null)).toBeNull()
  })

  it('strips tags and collapses whitespace', () => {
    expect(stripHtmlText('<p>One</p><p>Two</p>')).toBe('One\n\nTwo')
    expect(stripHtmlText('  <b>Bold</b>  ')).toBe('Bold')
    expect(stripHtmlText('<br/><br/><br/>')).toBeNull()
    expect(stripHtmlText('')).toBeNull()
  })
})
