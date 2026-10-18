/** A parsed subtitle cue; times in seconds on the file's own timeline. */
export interface SubtitleCue {
  start: number;
  end: number;
  /** WebVTT cue text: plain text plus `<i>`, `<b>`, `<u>` tags; lines separated by `\n`. */
  text: string;
  /** WebVTT cue settings (`align`, `line`, `position`, `size`, `vertical`), when the source had them. */
  settings?: Record<string, string>;
}

const HTML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: '\u00A0' };

/** Keeps only the tags VTTCue renders (`<i> <b> <u>`), drops `<font>` & co and ASS `{\…}` overrides. */
export function cleanCueText(text: string): string {
  return text
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<\/?([a-z]+)\b[^>]*>/gi, (tag, name: string) =>
      /^[ibu]$/i.test(name) ? tag.toLowerCase().replace(/\s.*>$/, '>') : '',
    )
    .replace(/&(amp|lt|gt|nbsp);/g, (m, e: string) => HTML_ENTITIES[e] ?? m)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n');
}

/** Drops empty and zero-length cues, sorts by start. */
export function finishCues(cues: SubtitleCue[]): SubtitleCue[] {
  return cues.filter((c) => c.text !== '' && c.end > c.start).sort((a, b) => a.start - b.start);
}
