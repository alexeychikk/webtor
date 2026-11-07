import { readFileSync } from 'node:fs';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import type { ByteTimePoint } from '../../src/lib/player/byte-time';
import { mp4TrackIndex } from '../../src/lib/player/mp4-index';

const TS_PACKET = 188;
const PTS_HZ = 90_000;

/**
 * Every video PES of an MPEG-TS file with its PTS (s), at the offset of the TS packet it starts in,
 * in file order. A plain scan of the stream, independent of Mediabunny.
 */
export function tsVideoPes(bytes: Uint8Array): ByteTimePoint[] {
  const out: ByteTimePoint[] = [];
  let at = bytes.indexOf(0x47);
  for (; at >= 0 && at + TS_PACKET <= bytes.length; at += TS_PACKET) {
    if (bytes[at] !== 0x47) break;
    const unitStart = (bytes[at + 1]! & 0x40) !== 0;
    const adaptation = (bytes[at + 3]! >> 4) & 0x3;
    if (!unitStart || !(adaptation & 0x1)) continue;
    const p = at + 4 + (adaptation & 0x2 ? 1 + bytes[at + 4]! : 0);
    const isVideoPes =
      bytes[p] === 0 && bytes[p + 1] === 0 && bytes[p + 2] === 1 && (bytes[p + 3]! & 0xf0) === 0xe0;
    if (!isVideoPes || !(bytes[p + 7]! & 0x80)) continue;
    const b = bytes.subarray(p + 9, p + 14);
    const pts =
      (b[0]! & 0x0e) * 2 ** 29 +
      b[1]! * 2 ** 22 +
      (b[2]! >> 1) * 2 ** 15 +
      b[3]! * 2 ** 7 +
      (b[4]! >> 1);
    out.push({ byte: at, time: pts / PTS_HZ });
  }
  return out;
}

/**
 * Where each video frame of a fixture starts, element times (0 = the first frame), in file order:
 * the PES scan for MPEG-TS, every sample of the sample table for MP4.
 */
export async function frameBytes(path: string): Promise<ByteTimePoint[]> {
  const bytes = readFileSync(path);
  let frames: ByteTimePoint[];
  if (path.endsWith('.ts')) frames = tsVideoPes(bytes);
  else {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
    frames = [...mp4TrackIndex((await input.getPrimaryVideoTrack())!, true)!.points];
  }
  const start = Math.min(...frames.map((f) => f.time));
  return frames
    .map((f) => ({ byte: f.byte, time: f.time - start }))
    .sort((a, b) => a.byte - b.byte);
}

/**
 * The element time the media at file offset `byte` starts at: the earliest frame among the first
 * frames starting at or after it (B-frames: a few frames on, in decode order), the end past the last.
 */
export function trueTimeAt(frames: readonly ByteTimePoint[], byte: number, end: number): number {
  const i = frames.findIndex((f) => f.byte >= byte);
  if (i === -1) return end;
  return Math.min(...frames.slice(i, i + 4).map((f) => f.time));
}
