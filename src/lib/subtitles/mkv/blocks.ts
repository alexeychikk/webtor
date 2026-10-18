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

const decodeFrameText = (frame: Uint8Array) =>
  utf8.decode(frame).replace(/\0+$/, '').replace(/\r\n?/g, '\n');

const isAss = (format: NonNullable<MkvSubtitleTrack['format']>) =>
  format === 'ass' || format === 'ssa';

/** Plain cue text of a decoded frame in the track's format (ASS/SSA overrides dropped). */
export function frameText(format: NonNullable<MkvSubtitleTrack['format']>, frame: Uint8Array) {
  const text = decodeFrameText(frame);
  return isAss(format) ? assTextToPlain(assBlockText(text)) : cleanCueText(text);
}

/**
 * One block → a cue on the file's own timeline, or `null` when it has no text. ASS/SSA cues carry the
 * raw block payload in `assChunk`; their `text` (the plain fallback) may be empty.
 */
export async function blockToCue(
  track: MkvSubtitleTrack,
  block: MkvBlock,
  timestampScale: number,
): Promise<SubtitleCue | null> {
  if (!track.format) return null;
  const frame = await decodeFrame(block.data, track.encodings);
  const text = frameText(track.format, frame);
  // ASS drawings (`{\p1}m 0 0 l …`) have no plain text but still render styled.
  const assChunk = isAss(track.format) ? decodeFrameText(frame) : undefined;
  if (!text && !assChunk) return null;
  const start = (block.timestamp * timestampScale) / 1e9;
  const end =
    block.duration !== null && block.duration > 0
      ? ((block.timestamp + block.duration) * timestampScale) / 1e9
      : start + DEFAULT_CUE_SECONDS;
  return assChunk === undefined ? { start, end, text } : { start, end, text, assChunk };
}
