/**
 * Pure logic for upcoming / seasonal discovery.
 *
 * Everything in this module is side-effect free so it can be unit tested
 * without network or database access. The routes import these helpers; the
 * AniList fetch wrappers live in lib/supabase/admin.ts.
 */

// ---------------------------------------------------------------------------
// AniList shapes
// ---------------------------------------------------------------------------

export type AniListDate = {
  year?: number | null
  month?: number | null
  day?: number | null
} | null

export type AniListMedia = {
  id?: number | null
  idMal?: number | null
  title?: { romaji?: string | null; english?: string | null } | null
  coverImage?: { extraLarge?: string | null; large?: string | null } | null
  bannerImage?: string | null
  startDate?: AniListDate
  season?: string | null
  seasonYear?: number | null
  format?: string | null
  status?: string | null
  episodes?: number | null
  duration?: number | null
  genres?: string[] | null
  studios?: { nodes?: Array<{ name?: string | null } | null> | null } | null
  description?: string | null
  popularity?: number | null
  trailer?: { id?: string | null; site?: string | null } | null
  source?: string | null
  nextAiringEpisode?: { airingAt?: number | null; episode?: number | null } | null
  isAdult?: boolean | null
}

export type NormalizedMedia = {
  anilist_id: number
  mal_id: number | null
  title: string
  description: string | null
  cover_url: string | null
  poster_url: string | null
  banner_url: string | null
  genres: string[]
  status: string | null
  release_year: number | null
  studio: string | null
  format: string | null
  start_date: string | null
  start_year: number | null
  start_month: number | null
  start_day: number | null
  season: string | null
  season_year: number | null
  popularity: number | null
  trailer_site: string | null
  trailer_id: string | null
  episodes_total: number | null
  duration_minutes: number | null
  source: string | null
  is_adult: boolean
  next_airing_episode: { airingAt: number | null; episode: number | null } | null
}

export const ALLOWED_FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'ONA', 'OVA', 'SPECIAL'] as const

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
  nbsp: '\u00a0',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  rsquo: '\u2019',
  lsquo: '\u2018',
  ldquo: '\u201c',
  rdquo: '\u201d',
}

/** Decode the small set of HTML entities AniList/Jikan descriptions use. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x'
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
}

/** Same contract as the decodeHtml helper the existing routes use. */
export function decodeHtmlText(value: string | null | undefined): string | null {
  if (value == null) return null
  return decodeHtmlEntities(value)
}

/**
 * AniList descriptions arrive as light HTML (or `description(asHtml: false)`
 * with <br> left in). Strip tags, decode entities, normalise whitespace.
 * Returns null for empty results so a blank string never overwrites a value.
 */
export function stripHtmlText(value: string | null | undefined): string | null {
  if (value == null) return null
  const withoutBreaks = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<\/p>/gi, '\n')
  const withoutTags = withoutBreaks.replace(/<[^>]+>/g, '')
  const decoded = decodeHtmlEntities(withoutTags)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return decoded.length > 0 ? decoded : null
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null
}

/**
 * AniList start dates are partial: year only, year+month, or a full date.
 * start_date is only set for complete, valid calendar dates; the partial
 * pieces always land in start_year / start_month / start_day.
 */
