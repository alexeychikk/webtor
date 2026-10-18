import { parseAssAsText } from './ass';
import type { SubtitleCue } from './cue';
import { decodeSubtitleBytes } from './encoding';
import { parseSrt } from './srt';
import { parseVtt } from './vtt';

export type SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'ssa';

const FORMATS: readonly SubtitleFormat[] = ['srt', 'vtt', 'ass', 'ssa'];
export const SUBTITLE_EXTENSIONS = FORMATS.map((f) => `.${f}`);

export function subtitleFormatOf(name: string): SubtitleFormat | null {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return (FORMATS as readonly string[]).includes(ext) ? (ext as SubtitleFormat) : null;
}

/** Format from the content, for files whose extension lies or is missing. */
export function sniffFormat(text: string): SubtitleFormat | null {
  const head = text
    .replace(/^\uFEFF/, '')
    .trimStart()
    .slice(0, 4096);
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (/^\[Script Info\]/i.test(head) || /^\s*Dialogue:/m.test(head)) return 'ass';
  if (/\d{1,2}:\d{1,2}:\d{1,2}[,.]\d{1,3}\s*-->/.test(head)) return 'srt';
  return null;
}

export class SubtitleParseError extends Error {
  override name = 'SubtitleParseError';
}

export interface ParsedSubtitleFile {
  format: SubtitleFormat;
  /** Decoded text (for ASS/SSA: the script the styled renderer reads). */
  text: string;
  cues: SubtitleCue[];
}

/**
 * Decodes and parses a subtitle file. The content decides over the extension when they disagree
 * (a `.srt` that is really WebVTT). Throws `SubtitleParseError` when no cue could be read.
 */
export function readSubtitleFile(bytes: Uint8Array, name: string): ParsedSubtitleFile {
  const { text } = decodeSubtitleBytes(bytes);
  const format = sniffFormat(text) ?? subtitleFormatOf(name);
  if (!format) throw new SubtitleParseError(`unrecognised subtitle format: ${name}`);
  const cues =
    format === 'vtt' ? parseVtt(text) : format === 'srt' ? parseSrt(text) : parseAssAsText(text);
  if (!cues.length) throw new SubtitleParseError(`no cues in ${name}`);
  return { format, text, cues };
}

/** `readSubtitleFile`, cues only. */
export function parseSubtitleFile(bytes: Uint8Array, name: string): SubtitleCue[] {
  return readSubtitleFile(bytes, name).cues;
}

export const isAssFormat = (format: SubtitleFormat | null) => format === 'ass' || format === 'ssa';
