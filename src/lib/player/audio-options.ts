import { channelsLabel, codecLabel } from './codecs';
import type { AudioTrackInfo } from './types';

/** First line of an audio menu option: `Russian AC3 · rus` (the language left out when unknown). */
export function audioTrackTitle(t: AudioTrackInfo): string {
  const parts = [t.label];
  if (t.language !== 'und' && t.language !== t.label) parts.push(t.language);
  return parts.join(' · ');
}

/** Second line: `AC-3 5.1 → Opus`, or `Unavailable: <reason>`. */
export function audioTrackDetail(t: AudioTrackInfo): string {
  if (t.playback === 'unsupported') return `Unavailable: ${t.reason ?? 'not supported'}`;
  let text = [codecLabel(t.codec), channelsLabel(t.channels)].filter(Boolean).join(' ');
  if (t.playback === 'transcode') text += ` → ${codecLabel(t.outputCodec)}`;
  return text;
}

/** Accessible name of an option: `Russian AC3 · rus · AC-3 5.1 → Opus`, or `… — unavailable: …`. */
export function audioOptionText(t: AudioTrackInfo): string {
  const parts = [audioTrackTitle(t)];
  parts.push([codecLabel(t.codec), channelsLabel(t.channels)].filter(Boolean).join(' '));
  let text = parts.join(' · ');
  if (t.playback === 'transcode') text += ` → ${codecLabel(t.outputCodec)}`;
  if (t.playback === 'unsupported') text += ` — unavailable: ${t.reason ?? 'not supported'}`;
  return text;
}
