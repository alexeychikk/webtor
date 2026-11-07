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

interface Sample extends LearnedPoint {
  /** Element time of a fragment the pipelines produced. */
  time: number;
  /** Where the reads were then: the media at `time` lies before it (up to the read slack). */
  byte: number;
}

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
  /** Reads not finished yet: their pieces must stay, whatever the playhead. */
  private readonly pending = new Set<ByteRange>();

  constructor(private readonly slack = READ_AHEAD_SLACK) {}

  /** A read of `[start, end)` begins; call the returned function once it ended. */
  read(start: number, end: number, role: ReadRole = 'demux'): () => void {
    if (role === 'demux') {
      this.cursor = end;
      if (end > this.frontier) this.frontier = end;
      if (end > this.reached) this.reached = end;
    } else if (role === 'scan' && end > this.scanned) this.scanned = end;
    const range = { start, end };
    this.pending.add(range);
    return () => this.pending.delete(range);
  }

  /** A seek restarted the pipelines: what they read before says nothing about the reads ahead. */
  restart() {
    this.frontier = 0;
    this.cursor = 0;
    this.sampled = 0;
    this.scanned = 0;
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
   * from a fragment at least `KEEP_BEHIND_S` before `t`, lowered by the slack. The end comes from
   * the demuxer's reads since the last seek: the furthest fragment's (or the latest read) plus the
   * slack, or the furthest read before any fragment. A one-off read further on, like Matroska Cues
   * at the end of the file, doesn't count. The subtitle scan's reach since the last seek does: the
   * pipelines read those bytes soon. Reads still running are always inside: WebTorrent reads a
   * piece it has from the store with no selection left on it, and a missing piece ends the stream.
   */
  keep(t: number): ByteRange | null {
    const behind = t - KEEP_BEHIND_S;
    let start = 0;
    for (const s of this.samples) {
      if (s.time > behind) break;
      start = Math.max(0, s.byte - this.slack);
    }
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
