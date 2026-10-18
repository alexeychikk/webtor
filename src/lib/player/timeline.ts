/**
 * Maps between the file's own timestamps ("source time") and the media element's timeline, which
 * always starts at 0. Files whose first video timestamp is above 0 (MPEG-TS starts near 1.4 s, MP4
 * edit lists, cut MKVs) would otherwise leave a gap at `[0, startTime)` that the browser waits on
 * forever. Pure, see timeline.test.ts.
 */
export interface Timeline {
  /** First video timestamp in source time (clamped to ≥ 0). */
  readonly startTime: number;
}

export function timeline(firstTimestamp: number): Timeline {
  return { startTime: Number.isFinite(firstTimestamp) ? Math.max(0, firstTimestamp) : 0 };
}

/** Element time → source time (e.g. a seek target, for the keyframe lookup). */
export function toSourceTime(tl: Timeline, elementTime: number): number {
  return elementTime + tl.startTime;
}

/**
 * `SourceBuffer.timestampOffset` for a Conversion trimmed to start at source time `k`: its output
 * starts at 0, and belongs at element time `k - startTime`.
 */
export function appendOffset(tl: Timeline, k: number): number {
  return Math.max(0, k - tl.startTime);
}

/** Restart point (source time) for a seek: the keyframe before it, never before the first frame. */
export function restartPoint(tl: Timeline, keyframeTimestamp: number | null | undefined): number {
  return Math.max(tl.startTime, keyframeTimestamp ?? tl.startTime);
}

/** `MediaSource.duration` for a file ending at source time `end`; NaN if unknown. */
export function elementDuration(tl: Timeline, end: number): number {
  return Number.isFinite(end) && end > tl.startTime ? end - tl.startTime : NaN;
}
