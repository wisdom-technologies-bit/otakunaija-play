/**
 * Label -> `srclang` mapping, shared by the watch route and the ani provider.
 *
 * Providers word their labels loosely: "Portuguese - Brazil", "Spanish (Latin
 * America)", "English SDH". The language is the leading word, the rest is the
 * variant, so a label the exact map misses still maps to a sensible code.
 *
 * Some providers are worse than loose: AniKoto reports `language: "en"` for
 * EVERY track, including the Arabic, French, Thai and Indonesian ones. For those
 * providers the label is the only trustworthy signal, so `srclangFromLabel` is
 * used instead of the `language` field (see `lib/ani/resolve.ts`).
 *
 * Pure data plus pure functions: importable from a route handler and from
 * `lib/ani/*` without pulling anything runtime-specific in.
 */

export const SUBTITLE_LABEL_TO_SRCLANG: Record<string, string> = {
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

export const SUBTITLE_LEADING_WORD_TO_SRCLANG: Record<string, string> = {
  english: 'en',
  japanese: 'ja',
  chinese: 'zh',
  mandarin: 'zh',
  cantonese: 'zh',
  korean: 'ko',
  arabic: 'ar',
  german: 'de',
  spanish: 'es',
  latino: 'es',
  french: 'fr',
  indonesian: 'id',
  italian: 'it',
  malay: 'ms',
  polish: 'pl',
  portuguese: 'pt',
  russian: 'ru',
  thai: 'th',
  vietnamese: 'vi',
  turkish: 'tr',
  dutch: 'nl',
  hebrew: 'he',
  greek: 'el',
  bulgarian: 'bg',
  danish: 'da',
  finnish: 'fi',
  norwegian: 'no',
  swedish: 'sv',
  czech: 'cs',
  hungarian: 'hu',
  romanian: 'ro',
  ukrainian: 'uk',
  hindi: 'hi',
  bengali: 'bn',
  tamil: 'ta',
  telugu: 'te',
  filipino: 'fil',
  tagalog: 'tl',
  persian: 'fa',
  urdu: 'ur',
  croatian: 'hr',
  serbian: 'sr',
  catalan: 'ca',
  swahili: 'sw',
  afrikaans: 'af',
}

function normalizeLabel(rawLabel: string): string {
  return rawLabel.trim().toLowerCase().replace(/\s+/g, ' ')
}

function leadingWord(label: string): string {
  return label.split(/[\s(\-\u2013\u2014/.,;|\[]/)[0]
}

function chineseVariant(label: string, base: string): string {
  if (base !== 'zh') return base
  if (label.includes('simplified')) return 'zh-Hans'
  if (label.includes('traditional')) return 'zh-Hant'
  return base
}

/**
 * Derive an `srclang` from the label alone: the exact-label map first, then the
 * leading word. Returns undefined when the label says nothing usable, which is
 * the honest answer for "Track 1" or "Forced".
 */
export function srclangFromLabel(rawLabel: string | null | undefined): string | undefined {
  if (!rawLabel) return undefined
  const label = normalizeLabel(rawLabel)
  if (!label) return undefined
  const exact = SUBTITLE_LABEL_TO_SRCLANG[label]
  if (exact) return exact
  const base = SUBTITLE_LEADING_WORD_TO_SRCLANG[leadingWord(label)]
  if (!base) return undefined
  return chineseVariant(label, base)
}

/**
 * The watch route's correction: fill a missing `srclang` from the label, but
 * never overwrite one the provider stated itself. `current` is what the track
 * arrived with; the exact-label map still wins because a provider that words a
 * label as plain "English" is unambiguous.
 */
export function srclangForLabel(rawLabel: string | null, current: unknown): string | undefined {
  if (!rawLabel) return undefined
  const label = normalizeLabel(rawLabel)
  if (!label) return undefined
  const exact = SUBTITLE_LABEL_TO_SRCLANG[label]
  if (exact) return exact
  if (typeof current === 'string' && current.length > 0) return undefined
  const base = SUBTITLE_LEADING_WORD_TO_SRCLANG[leadingWord(label)]
  if (!base) return undefined
  return chineseVariant(label, base)
}
