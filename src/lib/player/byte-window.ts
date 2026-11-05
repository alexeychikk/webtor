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
  /** The read frontier then: every byte of the media at `time` lies before it. */
  byte: number;
}

export class ByteWindow {
  private samples: Sample[] = [];
  private frontier = 0;

  /** A demuxer read of `[start, end)`. */
  read(start: number, end: number) {
    if (end > this.frontier) this.frontier = end;
  }

  /** A seek restarted the pipelines: what they read before says nothing about the reads ahead. */
  restart() {
    this.frontier = 0;
  }

  /** The pipelines produced media up to element time `time` (the furthest of them). */
  produced(time: number) {
    if (!Number.isFinite(time) || this.frontier === 0) return;
    const sample = { time, byte: this.frontier };
    const i = this.samples.findIndex((s) => s.time >= time);
    if (i === -1) this.samples.push(sample);
    else if (this.samples[i]!.time === time) this.samples[i] = sample;
    else this.samples.splice(i, 0, sample);
  }

  /**
   * Bytes to keep with the playhead at element time `t`; null while nothing is known yet (keep
   * everything). The start comes from a fragment at least `KEEP_BEHIND_S` before `t`, lowered by
   * `READ_AHEAD_SLACK`; without one, nothing behind is dropped.
   */
  keep(t: number): ByteRange | null {
    if (this.frontier === 0) return null;
    const behind = t - KEEP_BEHIND_S;
    let start = 0;
    for (const s of this.samples) {
      if (s.time > behind) break;
      start = s.byte;
    }
    const end = this.frontier;
    return { start: Math.min(end, Math.max(0, start - READ_AHEAD_SLACK)), end };
  }
}
