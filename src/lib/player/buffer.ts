/** Buffer arithmetic over `TimeRanges`-like lists (pure, see buffer.test.ts). */
export interface Ranges {
  readonly length: number;
  start(i: number): number;
  end(i: number): number;
}

/** Element-time duration of everything in `ranges`. */
export function totalBuffered(ranges: Ranges): number {
  let s = 0;
  for (let i = 0; i < ranges.length; i++) s += ranges.end(i) - ranges.start(i);
  return s;
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

/**
 * Seconds from `t` to the end of the media at the playhead, also when the playhead sits in a small
 * hole just before it (up to `gap`: the player jumps those, see `gapJumpTarget`). E.g. a first frame
 * at 0.6 s, or audio that starts a few frames after the video. `bufferedAhead` reads 0 there.
 */
export function aheadOf(ranges: Ranges, t: number, gap = MAX_GAP_JUMP_S): number {
  for (let i = 0; i < ranges.length; i++) {
    const s = ranges.start(i);
    if (ranges.end(i) <= t) continue;
    if (s > t + gap) return 0;
    const from = Math.max(s, t);
    return from - t + bufferedAhead(ranges, from);
  }
  return 0;
}

/** True if `t` lies inside a buffered range (with a little slack at the start). */
export function isBuffered(ranges: Ranges, t: number): boolean {
  return bufferedAhead(ranges, t) > GAP_TOLERANCE_S;
}

/** A SourceBuffer's last frame may end this far before the element's duration (audio vs video). */
export const END_SLACK_S = 0.5;

/**
 * True if `ranges` holds the media from `t` to the end at `end` (the element's duration): `t` lies in
 * the last range, at its very end or past it, and that range reaches the end. Whether a seek there
 * needs a restart, when the pipeline already appended through the end of the file (`isBuffered`
 * reads false in the last `GAP_TOLERANCE_S` of the media).
 */
export function bufferedToEnd(
  ranges: Ranges,
  t: number,
  end: number,
  slack = END_SLACK_S,
): boolean {
  const n = ranges.length;
  if (n === 0 || !Number.isFinite(end)) return false;
  return ranges.end(n - 1) >= end - slack && t >= ranges.start(n - 1) - GAP_TOLERANCE_S;
}

/** How close (s) to the end of the media a seek target goes back a little (`endSnap`). */
export const END_SNAP_S = 0.25;

/**
 * Where a seek to `t` goes instead when it lies in the last `margin` before the end of the media
 * but before `duration` (`end − margin`: the last moment plays, then the video ends), else null.
 * The end of the media is `mediaEnd` (where the last video frame ends, once known) or `duration`,
 * whichever is first. WebKit's GStreamer backend fails a seek past the last video frame's start
 * on an ended MediaSource: it drops every frame as before the new segment, then errors at the EOS
 * ("No valid frames decoded before end of stream"). A seek to `duration` (or past it) just ends
 * the video, so it stays.
 */
export function endSnap(
  t: number,
  duration: number,
  mediaEnd = duration,
  margin = END_SNAP_S,
): number | null {
  if (!Number.isFinite(duration)) return null;
  const end = Math.min(duration, Number.isFinite(mediaEnd) ? mediaEnd : duration);
  const edge = end - margin;
  return edge > 0 && t > edge + 0.001 && t < duration - 0.001 ? edge : null;
}

/**
 * How close (s) the playhead must be to the end of the buffered media before a MediaSource whose
 * appends are all done gets `endOfStream()` on a stall or a seek there (`atBufferedEnd`).
 */
export const EOS_LEAD_S = GAP_TOLERANCE_S;

/**
 * While playing, `endOfStream()` comes this much media (s) before the end of the buffered media
 * (`endOfStreamIn`), so the element never stalls there first. Ended on that stall, WebKit's
 * GStreamer backend resumes its pipeline asynchronously; a short tail (e.g. 76 ms of audio past the
 * last video frame) can end the element before the pipeline reports "playing", and WebKit then
 * replays from 0 (`mediaPlayerPlaybackStateChanged` → `playInternal` on an ended element).
 * Not earlier: a seek after the EOS reached GStreamer's decoder fails (see CLAUDE.md).
 */
export const EOS_AHEAD_S = 0.1;

/** Within this much media (s) of the end, `timeupdate` (~250 ms apart) arms the end-of-stream timer. */
export const EOS_ARM_S = 0.6;

/** The end of what every SourceBuffer holds (the earliest of their last range ends); NaN if one is empty. */
function commonEnd(all: readonly Ranges[]): number {
  let end = Infinity;
  for (const r of all) {
    if (r.length === 0) return NaN;
    end = Math.min(end, r.end(r.length - 1));
  }
  return Number.isFinite(end) ? end : NaN;
}

/**
 * True once `t` is within `lead` of the end of what every SourceBuffer holds (the earliest of their
 * last range ends): playback can't go further, so the MediaSource may end now.
 */
export function atBufferedEnd(all: readonly Ranges[], t: number, lead = EOS_LEAD_S): boolean {
  const end = commonEnd(all);
  return Number.isFinite(end) && t >= end - lead;
}

/**
 * Wall-clock seconds until `endOfStream()` while playing at `rate` from `t`: 0 once within `ahead`
 * of the end of the buffered media (`commonEnd`), null while it is further than `arm` away (or
 * nothing is buffered, or the rate isn't forwards).
 */
export function endOfStreamIn(
  all: readonly Ranges[],
  t: number,
  rate: number,
  ahead = EOS_AHEAD_S,
  arm = EOS_ARM_S,
): number | null {
  const end = commonEnd(all);
  if (!Number.isFinite(end) || !(rate > 0)) return null;
  const left = end - t;
  if (left > arm) return null;
  return Math.max(0, (left - ahead) / rate);
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

/** Under quota, keep only this much behind the playhead (small backward seeks stay instant). */
export const QUOTA_KEEP_BEHIND_S = 1;

/**
 * The range to `remove()` when the SourceBuffer is full: all but `keepBehind` s behind the
 * playhead. `safeCut` moves the end back to a random-access point: MSE removes up to the next one
 * after `end`, which must not be past the playhead (that would empty the GOP being played).
 */
export function quotaEvictionRange(
  ranges: Ranges,
  t: number,
  safeCut: (cut: number) => number = (cut) => cut,
  keepBehind = QUOTA_KEEP_BEHIND_S,
): [number, number] | null {
  if (ranges.length === 0) return null;
  const first = ranges.start(0);
  const cut = Math.min(safeCut(t - keepBehind), t - keepBehind);
  return cut > first + 0.1 ? [first, cut] : null;
}

/**
 * Under quota, everything that can go: `quotaEvictionRange` behind the playhead, plus any range
 * that starts past the media at the playhead (`aheadOf`): what an earlier seek, a UA eviction or a
 * hole left there. The running pipeline appends in order from the playhead, so it would append that
 * media again anyway. Until then it only takes up quota. A starved pipeline passes a negative
 * `keepBehind`: when the quota is smaller than about two fragments, the one just played must go too.
 */
export function quotaEvictionRanges(
  ranges: Ranges,
  t: number,
  safeCut: (cut: number) => number = (cut) => cut,
  keepBehind = QUOTA_KEEP_BEHIND_S,
): [number, number][] {
  const out: [number, number][] = [];
  const behind = quotaEvictionRange(ranges, t, safeCut, keepBehind);
  if (behind) out.push(behind);
  const end = t + aheadOf(ranges, t);
  for (let i = 0; i < ranges.length; i++) {
    const s = ranges.start(i);
    if (s > end + GAP_TOLERANCE_S && s > t + MAX_GAP_JUMP_S) {
      out.push([s, Infinity]);
      break;
    }
  }
  return out;
}

/** The last of the ascending `points` at or before `t`, or -Infinity. */
export function lastAtOrBefore(points: readonly number[], t: number): number {
  let best = -Infinity;
  for (const p of points) {
    if (p > t) break;
    best = p;
  }
  return best;
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
