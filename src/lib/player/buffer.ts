/** Buffer arithmetic over `TimeRanges`-like lists (pure, see buffer.test.ts). */
export interface Ranges {
  readonly length: number;
  start(i: number): number;
  end(i: number): number;
}

/** Keep about this much media appended ahead of the playhead (back-pressure threshold). */
export const BUFFER_AHEAD_S = 60;
/** Evict media further than this behind the playhead. */
export const KEEP_BEHIND_S = 30;
/** Ranges closer than this count as contiguous (frame/fragment boundaries leave tiny gaps). */
const GAP_TOLERANCE_S = 0.3;

/** Seconds of contiguous media from `t` onwards (0 if `t` is not buffered). */
export function bufferedAhead(ranges: Ranges, t: number): number {
  let end = -1;
  for (let i = 0; i < ranges.length; i++) {
    const s = ranges.start(i);
    const e = ranges.end(i);
    if (end < 0 && s <= t + GAP_TOLERANCE_S && e > t) end = e;
    else if (end >= 0 && s <= end + GAP_TOLERANCE_S) end = Math.max(end, e);
  }
  return end < 0 ? 0 : end - t;
}

/** True if `t` lies inside a buffered range (with a little slack at the start). */
export function isBuffered(ranges: Ranges, t: number): boolean {
  return bufferedAhead(ranges, t) > GAP_TOLERANCE_S;
}

/** The range to `remove()` to drop media far behind the playhead, or null if there is none. */
export function evictionRange(
  ranges: Ranges,
  t: number,
  keepBehind = KEEP_BEHIND_S,
): [number, number] | null {
  if (ranges.length === 0) return null;
  const cut = t - keepBehind;
  const first = ranges.start(0);
  return cut > first + 1 ? [first, cut] : null;
}

/** Builds a `Ranges` from [start, end] pairs (tests, and snapshots of SourceBuffer.buffered). */
export function toRanges(pairs: readonly (readonly [number, number])[]): Ranges {
  return {
    length: pairs.length,
    start: (i) => pairs[i]![0],
    end: (i) => pairs[i]![1],
  };
}

/** Largest hole in front of a stuck playhead that we skip over instead of waiting forever. */
export const MAX_GAP_JUMP_S = 1;

/**
 * Where to move a playhead that sits in a small unbuffered gap (e.g. audio starting a few frames
 * after video, or a hole between fragments), or null if `t` is buffered or the next range is far.
 */
export function gapJumpTarget(ranges: Ranges, t: number, maxGap = MAX_GAP_JUMP_S): number | null {
  // Strict containment: the browser stalls in a hole however small (unlike `isBuffered`).
  for (let i = 0; i < ranges.length; i++) {
    const s = ranges.start(i);
    if (s <= t && t < ranges.end(i)) return null;
    if (s > t) return s - t <= maxGap ? s : null;
  }
  return null;
}
