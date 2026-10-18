/** A parsed subtitle cue; times in seconds on the file's own timeline. */
export interface SubtitleCue {
  start: number;
  end: number;
  /** WebVTT cue text: escaped text (`&lt;` `&gt;` `&amp;`) plus `<i>`, `<b>`, `<u>` tags; lines split by `\n`. */
  text: string;
  /** WebVTT cue settings (`align`, `line`, `position`, `size`, `vertical`), when the source had them. */
  settings?: Record<string, string>;
  /**
   * Embedded ASS/SSA: the block payload as Matroska stores it (`ReadOrder,Layer,Style,…,Text`), for
   * the styled renderer (libass `processChunk`); `text` is its plain-text fallback.
   */
  assChunk?: string;
}

// A tag: `<i>`, `</b>`, `<v Bob>`, `<c.loud>`, `<font color="…">`; or a WebVTT timestamp `<00:01.000>`.
const TAG = /<(\/?)([a-z]+)\b[^<>]*>|<(?:\d+:)?\d{2}:\d{2}\.\d{3}>/gi;
// `&` that does not start a character reference (`&amp;`, `&nbsp;`, `&#60;`, `&#x3C;`).
const BARE_AMP = /&(?![a-z][a-z\d]*;|#\d+;|#x[\da-f]+;)/gi;

const escapeText = (text: string) =>
  text.replace(BARE_AMP, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Source text → WebVTT cue text, which `VTTCue` parses again when it renders: keeps `<i> <b> <u>`
 * (normalised), drops other tags and ASS `{\…}` overrides, and escapes every other `<`, `>` and bare
 * `&` so `I <3 you` or `a &lt; b` render as written. Existing character references are left alone.
 */
export function cleanCueText(text: string): string {
  const source = text.replace(/\{\\[^}]*\}/g, '');
  let out = '';
  let last = 0;
  for (const m of source.matchAll(TAG)) {
    out += escapeText(source.slice(last, m.index));
    const name = m[2]?.toLowerCase();
    if (name && /^[ibu]$/.test(name)) out += `<${m[1]}${name}>`;
    last = m.index + m[0].length;
  }
  out += escapeText(source.slice(last));
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n');
}

/** Drops empty and zero-length cues, sorts by start. */
export function finishCues(cues: SubtitleCue[]): SubtitleCue[] {
  return cues.filter((c) => c.text !== '' && c.end > c.start).sort((a, b) => a.start - b.start);
}

/** Subtitle delay steps (the ± buttons). */
export const SUBTITLE_DELAY_STEP_S = 0.5;

/**
 * Cues moved by `delay` seconds (positive = later, for subtitles that show too early). Cues that
 * would end before 0 are dropped; one that would start before 0 starts at 0.
 */
export function shiftCues(cues: readonly SubtitleCue[], delay: number): SubtitleCue[] {
  if (delay === 0) return [...cues];
  return cues
    .filter((c) => c.end + delay > 0)
    .map((c) => ({ ...c, start: Math.max(0, c.start + delay), end: c.end + delay }));
}

/** `+0.5 s`, `−1.0 s`, `0.0 s` for the delay readout. */
export function formatSubtitleDelay(delay: number): string {
  const sign = delay > 0 ? '+' : delay < 0 ? '−' : '';
  return `${sign}${Math.abs(delay).toFixed(1)} s`;
}
