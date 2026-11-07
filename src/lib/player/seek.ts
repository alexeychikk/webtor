/** Seek bar data (pure, see seek.test.ts): which parts of the file are downloaded and buffered. */
import { END_SNAP_S, type Ranges } from './buffer';
import type { ByteRange } from './byte-window';

/** Parts of a file as fractions of its length (or duration), `[start, end)`, sorted, merged. */
export type FractionRanges = readonly (readonly [number, number])[];

/** What `downloadedBytes` reads of a torrent's piece bitfield (WebTorrent's `torrent.bitfield`). */
export interface PieceBitfield {
  get(index: number): boolean;
}

/**
 * The downloaded (verified) pieces of one file of a torrent, as byte ranges of the file
 * (`[start, end)`, sorted, merged). Pieces span file boundaries, so the first and last piece are cut
 * to the file. The seek bar places them in time with `downloadedTimes` (byte-time.ts).
 */
export function downloadedBytes(
  bitfield: PieceBitfield,
  pieceLength: number,
  fileOffset: number,
  fileLength: number,
): ByteRange[] {
  if (!(pieceLength > 0) || !(fileLength > 0)) return [];
  const fileEnd = fileOffset + fileLength;
  const first = Math.floor(fileOffset / pieceLength);
  const last = Math.floor((fileEnd - 1) / pieceLength);
  const out: ByteRange[] = [];
  for (let i = first; i <= last; i++) {
    if (!bitfield.get(i)) continue;
    const start = Math.max(i * pieceLength, fileOffset) - fileOffset;
    const end = Math.min((i + 1) * pieceLength, fileEnd) - fileOffset;
    const prev = out[out.length - 1];
    if (prev && prev.end >= start) prev.end = end;
    else out.push({ start, end });
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

/**
 * A seek to the end (its last `END_SNAP_S`) while the video is there already: ended, in its last
 * moment, or seeking there. Our controls skip it (`seekVideo`): there is nothing to show, and
 * WebKit's GStreamer backend fails a seek made at the end of an ended MediaSource (CLAUDE.md).
 */
export function endSeekRedundant(
  current: number,
  target: number,
  duration: number,
  ended: boolean,
): boolean {
  if (!Number.isFinite(duration) || duration <= 0) return false;
  const edge = duration - END_SNAP_S;
  return target >= edge && (ended || current >= edge);
}

/**
 * Seeks `video` to `t` for our controls (seek bar, keys, double-tap), unless `endSeekRedundant`.
 * False when it skipped the seek (no `seeked` follows).
 */
export function seekVideo(video: HTMLVideoElement, t: number): boolean {
  if (endSeekRedundant(video.currentTime, t, video.duration, video.ended)) return false;
  video.currentTime = t;
  return true;
}

/**
 * Where a `currentTime` write goes: `t` within [0, duration], as the element clamps it. Read from
 * the write, not back from the element: a WebKit element failing to decode reads 0 there.
 */
export function seekTarget(t: number, duration: number): number {
  const end = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return Math.min(Math.max(0, t), end);
}

/** Where a reopen starts: null = from the beginning, near it (a seek is what got stuck there). */
export function reopenAt(t: number): number | null {
  return t > 1 ? t : null;
}

/**
 * While a file opens again (`reopenFile`), `video.currentTime` reads and writes `reopen.at`, so a
 * seek in that time (a key of a streak) moves where it reopens instead of being lost. Release it
 * once the new player reads where to start; it leaves an accessor that replaced it alone.
 */
export function seekWhileReopening(
  video: HTMLVideoElement,
  reopen: { at: number | null },
): () => void {
  const time: PropertyDescriptor = {
    configurable: true,
    enumerable: true,
    get: () => reopen.at ?? 0,
    set: (t: number) => {
      if (Number.isFinite(t)) reopen.at = reopenAt(Math.max(0, t));
    },
  };
  Object.defineProperty(video, 'currentTime', time);
  return () => {
    const now = Object.getOwnPropertyDescriptor(video, 'currentTime');
    if (!now || now.get !== time.get || now.set !== time.set) return;
    Reflect.deleteProperty(video, 'currentTime');
  };
}
