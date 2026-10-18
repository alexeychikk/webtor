import { cleanCueText, finishCues, type SubtitleCue } from './cue';

// H:MM:SS.cc
const TIME = /^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})$/;

function seconds(value: string): number | null {
  const m = TIME.exec(value.trim());
  if (!m) return null;
  const frac = m[4]!.length === 2 ? Number(m[4]) / 100 : Number(m[4]!.padEnd(3, '0')) / 1000;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

/** ASS dialogue text → plain text: drops `{\…}` overrides, `\N`/`\n` → line break, `\h` → space. */
export function assTextToPlain(text: string): string {
  return cleanCueText(
    text
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, '\u00A0'),
  );
}

/**
 * ASS/SSA `[Events]` → plain-text cues (styles and positioning are dropped). The styled renderer
 * (JASSUB) reads the file itself; this is the text fallback.
 */
export function parseAssAsText(input: string): SubtitleCue[] {
  const lines = input.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  let inEvents = false;
  let format = [
    'layer',
    'start',
    'end',
    'style',
    'name',
    'marginl',
    'marginr',
    'marginv',
    'effect',
    'text',
  ];
  const cues: SubtitleCue[] = [];
  for (const line of lines) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line);
    if (section) {
      inEvents = section[1]!.toLowerCase() === 'events';
      continue;
    }
    if (!inEvents) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1);
    if (key === 'format') {
      format = value.split(',').map((f) => f.trim().toLowerCase());
    } else if (key === 'dialogue') {
      // Text is the last field and may itself contain commas.
      const fields = value.split(',');
      const head = fields.slice(0, format.length - 1);
      const field = (name: string) => {
        const i = format.indexOf(name);
        return i < 0 ? undefined : i === format.length - 1 ? fields.slice(i).join(',') : head[i];
      };
      const start = seconds(field('start') ?? '');
      const end = seconds(field('end') ?? '');
      if (start === null || end === null) continue;
      cues.push({ start, end, text: assTextToPlain(field('text') ?? '') });
    }
  }
  return finishCues(cues);
}
