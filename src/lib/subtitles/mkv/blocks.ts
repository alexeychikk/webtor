/** Subtitle block payloads → cues (docs/decisions/0004). */
import { assTextToPlain } from '../ass';
import { cleanCueText, type SubtitleCue } from '../cue';
import type { MkvBlock } from './cluster';
import type { ContentEncoding, MkvSubtitleTrack } from './header';

/** Shown this long when a block has no `BlockDuration` (seconds). */
export const DEFAULT_CUE_SECONDS = 4;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Undoes a track's `ContentEncodings` (zlib, header stripping). */
export async function decodeFrame(
  data: Uint8Array,
  encodings: readonly ContentEncoding[],
): Promise<Uint8Array> {
  let out = data;
  for (const enc of encodings) {
    if (enc.kind === 'zlib') out = await inflate(out);
    else {
      const joined = new Uint8Array(enc.bytes.length + out.length);
      joined.set(enc.bytes);
      joined.set(out, enc.bytes.length);
      out = joined;
    }
  }
  return out;
}

/**
 * Matroska ASS/SSA block: `ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text`. Returns
 * the Text field (it may itself contain commas).
 */
export function assBlockText(payload: string): string {
  let pos = 0;
  for (let i = 0; i < 8; i++) {
    const comma = payload.indexOf(',', pos);
    if (comma < 0) return payload;
    pos = comma + 1;
  }
  return payload.slice(pos);
}

const utf8 = new TextDecoder('utf-8');

/** Cue text of a decoded frame in the track's format (plain text for ASS/SSA for now). */
export function frameText(format: NonNullable<MkvSubtitleTrack['format']>, frame: Uint8Array) {
  const text = utf8.decode(frame).replace(/\0+$/, '').replace(/\r\n?/g, '\n');
  return format === 'ass' || format === 'ssa'
    ? assTextToPlain(assBlockText(text))
    : cleanCueText(text);
}

/** One block → a cue on the file's own timeline, or `null` when it has no text. */
export async function blockToCue(
  track: MkvSubtitleTrack,
  block: MkvBlock,
  timestampScale: number,
): Promise<SubtitleCue | null> {
  if (!track.format) return null;
  const text = frameText(track.format, await decodeFrame(block.data, track.encodings));
  if (!text) return null;
  const start = (block.timestamp * timestampScale) / 1e9;
  const end =
    block.duration !== null && block.duration > 0
      ? ((block.timestamp + block.duration) * timestampScale) / 1e9
      : start + DEFAULT_CUE_SECONDS;
  return { start, end, text };
}
