/**
 * Embedded subtitle scan (docs/decisions/0004): from the Cluster holding a time (found via Cues),
 * reads Clusters forward until one starts past the target, turning subtitle blocks into cues.
 * Clusters already read are remembered, so scanning a range again (seeking back) costs no reads.
 */
import type { ByteSource } from '../../player/types';
import type { SubtitleCue } from '../cue';
import { blockToCue } from './blocks';
import { readCluster, type MkvBlock } from './cluster';
import { ID } from './ebml';
import { readCuePoints, type CuePoint, type MkvHeader } from './header';
import { ByteReader } from './reader';

/** Read-ahead window of cluster reads: video frames between subtitle blocks are skipped inside it. */
const CLUSTER_WINDOW = 512 * 1024;

interface ScannedCluster {
  /** Seconds. */
  time: number;
  end: number;
}

export type CueSink = (trackNumber: number, cues: SubtitleCue[]) => void;

export class ClusterScanner {
  private readonly scanned = new Map<number, ScannedCluster>();
  private cuePoints: Promise<CuePoint[]> | null = null;
  /** Per track: `start|text` (ASS: `start|chunk`) of every cue emitted, so overlapping scans don't duplicate. */
  private readonly emitted = new Map<number, Set<string>>();
  private readonly tracks;

  constructor(
    private readonly source: ByteSource,
    private readonly header: MkvHeader,
    private readonly sink: CueSink,
  ) {
    this.tracks = new Map(header.subtitleTracks.filter((t) => t.format).map((t) => [t.number, t]));
  }

  private seconds(units: number) {
    return (units * this.header.timestampScale) / 1e9;
  }

  /** File offset of the Cluster to start from for `time` (seconds, source timeline). */
  private async clusterAt(time: number, signal?: AbortSignal): Promise<number | null> {
    this.cuePoints ??= readCuePoints(new ByteReader(this.source, 0, signal), this.header).catch(
      (err: unknown) => {
        this.cuePoints = null;
        throw err;
      },
    );
    const points = await this.cuePoints;
    let pick: number | null = this.header.firstCluster;
    for (const p of points) {
      if (p.time > time) break;
      pick = p.cluster;
    }
    return pick;
  }

  /**
   * Scans the Clusters covering `[from, until]` (seconds). Returns the time up to which the file is
   * covered: the start of the first Cluster past `until`, or `Infinity` at the end of the file.
   * Throws an `AbortError` when `signal` aborts.
   */
  async scan(from: number, until: number, signal?: AbortSignal): Promise<number> {
    let pos = await this.clusterAt(from, signal);
    if (pos === null) return Infinity;
    const reader = new ByteReader(this.source, CLUSTER_WINDOW, signal);
    const wanted = new Set(this.tracks.keys());
    const limit = this.header.segmentEnd;
    while (pos < limit) {
      signal?.throwIfAborted();
      const known = this.scanned.get(pos);
      if (known) {
        if (known.time > until) return known.time;
        pos = known.end;
        continue;
      }
      const h = await reader.header(pos);
      if (!h) break;
      if (h.id !== ID.Cluster) {
        if (h.size === null) break; // Unknown-size non-Cluster: nothing more we can step over.
        pos = h.dataStart + h.size;
        continue;
      }
      const cluster = await readCluster(reader, pos, wanted, limit);
      if (!cluster || cluster.end <= pos) break;
      signal?.throwIfAborted();
      await this.emit(cluster.blocks);
      const time = this.seconds(cluster.timestamp);
      this.scanned.set(pos, { time, end: cluster.end });
      if (time > until) return time;
      pos = cluster.end;
    }
    return Infinity;
  }

  private async emit(blocks: readonly MkvBlock[]) {
    const byTrack = new Map<number, SubtitleCue[]>();
    for (const block of blocks) {
      const track = this.tracks.get(block.track);
      if (!track) continue;
      let cue: SubtitleCue | null;
      try {
        cue = await blockToCue(track, block, this.header.timestampScale);
      } catch (err) {
        console.warn('subtitles: bad block in track', block.track, err);
        continue;
      }
      if (!cue) continue;
      const seen = this.emitted.get(block.track) ?? new Set<string>();
      this.emitted.set(block.track, seen);
      const key = `${cue.start}|${cue.assChunk ?? cue.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = byTrack.get(block.track) ?? [];
      list.push(cue);
      byTrack.set(block.track, list);
    }
    for (const [track, cues] of byTrack) this.sink(track, cues);
  }
}
