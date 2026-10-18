import { cleanCueText, finishCues, type SubtitleCue } from './cue';

// 00:00:01,000 --> 00:00:03,000 (tolerates `.`, 1–3 ms digits, a missing hour and trailing coords)
const TIMING =
  /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

const seconds = (h: string | undefined, m: string, s: string, ms: string) =>
  Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;

/** Parses SubRip. Lenient: block numbers are optional, a block ends at a blank line or the next timing. */
export function parseSrt(input: string): SubtitleCue[] {
  const lines = input.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const cues: SubtitleCue[] = [];
  let current: { start: number; end: number; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    // A trailing number is the next block's index (when a blank line is missing).
    const body = current.lines;
    while (body.length && /^\s*\d+\s*$/.test(body[body.length - 1]!)) body.pop();
    cues.push({ start: current.start, end: current.end, text: cleanCueText(body.join('\n')) });
    current = null;
  };
  for (const line of lines) {
    const m = TIMING.exec(line);
    if (m) {
      flush();
      current = {
        start: seconds(m[1], m[2]!, m[3]!, m[4]!),
        end: seconds(m[5], m[6]!, m[7]!, m[8]!),
        lines: [],
      };
    } else if (line.trim() === '') {
      if (current?.lines.length) flush();
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return finishCues(cues);
}
