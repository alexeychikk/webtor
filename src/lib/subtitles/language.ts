/**
 * Language codes for subtitle tracks. Everything is normalised to ISO 639-1 where we know the
 * language ("eng", "English" → "en"), so MKV tags (ISO 639-2), BCP 47 tags and filenames compare equal.
 */

// [639-1, 639-2/B, 639-2/T or '', English name, native name]
const LANGUAGES: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ['ar', 'ara', '', 'Arabic', 'العربية'],
  ['bg', 'bul', '', 'Bulgarian', 'Български'],
  ['ca', 'cat', '', 'Catalan', 'Català'],
  ['cs', 'cze', 'ces', 'Czech', 'Čeština'],
  ['da', 'dan', '', 'Danish', 'Dansk'],
  ['de', 'ger', 'deu', 'German', 'Deutsch'],
  ['el', 'gre', 'ell', 'Greek', 'Ελληνικά'],
  ['en', 'eng', '', 'English', 'English'],
  ['es', 'spa', '', 'Spanish', 'Español'],
  ['et', 'est', '', 'Estonian', 'Eesti'],
  ['fa', 'per', 'fas', 'Persian', 'فارسی'],
  ['fi', 'fin', '', 'Finnish', 'Suomi'],
  ['fr', 'fre', 'fra', 'French', 'Français'],
  ['he', 'heb', '', 'Hebrew', 'עברית'],
  ['hi', 'hin', '', 'Hindi', 'हिन्दी'],
  ['hr', 'hrv', '', 'Croatian', 'Hrvatski'],
  ['hu', 'hun', '', 'Hungarian', 'Magyar'],
  ['id', 'ind', '', 'Indonesian', 'Bahasa Indonesia'],
  ['it', 'ita', '', 'Italian', 'Italiano'],
  ['ja', 'jpn', '', 'Japanese', '日本語'],
  ['ko', 'kor', '', 'Korean', '한국어'],
  ['lt', 'lit', '', 'Lithuanian', 'Lietuvių'],
  ['lv', 'lav', '', 'Latvian', 'Latviešu'],
  ['ms', 'may', 'msa', 'Malay', 'Bahasa Melayu'],
  ['nl', 'dut', 'nld', 'Dutch', 'Nederlands'],
  ['no', 'nor', '', 'Norwegian', 'Norsk'],
  ['pl', 'pol', '', 'Polish', 'Polski'],
  ['pt', 'por', '', 'Portuguese', 'Português'],
  ['ro', 'rum', 'ron', 'Romanian', 'Română'],
  ['ru', 'rus', '', 'Russian', 'Русский'],
  ['sk', 'slo', 'slk', 'Slovak', 'Slovenčina'],
  ['sl', 'slv', '', 'Slovenian', 'Slovenščina'],
  ['sr', 'srp', '', 'Serbian', 'Српски'],
  ['sv', 'swe', '', 'Swedish', 'Svenska'],
  ['th', 'tha', '', 'Thai', 'ไทย'],
  ['tr', 'tur', '', 'Turkish', 'Türkçe'],
  ['uk', 'ukr', '', 'Ukrainian', 'Українська'],
  ['vi', 'vie', '', 'Vietnamese', 'Tiếng Việt'],
  ['zh', 'chi', 'zho', 'Chinese', '中文'],
];

const BY_TOKEN = new Map<string, string>();
const NAMES = new Map<string, string>();
for (const [code, b, t, name, native] of LANGUAGES) {
  for (const token of [code, b, t, name, native])
    if (token) BY_TOKEN.set(token.toLowerCase(), code);
  NAMES.set(code, name);
}
// Common filename spellings.
for (const [token, code] of [
  ['jp', 'ja'],
  ['ua', 'uk'],
  ['brazilian', 'pt'],
  ['chs', 'zh'],
  ['cht', 'zh'],
] as const) {
  BY_TOKEN.set(token, code);
}
/** Filename words that qualify a subtitle file rather than name its language. */
const QUALIFIERS = new Set([
  'forced',
  'sdh',
  'hi',
  'cc',
  'full',
  'default',
  'subs',
  'sub',
  'br',
  'us',
  'gb',
]);

/** "eng", "en-US", "English" → "en"; unknown codes are lower-cased; "und"/empty → "". */
export function normalizeLanguage(tag: string | null | undefined): string {
  const t = (tag ?? '').trim().toLowerCase();
  if (!t || t === 'und' || t === 'zxx' || t === 'mul') return '';
  const known = BY_TOKEN.get(t) ?? BY_TOKEN.get(t.split(/[-_]/)[0]!);
  return known ?? t;
}

/** Human-readable name for a normalised code ("en" → "English"); the code itself when unknown. */
export function languageName(code: string): string {
  return NAMES.get(code) ?? code;
}

/**
 * Guesses the language from a subtitle filename: `Movie.en.srt`, `Movie.eng.forced.srt`,
 * `Movie_Russian.srt`, `Subs/2_English.srt`. Only tokens after the first one count, and a
 * 2–3 letter code only as the last one, so title words (`It.Follows.srt`) are not taken for a language. Returns "" when nothing matches.
 */
export function guessLanguageFromFilename(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? '';
  const stem = base.replace(/\.[^.]+$/, '');
  const tokens = stem.split(/[.\s_\-[\]()]+/).filter(Boolean);
  let last = tokens.length - 1;
  while (last >= 1 && QUALIFIERS.has(tokens[last]!.toLowerCase())) last--;
  for (let i = last; i >= 1; i--) {
    const token = tokens[i]!.toLowerCase();
    // Codes only right before the extension (`.en.srt`, `.eng.forced.srt`); full names anywhere.
    const code = BY_TOKEN.get(token);
    if (code && (i === last || token.length > 3)) return code;
  }
  // A file named just "English.srt" or "rus.srt" (common inside a Subs/ folder).
  if (tokens.length === 1) {
    const only = tokens[0]!.toLowerCase();
    if (only.length >= 3) return BY_TOKEN.get(only) ?? '';
  }
  return '';
}

/** True when the filename marks a forced-narrative track (`Movie.en.forced.srt`). */
export function isForcedFilename(path: string): boolean {
  return /(^|[.\s_\-[(])forced([.\s_\-\])]|$)/i.test(path.replace(/\.[^.]+$/, ''));
}
