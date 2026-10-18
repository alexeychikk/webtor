import { cleanCueText, finishCues, type SubtitleCue } from './cue';

// 00:01.000 or 00:00:01.000, then cue settings
const TIMING =
  /^\s*(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})(.*)$/;
const SETTING_KEYS = new Set(['align', 'line', 'position', 'size', 'vertical']);

const seconds = (h: string | undefined, m: string, s: string, ms: string) =>
  Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;

function parseSettings(raw: string): Record<string, string> | undefined {
  const settings: Record<string, string> = {};
  for (const part of raw.trim().split(/\s+/)) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const key = part.slice(0, colon);
    if (SETTING_KEYS.has(key)) settings[key] = part.slice(colon + 1);
  }
  return Object.keys(settings).length ? settings : undefined;
}

/** Parses WebVTT cues; skips NOTE, STYLE and REGION blocks. Throws when the `WEBVTT` header is missing. */
export function parseVtt(input: string): SubtitleCue[] {
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text)) throw new Error('not a WebVTT file');
  const blocks = text.split(/\n{2,}/).slice(1);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (/^(NOTE|STYLE|REGION)\b/.test(lines[0] ?? '')) continue;
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0 || at > 1) continue;
    const m = TIMING.exec(lines[at]!);
    if (!m) continue;
    const settings = parseSettings(m[9] ?? '');
    cues.push({
      start: seconds(m[1], m[2]!, m[3]!, m[4]!),
      end: seconds(m[5], m[6]!, m[7]!, m[8]!),
      text: cleanCueText(lines.slice(at + 1).join('\n')),
      ...(settings && { settings }),
    });
  }
  return finishCues(cues);
}
