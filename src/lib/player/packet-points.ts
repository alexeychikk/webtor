/**
 * Where the demuxer found the video packets, for the seek bar without a container index (docs/
 * decisions/0012 "Seek bar"). Mediabunny numbers an MPEG-TS packet by the file offset of the TS
 * packet its PES starts in (`sequenceNumber`), so each packet the pipelines or a seek pull is a
 * true (byte, time) point. The read cursor, sampled at each fragment, runs seconds of media ahead
 * of it. Mediabunny is pinned exactly (CLAUDE.md): the track backing is its internal one (1.61).
 */
import type { InputVideoTrack } from 'mediabunny';
import type { ByteTimePoint } from './byte-time';

/** Media time (s) between the points kept: one per slot, besides every keyframe. */
export const PACKET_POINT_SPACING_S = 0.5;

/** Source-time points of the packets seen, in time order, thinned to `spacing`. */
export class PacketPoints {
  private readonly sorted: ByteTimePoint[] = [];

  constructor(private readonly spacing = PACKET_POINT_SPACING_S) {}

  /**
   * A packet at file offset `byte` with timestamp `time` (s). Kept when no point lies within
   * `spacing` of its time; a keyframe whenever no point has its time (the bytes before a keyframe
   * are where a seek's reads start).
   */
  note(byte: number, time: number, key = false) {
    if (!(byte >= 0) || !Number.isFinite(byte) || !Number.isFinite(time)) return;
    const i = this.indexAt(time);
    const next = this.sorted[i];
    const prev = this.sorted[i - 1];
    if (next?.time === time) return;
    if (!key && next && next.time - time < this.spacing) return;
    if (!key && prev && time - prev.time < this.spacing) return;
    this.sorted.splice(i, 0, { byte, time });
  }

  /** The points in time order (bytes may not rise: `monotonePoints` sorts that out). */
  points(): readonly ByteTimePoint[] {
    return this.sorted;
  }

  /** The first index whose time is ≥ `time`. */
  private indexAt(time: number): number {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sorted[mid]!.time < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

type PacketLike = { timestamp: number; sequenceNumber: number; type: string } | null | undefined;
type Backing = Record<string, unknown>;

const PACKET_GETTERS = [
  'getFirstPacket',
  'getPacket',
  'getNextPacket',
  'getKeyPacket',
  'getNextKeyPacket',
] as const;

/**
 * Reports every packet `track`'s backing hands out (to the conversions, sinks and seeks) to `note`
 * with its `sequenceNumber`, without changing what it returns. Only for an MPEG-TS track, where
 * that number is a file offset. False (nothing tapped) when the internals changed shape.
 */
export function tapPacketPositions(
  track: InputVideoTrack,
  note: (byte: number, time: number, key: boolean) => void,
): boolean {
  const backing = (track as unknown as { _backing?: Backing })._backing;
  if (!backing || PACKET_GETTERS.some((name) => typeof backing[name] !== 'function')) return false;
  const report = (packet: PacketLike) => {
    if (packet && typeof packet.sequenceNumber === 'number') {
      note(packet.sequenceNumber, packet.timestamp, packet.type === 'key');
    }
  };
  for (const name of PACKET_GETTERS) {
    const original = backing[name] as (...args: unknown[]) => unknown;
    backing[name] = function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args);
      if (result instanceof Promise) result.then(report as (p: unknown) => void, () => {});
      else report(result as PacketLike);
      return result;
    };
  }
  return true;
}
