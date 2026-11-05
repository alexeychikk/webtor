/**
 * Which bytes of the file playback still needs (docs/decisions/0012): from a little behind the
 * playhead to the furthest byte the demuxer asked for since the last seek. Everything else may be
 * dropped from the piece store and downloaded again when a seek goes back there.
 */

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

interface Sample {
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

  constructor(private readonly slack = READ_AHEAD_SLACK) {}

  /** A demuxer read of `[start, end)`. */
  read(_start: number, end: number) {
    this.cursor = end;
    if (end > this.frontier) this.frontier = end;
  }

  /** A seek restarted the pipelines: what they read before says nothing about the reads ahead. */
  restart() {
    this.frontier = 0;
    this.cursor = 0;
    this.sampled = 0;
  }

  /** The pipelines produced media up to element time `time` (the furthest of them). */
  produced(time: number) {
    if (!Number.isFinite(time) || this.cursor === 0) return;
    const sample = { time, byte: this.cursor };
    if (this.cursor > this.sampled) this.sampled = this.cursor;
    const i = this.samples.findIndex((s) => s.time >= time);
    if (i === -1) this.samples.push(sample);
    else if (this.samples[i]!.time === time) this.samples[i] = sample;
    else this.samples.splice(i, 0, sample);
  }

  /**
   * Bytes to keep with the playhead at element time `t`; null = keep everything. The start comes
   * from a fragment at least `KEEP_BEHIND_S` before `t`, lowered by the slack; the end from the
   * reads since the last seek: the furthest fragment's plus the slack (a one-off read further on,
   * like Matroska Cues at the end of the file, doesn't count), or the furthest read before any.
   */
  keep(t: number): ByteRange | null {
    const behind = t - KEEP_BEHIND_S;
    let start = 0;
    for (const s of this.samples) {
      if (s.time > behind) break;
      start = Math.max(0, s.byte - this.slack);
    }
    let end = Infinity;
    if (this.sampled) end = Math.min(this.frontier, this.sampled + this.slack);
    else if (this.frontier) end = this.frontier;
    if (start === 0 && end === Infinity) return null;
    return { start: Math.min(start, end), end };
  }
}
