/**
 * The seek bar's downloaded layer on its time axis (docs/decisions/0012 "Seek bar"): piece byte
 * ranges of the playing file → element time, through points where the file says which media time
 * sits at which byte. Pure; see byte-time.test.ts.
 */
import type { ByteRange } from './byte-window';
import type { FractionRanges } from './seek';

/** Media at element time `time` (s) starts at file offset `byte`. */
export interface ByteTimePoint {
  byte: number;
  time: number;
}

/**
 * Known positions of media times in the file. The file starts at time 0 (byte 0 = time 0). `whole`:
 * they come from the container's whole index (MKV Cues, a complete AVI index), so the bytes after
 * the last point run on to the end of the media (`mediaEnd`, else the file's length = the
 * duration). Otherwise (points learned from the reads, an index still growing) the bytes after the
 * last point can't be placed: the layer leaves them out rather than guess.
 */
export interface ByteTimeIndex {
  points: readonly ByteTimePoint[];
  whole: boolean;
  /** Where the media ends when an index or tags follow it (MKV Cues at the end). */
  mediaEnd?: number;
}

/**
 * The points in time order, with bytes rising: a point whose byte doesn't come after the previous
 * one's (a read ahead that overshot, a damaged index) is dropped.
 */
export function monotonePoints(points: readonly ByteTimePoint[]): ByteTimePoint[] {
  const sorted = points
    .filter((p) => Number.isFinite(p.byte) && Number.isFinite(p.time))
    .sort((a, b) => a.time - b.time || a.byte - b.byte);
  const out: ByteTimePoint[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (!last || p.byte > last.byte) out.push(p);
  }
  return out;
}

/** A point learned from the reads (`ByteWindow.points`): the media up to `time` lies before `byte`. */
export interface LearnedPoint extends ByteTimePoint {
  /** The pipelines' run it was learned in: a seek starts a new one. */
  run: number;
}

/**
 * One run's points in time order with bytes rising. Once Mediabunny's cache holds the data the read
 * cursor stops while the times go on: of the samples at one byte the latest says the most (all
 * that media lies before it), unlike an index, where the earliest time starts at the byte
 * (`monotonePoints`). A later sample at a smaller byte (a pipeline reading behind another) is
 * dropped.
 */
function runPoints(samples: readonly ByteTimePoint[]): ByteTimePoint[] {
  const sorted = samples
    .filter((p) => Number.isFinite(p.byte) && Number.isFinite(p.time))
    .sort((a, b) => a.time - b.time || a.byte - b.byte);
  const out: ByteTimePoint[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (!last || p.byte > last.byte) out.push(p);
    else if (p.byte === last.byte) out[out.length - 1] = p;
  }
  return out;
}

/**
 * Points learned from the reads for `ByteTimeIndex.points`: times and bytes both rising. Each run's
 * points are reduced by `runPoints`; where runs disagree (a seek back read the same media with
 * another overshoot) the newest run's points win and an older one's that don't fit between them
 * are left out.
 */
export function learnedPoints(samples: readonly LearnedPoint[]): ByteTimePoint[] {
  const byRun = new Map<number, LearnedPoint[]>();
  for (const s of samples) {
    const group = byRun.get(s.run);
    if (group) group.push(s);
    else byRun.set(s.run, [s]);
  }
  const newestFirst = [...byRun.keys()].sort((a, b) => b - a);
  let out: ByteTimePoint[] = [];
  for (const run of newestFirst) out = mergeOlderRun(out, runPoints(byRun.get(run)!));
  return out;
}

/**
 * `kept` (newer runs' points) with the points of an older run that fit between them, in one pass
 * over both (each in time order).
 */
function mergeOlderRun(
  kept: readonly ByteTimePoint[],
  older: readonly ByteTimePoint[],
): ByteTimePoint[] {
  const out: ByteTimePoint[] = [];
  let i = 0;
  for (const p of older) {
    while (i < kept.length && kept[i]!.time < p.time) out.push(kept[i++]!);
    const prev = out[out.length - 1];
    const next = kept[i];
    if (next && !(next.time > p.time && next.byte > p.byte)) continue;
    if (prev && !(prev.byte < p.byte)) continue;
    out.push({ byte: p.byte, time: p.time });
  }
  while (i < kept.length) out.push(kept[i++]!);
  return out;
}

/** The points `timeAtByte` interpolates between, times clamped to `[0, duration]`. */
export function mappingPoints(
  index: ByteTimeIndex,
  fileLength: number,
  duration: number,
): ByteTimePoint[] {
  const clamp = (t: number) => Math.min(duration, Math.max(0, t));
  const points = monotonePoints(index.points)
    .filter((p) => p.byte >= 0 && p.byte <= fileLength)
    .map((p) => ({ byte: p.byte, time: clamp(p.time) }));
  if (points.length === 0) return points;
  if (points[0]!.byte > 0) points.unshift({ byte: 0, time: 0 });
  const last = points[points.length - 1]!;
  const end = Math.min(fileLength, index.mediaEnd ?? fileLength);
  if (index.whole && last.byte < end) points.push({ byte: end, time: duration });
  return points;
}

/**
 * Element time at file offset `byte`: linear between the two points around it, the first or last
 * point's time outside them. `points` from `mappingPoints` (at least one).
 */
export function timeAtByte(points: readonly ByteTimePoint[], byte: number): number {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (byte <= first.byte) return first.time;
  if (byte >= last.byte) return last.time;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.byte <= byte) lo = mid;
    else hi = mid;
  }
  const a = points[lo]!;
  const b = points[hi]!;
  return a.time + ((byte - a.byte) / (b.byte - a.byte)) * (b.time - a.time);
}

/**
 * Downloaded byte ranges of the file (`[start, end)`, sorted) as fractions of the duration, for the
 * seek bar: each range at the times its bytes hold. Empty without a duration or a point (nothing
 * can be placed). Ranges that meet after the mapping are merged; ranges that
 * map to nothing (past a partial index) are left out.
 */
export function downloadedTimes(
  bytes: readonly ByteRange[],
  index: ByteTimeIndex | null,
  fileLength: number,
  duration: number,
): FractionRanges {
  if (!index || !Number.isFinite(duration) || duration <= 0 || !(fileLength > 0)) return [];
  const points = mappingPoints(index, fileLength, duration);
  if (points.length < 2) return [];
  const out: [number, number][] = [];
  for (const r of bytes) {
    const start = timeAtByte(points, r.start) / duration;
    const end = timeAtByte(points, r.end) / duration;
    if (!(end > start)) continue;
    const prev = out[out.length - 1];
    if (prev && prev[1] >= start) prev[1] = Math.max(prev[1], end);
    else out.push([start, end]);
  }
  return out;
}
