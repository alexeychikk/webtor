/** Seek bar data (pure, see seek.test.ts): which parts of the file are downloaded and buffered. */
import type { Ranges } from './buffer';

/** Parts of a file as fractions of its length (or duration), `[start, end)`, sorted, merged. */
export type FractionRanges = readonly (readonly [number, number])[];

/** What `downloadedRanges` reads of a torrent's piece bitfield (WebTorrent's `torrent.bitfield`). */
export interface PieceBitfield {
  get(index: number): boolean;
}

/**
 * The downloaded (verified) pieces of one file of a torrent, as fractions of the file's bytes.
 * Pieces span file boundaries, so the first and last piece are cut to the file.
 */
export function downloadedRanges(
  bitfield: PieceBitfield,
  pieceLength: number,
  fileOffset: number,
  fileLength: number,
): FractionRanges {
  if (!(pieceLength > 0) || !(fileLength > 0)) return [];
  const fileEnd = fileOffset + fileLength;
  const first = Math.floor(fileOffset / pieceLength);
  const last = Math.floor((fileEnd - 1) / pieceLength);
  const out: [number, number][] = [];
  for (let i = first; i <= last; i++) {
    if (!bitfield.get(i)) continue;
    const start = (Math.max(i * pieceLength, fileOffset) - fileOffset) / fileLength;
    const end = (Math.min((i + 1) * pieceLength, fileEnd) - fileOffset) / fileLength;
    const prev = out[out.length - 1];
    if (prev && prev[1] >= start) prev[1] = end;
    else out.push([start, end]);
  }
  return out;
}

/** `TimeRanges` (e.g. `video.buffered`) as fractions of `duration`; empty while it is unknown. */
export function timeFractions(ranges: Ranges, duration: number): FractionRanges {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const clamp = (t: number) => Math.min(1, Math.max(0, t / duration));
  const out: [number, number][] = [];
  for (let i = 0; i < ranges.length; i++) {
    const start = clamp(ranges.start(i));
    const end = clamp(ranges.end(i));
    if (end > start) out.push([start, end]);
  }
  return out;
}

/** Same ranges? Lets the controller skip a state update (and a seek bar redraw) every tick. */
export function sameRanges(a: FractionRanges, b: FractionRanges): boolean {
  return a.length === b.length && a.every((r, i) => r[0] === b[i]![0] && r[1] === b[i]![1]);
}

/** Pointer x over the seek bar → fraction of its width, clamped to [0, 1]. */
export function pointerFraction(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width));
}