export function resolveStartDate(date: AniListDate | undefined) {
  const year = positiveInt(date?.year)
  const month = positiveInt(date?.month)
  const day = positiveInt(date?.day)

  const validMonth = month !== null && month >= 1 && month <= 12
  const validDay = day !== null && day >= 1 && day <= 31
  const complete =
    year !== null &&
    validMonth &&
    validDay &&
    new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day

  const iso = complete
    ? `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    : null

  return {
    start_date: iso,
    start_year: year,
    start_month: validMonth ? month : null,
    start_day: validDay ? day : null,
  }
}

/** Anything that can turn a date into "which season was that" for backfill. */
export function seasonForDate(value: Date) {
  const month = value.getUTCMonth() + 1
  const season = month <= 3 ? 'WINTER' : month <= 6 ? 'SPRING' : month <= 9 ? 'SUMMER' : 'FALL'
  return { season, year: value.getUTCFullYear() }
}

export function previousSeason(season: string, year: number) {
  switch (season) {
    case 'WINTER':
      return { season: 'FALL', year: year - 1 }
    case 'SPRING':
      return { season: 'WINTER', year }
    case 'SUMMER':
      return { season: 'SPRING', year }
    default:
      return { season: 'SUMMER', year }
  }
}

const SEASON_ORDER = ['WINTER', 'SPRING', 'SUMMER', 'FALL'] as const

/**
 * The season pair (current + previous) a seasonal sweep should cover.
 * With `year` set it becomes a backfill of that year, newest season first.
 */
export function seasonalTargets(
  now: Date,
  options: { year?: number | null; season?: string | null; maxSeasons?: number } = {},
) {
  const maxSeasons = Math.max(1, Math.min(options.maxSeasons ?? 3, 4))
  const current = seasonForDate(now)
  const explicitSeason = options.season?.toUpperCase()

  if (options.year) {
    const startIndex = explicitSeason && SEASON_ORDER.includes(explicitSeason as never)
      ? SEASON_ORDER.indexOf(explicitSeason as (typeof SEASON_ORDER)[number])
      : SEASON_ORDER.length - 1
    const targets: Array<{ season: string; year: number }> = []
    for (let index = startIndex; index >= 0 && targets.length < maxSeasons; index -= 1) {
      targets.push({ season: SEASON_ORDER[index], year: options.year })
    }
    return targets
  }

  const targets = [current]
  targets.push(previousSeason(current.season, current.year))
  return targets.slice(0, maxSeasons)
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function pickTitle(media: AniListMedia, id: number) {
  // The OtakuNaija UI is English-first: english, then romaji, then a stand-in.
  const english = media.title?.english?.trim()
  if (english) return english
  const romaji = media.title?.romaji?.trim()
  if (romaji) return romaji
  return `Anime ${id}`
}

/**
 * Map an AniList media object onto anime columns.
 * Returns null only when the object has no usable id; the interesting
 * rejections (adult, no cover) are reported by selectUpcoming so the route can
 * count them.
 */
export function normalizeAniListMedia(media: AniListMedia | null | undefined): NormalizedMedia | null {
  const id = positiveInt(media?.id)
  if (!media || id === null) return null

  const cover = media.coverImage?.extraLarge ?? media.coverImage?.large ?? null
  const dates = resolveStartDate(media.startDate)
  const studio = media.studios?.nodes?.find((node) => node?.name)?.name ?? null
  const next = media.nextAiringEpisode

  return {
    anilist_id: id,
    mal_id: positiveInt(media.idMal),
    title: pickTitle(media, id),
    description: stripHtmlText(media.description),
    cover_url: cover,
    poster_url: cover,
    banner_url: media.bannerImage ?? null,
    genres: (media.genres ?? []).filter((genre): genre is string => Boolean(genre)),
    status: media.status ?? null,
    release_year: dates.start_year ?? positiveInt(media.seasonYear),
    studio,
    format: media.format ? media.format.toUpperCase() : null,
    start_date: dates.start_date,
    start_year: dates.start_year,
    start_month: dates.start_month,
    start_day: dates.start_day,
    season: media.season ?? null,
    season_year: positiveInt(media.seasonYear),
    popularity: Number.isFinite(media.popularity ?? NaN) ? Math.trunc(media.popularity as number) : null,
    trailer_site: media.trailer?.site ?? null,
    trailer_id: media.trailer?.id ?? null,
    episodes_total: positiveInt(media.episodes),
    duration_minutes: positiveInt(media.duration),
    source: media.source ?? null,
    is_adult: media.isAdult === true,
    next_airing_episode: next
      ? { airingAt: next.airingAt ?? null, episode: next.episode ?? null }
      : null,
  }
}

// ---------------------------------------------------------------------------
// Upcoming selection
// ---------------------------------------------------------------------------

export type UpcomingSelectionOptions = {
  now?: number
  minPopularity?: number
  windowMonths?: number
  /** How far in the past a NOT_YET_RELEASED start date may sit before it looks stale. */
  staleDays?: number
  allowedFormats?: readonly string[]
}

export type SkipReason = 'adult' | 'no_cover' | 'format' | 'stale_start_date' | 'low_popularity_tba' | 'stale_tba'

export type UpcomingSelection = {
  accepted: NormalizedMedia[]
  skippedAdult: number
  skippedNoCover: number
  skippedFormat: number
  skippedOutOfWindow: number
  skippedLowPopularity: number
  reasons: Array<{ anilistId: number; title: string; reason: SkipReason }>
}

const DAY_MS = 86_400_000

/**
 * The upcoming-selection filter.
 *
 * - adult media and media without a cover are always dropped
 * - a complete start date within [now - staleDays, now + windowMonths] is kept
 * - a complete start date further in the past is stale AniList data, dropped
 * - partial/TBA dates are kept only at/above minPopularity
 */
export function selectUpcoming(
  media: Array<NormalizedMedia | null>,
  options: UpcomingSelectionOptions = {},
): UpcomingSelection {
  const now = options.now ?? Date.now()
  const minPopularity = options.minPopularity ?? 2000
  const windowMonths = options.windowMonths ?? 9
  const staleDays = options.staleDays ?? 30
  const allowedFormats = options.allowedFormats ?? ALLOWED_FORMATS

  const result: UpcomingSelection = {
    accepted: [],
    skippedAdult: 0,
    skippedNoCover: 0,
    skippedFormat: 0,
    skippedOutOfWindow: 0,
    skippedLowPopularity: 0,
    reasons: [],
  }

  const skip = (item: NormalizedMedia, reason: SkipReason) => {
    result.reasons.push({ anilistId: item.anilist_id, title: item.title, reason })
  }

  const windowEnd = now + windowMonths * 30 * DAY_MS
  const windowStart = now - staleDays * DAY_MS

  for (const item of media) {
    if (!item) continue

    if (item.is_adult) {
      result.skippedAdult += 1
      skip(item, 'adult')
      continue
    }
    if (!item.cover_url) {
      result.skippedNoCover += 1
      skip(item, 'no_cover')
      continue
    }
    if (item.format && !allowedFormats.includes(item.format)) {
      result.skippedFormat += 1
      skip(item, 'format')
      continue
    }

    if (item.start_date) {
      const timestamp = Date.parse(`${item.start_date}T00:00:00Z`)
      if (timestamp < windowStart) {
        result.skippedOutOfWindow += 1
        skip(item, 'stale_start_date')
        continue
      }
      if (timestamp > windowEnd) {
        result.skippedOutOfWindow += 1
        skip(item, 'stale_start_date')
        continue
      }
      result.accepted.push(item)
      continue
    }

    // No complete date: a TBA/partial entry only matters when it is popular.
    const popularity = item.popularity ?? 0
    if (popularity < minPopularity) {
      result.skippedLowPopularity += 1
      skip(item, 'low_popularity_tba')
      continue
    }
    result.accepted.push(item)
  }

  return result
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

/**
 * The exact anime columns a normalized media item writes. NormalizedMedia also
 * carries helper-only fields (is_adult, next_airing_episode) that are not
 * columns; spreading the whole object into an insert would fail in PostgREST.
 */
export const ANIME_COLUMNS = [
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
] as const

export type AnimeColumn = (typeof ANIME_COLUMNS)[number]

export type AnimeUpsertRow = Partial<Pick<NormalizedMedia, AnimeColumn>> & {
  anilist_id: number
  is_placeholder?: boolean
  discovery_source?: string | null
  upcoming_checked_at?: string | null
  anilist_synced_at?: string | null
}

/** Column-only projection of a normalized item (no helper fields). */
export function toAnimeColumns(item: NormalizedMedia): Pick<NormalizedMedia, AnimeColumn> {
  const row = {} as Pick<NormalizedMedia, AnimeColumn>
  for (const column of ANIME_COLUMNS) {
    // AniList leaves plenty of these undefined; PostgREST prefers null.
    ;(row as Record<string, unknown>)[column] = item[column] ?? null
  }
  row.anilist_id = item.anilist_id
  return row
}

/** Build the anime row for a placeholder (metadata only, never any episodes). */
export function toPlaceholderRow(
  item: NormalizedMedia,
  options: { now?: string; discoverySource?: string } = {},
): AnimeUpsertRow {
  const now = options.now ?? new Date().toISOString()
  return {
    ...toAnimeColumns(item),
    is_placeholder: true,
    discovery_source: options.discoverySource ?? 'upcoming',
    status: item.status ?? 'NOT_YET_RELEASED',
    upcoming_checked_at: now,
    anilist_synced_at: now,
  }
}

/** Build the anime row for a real (airing or finished) anime discovered by a sweep. */
export function toAnimeRow(
  item: NormalizedMedia,
  options: { now?: string; discoverySource?: string; placeholder?: boolean } = {},
): AnimeUpsertRow {
  const now = options.now ?? new Date().toISOString()
  const placeholder = options.placeholder ?? false
  return {
    ...toAnimeColumns(item),
    is_placeholder: placeholder,
    discovery_source: options.discoverySource ?? 'airing',
    upcoming_checked_at: now,
    anilist_synced_at: now,
  }
}

/**
 * Columns a placeholder refresh is allowed to touch. Export state and the
 * OtakuNaija ids are deliberately absent: refreshing AniList metadata must
 * never reset an exported placeholder back into the export queue by accident.
 */
export const MERGEABLE_ANIME_FIELDS = [
  'mal_id',
  'title',
  'description',
  'cover_url',
  'poster_url',
  'banner_url',
  'genres',
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
] as const

export type MergeableAnimeField = (typeof MERGEABLE_ANIME_FIELDS)[number]
export type MergeableAnimeValues = Partial<Record<MergeableAnimeField, unknown>>

function isBlank(value: unknown) {
  if (value === null || value === undefined) return true
  if (typeof value === 'string' && value.trim() === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

/**
 * Merge-not-blank: take the incoming value when it is present, otherwise keep
 * what the row already has. A null from AniList (or a failed Jikan lookup) must
 * never wipe a good title, cover, description or date.
 */
export function mergeAnimeMetadata<T extends MergeableAnimeValues>(
  existing: T | null | undefined,
  incoming: MergeableAnimeValues,
): MergeableAnimeValues {
  const merged: MergeableAnimeValues = {}
  for (const field of MERGEABLE_ANIME_FIELDS) {
    if (!(field in incoming)) continue
    const next = incoming[field]
    const current = existing?.[field]
    merged[field] = isBlank(next) ? current ?? null : next
  }
  return merged
}

/** Which metadata columns actually changed between an existing row and an incoming payload. */
export function changedAnimeFields<T extends MergeableAnimeValues>(
  existing: T | null | undefined,
  merged: MergeableAnimeValues,
) {
  const changed: MergeableAnimeField[] = []
  for (const field of MERGEABLE_ANIME_FIELDS) {
    if (!(field in merged)) continue
    const before = JSON.stringify(existing?.[field] ?? null)
    const after = JSON.stringify(merged[field] ?? null)
    if (before !== after) changed.push(field)
  }
  return changed
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

export type OtakuStatus = 'upcoming' | 'ongoing' | 'completed'

/** AniList status vocabulary -> OtakuNaija status vocabulary. */
export function mapAniListStatus(status: string | null | undefined): OtakuStatus | null {
  switch ((status ?? '').toUpperCase()) {
    case 'NOT_YET_RELEASED':
      return 'upcoming'
    case 'RELEASING':
    case 'HIATUS':
      return 'ongoing'
    case 'FINISHED':
    case 'CANCELLED':
      return 'completed'
    default:
      return null
  }
}

/**
 * anime.status holds both vocabularies: Jikan ("Currently Airing") from the
 * sync path and AniList ("RELEASING") after a promotion. Accept both.
 */
export function mapStoredStatus(status: string | null | undefined): OtakuStatus | null {
  const value = (status ?? '').trim().toLowerCase()
  if (!value) return null
  if (['not yet aired', 'not_yet_released', 'upcoming', 'tba', 'unreleased'].includes(value)) return 'upcoming'
  if (['currently airing', 'releasing', 'airing', 'ongoing', 'hiatus', 'on hiatus'].includes(value)) return 'ongoing'
  if (['finished airing', 'finished', 'completed', 'complete', 'cancelled', 'canceled'].includes(value)) return 'completed'
  return null
}

// ---------------------------------------------------------------------------
// OtakuNaija payloads
// ---------------------------------------------------------------------------

export type OtakuAnimeRow = {
  anilist_id: number
  mal_id?: number | null
  title?: string | null
  description?: string | null
  cover_url?: string | null
  genres?: string[] | null
  status?: string | null
  release_year?: number | null
  studio?: string | null
  poster_url?: string | null
  banner_url?: string | null
  format?: string | null
  start_date?: string | null
  start_year?: number | null
  season?: string | null
  season_year?: number | null
  popularity?: number | null
  trailer_site?: string | null
  trailer_id?: string | null
  episodes_total?: number | null
  duration_minutes?: number | null
  source?: string | null
}

export type OtakuAnimePayload = {
  anilistId: number
  title: string | null
  description: string | null
  coverUrl: string | null
  genres: string[] | null
  status: string | null
  releaseYear: number | null
  studioName: string | null
  posterUrl: string | null
  bannerUrl: string | null
  format?: string | null
  startDate?: string | null
  startYear?: number | null
  season?: string | null
  seasonYear?: number | null
  popularity?: number | null
  trailerSite?: string | null
  trailerId?: string | null
  episodesTotal?: number | null
  durationMinutes?: number | null
  source?: string | null
  isPlaceholder?: boolean
}

/**
 * Payload for POST {OTAKUNAIJA_API_URL}/api/play/anime.
 *
 * `statusOverride` wins over the stored status. Placeholders are always sent as
 * status 'upcoming' with isPlaceholder true and the new metadata fields; the
 * ongoing/completed re-post only needs the status but carries format so
 * OtakuNaija can keep showing the right content type.
 */
export function buildOtakuAnimePayload(
  row: OtakuAnimeRow,
  options: { statusOverride?: string | null; isPlaceholder?: boolean } = {},
): OtakuAnimePayload {
  const placeholder = options.isPlaceholder === true
  const status = options.statusOverride ?? row.status ?? null

  const payload: OtakuAnimePayload = {
    anilistId: row.anilist_id,
    title: row.title ?? null,
    description: row.description ?? null,
    coverUrl: row.cover_url ?? null,
    genres: row.genres ?? null,
    status,
    releaseYear: row.release_year ?? null,
    studioName: row.studio ?? null,
    posterUrl: row.poster_url ?? null,
    bannerUrl: row.banner_url ?? null,
    format: row.format ?? null,
  }

  if (placeholder) {
    payload.startDate = row.start_date ?? null
    payload.startYear = row.start_year ?? null
    payload.season = row.season ?? null
    payload.seasonYear = row.season_year ?? null
    payload.popularity = row.popularity ?? null
    payload.trailerSite = row.trailer_site ?? null
    payload.trailerId = row.trailer_id ?? null
    payload.episodesTotal = row.episodes_total ?? null
    payload.durationMinutes = row.duration_minutes ?? null
    payload.source = row.source ?? null
    payload.isPlaceholder = true
  }

  return payload
}

/**
 * Stable snapshot of the metadata OtakuNaija received, so a later AniList
 * refresh can tell whether a re-post would actually change anything.
 */
export function upcomingExportFingerprint(row: OtakuAnimeRow): string {
  return [
    row.title ?? '',
    row.start_date ?? '',
    row.start_year ?? '',
    row.cover_url ?? '',
    row.banner_url ?? '',
    `${row.trailer_site ?? ''}:${row.trailer_id ?? ''}`,
    row.format ?? '',
    row.episodes_total ?? '',
    row.duration_minutes ?? '',
    row.season ?? '',
    row.season_year ?? '',
  ].join('|')
}

// ---------------------------------------------------------------------------
// AniList id parsing (manual import)
// ---------------------------------------------------------------------------

/**
 * Accepts 12345, "12345", https://anilist.co/anime/12345/Title,
 * anilist.co/anime/12345?foo=1, https://anilist.co/anime/12345.
 */
export function parseAniListId(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null
  if (typeof input === 'number') return positiveInt(input)

  const value = input.trim()
  if (!value) return null
  if (/^\d+$/.test(value)) return positiveInt(value)

  // Only anilist.co/anime/<id> urls: /anime/<id> alone would happily accept a
  // MyAnimeList link and import the wrong show.
  const match = value.match(/anilist\.co\/anime\/(\d+)/i)
  return match ? positiveInt(match[1]) : null
}

/** How many episodes to queue per anime in one run (the sync job catches up). */
export function episodesToQueue(
  episodesTotal: number | null,
  nextAiringEpisodeNumber: number | null,
  cap = 3,
): number[] {
  const known = episodesTotal ?? (nextAiringEpisodeNumber ? Math.max(1, nextAiringEpisodeNumber - 1) : null)
  const total = Math.max(1, Math.min(known ?? 1, cap))
  return Array.from({ length: total }, (_, index) => index + 1)
}
