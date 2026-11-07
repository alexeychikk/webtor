/**
 * Which bytes of the file playback still needs (docs/decisions/0012): from a little behind the
 * playhead to the furthest byte the demuxer asked for since the last seek. Everything else may be
 * dropped from the piece store and downloaded again when a seek goes back there.
 */

import type { LearnedPoint } from './byte-time';
import type { ByteSource } from './types';

/** Media kept behind the playhead (s), for short seeks back without a download. */
export const KEEP_BEHIND_S = 10;
/**
 * Slack (bytes) under the sampled read frontier: Mediabunny reads up to 8 MiB past what it demuxed
 * ('network' prefetch), so the frontier at a fragment can be that far past the fragment's bytes.
 */
export const READ_AHEAD_SLACK = 16 * 1024 * 1024;

export interface ByteRange {
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * Who reads: `demux` = the pipelines' demuxer (moves the frontier); `scan` = the embedded-subtitle
 * cluster scan (its reach counts in the end until the next seek); `once` = a one-off read
 * (Matroska header, font attachments), only pinned while it runs.
 */
export type ReadRole = 'demux' | 'scan' | 'once';

/** A fragment's element time with the read cursor then: its media lies before it (up to the slack). */
type Sample = LearnedPoint;

export class ByteWindow {
  private samples: Sample[] = [];
  /** The furthest read since the last seek; 0 = none. */
  private frontier = 0;
  /** End of the latest read. */
  private cursor = 0;
  /** The furthest sample of this run; 0 = none. */
  private sampled = 0;
  /** The furthest scan read since the last seek; 0 = none. */
  private scanned = 0;
  /** Counts the seeks: the samples' `run`. */
  private run = 0;
  /** The furthest demuxer read ever. */
  private reached = 0;
  /** The lowest demuxer read since the last seek; Infinity = none. */
  private floor = Infinity;
  /** Reads not finished yet: their pieces must stay, whatever the playhead. */
  private readonly pending = new Set<ByteRange>();

  constructor(private readonly slack = READ_AHEAD_SLACK) {}

  /** A read of `[start, end)` begins; call the returned function once it ended. */
  read(start: number, end: number, role: ReadRole = 'demux'): () => void {
    if (role === 'demux') {
      this.cursor = end;
      if (start < this.floor) this.floor = start;
      if (end > this.frontier) this.frontier = end;
      if (end > this.reached) this.reached = end;
    } else if (role === 'scan' && end > this.scanned) this.scanned = end;
    const range = { start, end };
    this.pending.add(range);
    return () => this.pending.delete(range);
  }

  /**
   * A seek restarted the pipelines (or they start after the header reads): what they read before
   * says nothing about where the playhead's bytes are, nor about the reads ahead.
   */
  restart() {
    this.frontier = 0;
    this.cursor = 0;
    this.sampled = 0;
    this.scanned = 0;
    this.floor = Infinity;
    this.run++;
  }

  /** The pipelines produced media up to element time `time` (the furthest of them). */
  produced(time: number) {
    if (!Number.isFinite(time) || this.cursor === 0) return;
    const sample = { time, byte: this.cursor, run: this.run };
    if (this.cursor > this.sampled) this.sampled = this.cursor;
    const i = this.samples.findIndex((s) => s.time >= time);
    if (i === -1) this.samples.push(sample);
    else if (this.samples[i]!.time === time) this.samples[i] = sample;
    else this.samples.splice(i, 0, sample);
  }

  /**
   * What the reads tell of where media times sit (the seek bar's fallback without an index, ADR
   * 0012): each fragment's start time with the read cursor then, which is past that media. With
   * `endTime`, the pipelines appended through the end: the furthest read ever holds the media up to
   * it (after a seek they may have read nothing new, the demuxer's cache had it).
   */
  points(endTime?: number): readonly LearnedPoint[] {
    if (endTime === undefined || this.reached === 0) return this.samples;
    return [...this.samples, { byte: this.reached, time: endTime, run: this.run }];
  }

  /**
   * Bytes to keep with the playhead at element time `t`; null = keep everything. The start comes
   * from a fragment of this run (since the last seek) at least `KEEP_BEHIND_S` before `t`, lowered
   * by the slack. Until this run has one, from the lowest read since the seek (the playhead's own
   * bytes, and the probes of a keyframe search), or lower where an earlier run's fragment says so:
   * an earlier run's read cursor can be far past its media, so alone it never sets the start. While
   * the keyframe search runs (no fragment yet), from 0: its probes jump around the file. The
   * end comes from the demuxer's reads since the last seek: the furthest fragment's (or the latest
   * read) plus the slack, or the furthest read before any fragment. A one-off read further on, like
   * Matroska Cues at the end of the file, doesn't count. The subtitle scan's reach since the last
   * seek does: the pipelines read those bytes soon. Reads still running are always inside:
   * WebTorrent reads a piece it has from the store with no selection left on it, and a missing
   * piece ends the stream.
   */
  keep(t: number): ByteRange | null {
    let start = this.startAt(t - KEEP_BEHIND_S);
    let end = Infinity;
    if (this.sampled)
      end = Math.min(this.frontier, Math.max(this.sampled, this.cursor) + this.slack);
    else if (this.frontier) end = this.frontier;
    end = Math.max(end, this.scanned);
    for (const r of this.pending) {
      start = Math.min(start, r.start);
      end = Math.max(end, r.end);
    }
    if (start === 0 && end === Infinity) return null;
    return { start: Math.min(start, end), end };
  }

  /** Where the bytes of element time `behind` start, at the latest (see `keep`). */
  private startAt(behind: number): number {
    let current: Sample | undefined;
    let earlier: Sample | undefined;
    for (const s of this.samples) {
      if (s.time > behind) break;
      if (s.run === this.run) current = s;
      else earlier = s;
    }
    if (current) return Math.max(0, current.byte - this.slack);
    if (!this.sampled) return 0;
    const floor = Math.max(0, this.floor - this.slack);
    return earlier ? Math.min(floor, Math.max(0, earlier.byte - this.slack)) : floor;
  }
}

/**
 * `source` with every read reported to `window` while it runs: a stream until it delivered its
 * bytes, ends or is cancelled.
 */
export function trackedSource(
  source: ByteSource,
  window: ByteWindow,
  role: ReadRole = 'demux',
): ByteSource {
  return {
    size: source.size,
    read(start, end) {
      const done = window.read(start, end, role);
      const result = source.read(start, end);
      if (!(result instanceof ReadableStream)) return result.finally(done);
      const reader = result.getReader();
      let delivered = 0;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { value, done: ended } = await reader.read();
            if (ended) {
              done();
              controller.close();
              return;
            }
            delivered += value.length;
            if (delivered >= end - start) done();
            controller.enqueue(value);
          } catch (err) {
            done();
            controller.error(err);
          }
        },
        cancel(reason) {
          done();
          return reader.cancel(reason);
        },
      });
    },
  };
}
