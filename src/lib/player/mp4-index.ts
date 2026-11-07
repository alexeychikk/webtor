/**
 * The seek bar's index for MP4/MOV (docs/decisions/0012 "Seek bar"): where each video keyframe
 * sits in the file, from the sample table Mediabunny already parsed. Mediabunny is pinned exactly
 * (CLAUDE.md): the table's shape is its internal one (1.61, `IsobmffDemuxer`).
 */
import type { InputVideoTrack } from 'mediabunny';
import type { ByteTimeIndex, ByteTimePoint } from './byte-time';

/** A non-fragmented track's sample table, as Mediabunny's MP4 demuxer keeps it. */
export interface Mp4SampleTable {
  sampleTimingEntries: readonly {
    startIndex: number;
    startDecodeTimestamp: number;
    count: number;
    delta: number;
  }[];
  sampleCompositionTimeOffsets: readonly { startIndex: number; count: number; offset: number }[];
  /** One entry = every sample has that size. */
  sampleSizes: readonly number[];
  /** Null = every sample is a keyframe. */
  keySampleIndices: readonly number[] | null;
  chunkOffsets: readonly number[];
  sampleToChunk: readonly {
    startSampleIndex: number;
    startChunkIndex: number;
    samplesPerChunk: number;
  }[];
}

export interface Mp4Track {
  table: Mp4SampleTable;
  timescale: number;
  /** Subtracted from a presentation timestamp (track timescale) to give the packet's timestamp. */
  editListOffset: number;
}

/** The last entry whose `startIndex` is ≤ `index`. */
function entryAt<T extends { startIndex: number }>(entries: readonly T[], index: number) {
  let lo = 0;
  let hi = entries.length - 1;
  let found: T | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid]!.startIndex <= index) {
      found = entries[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Packet timestamp (s, source time) of sample `index`, as Mediabunny gives it. */
function timestampOf(track: Mp4Track, index: number): number | null {
  const timing = entryAt(track.table.sampleTimingEntries, index);
  if (!timing || index >= timing.startIndex + timing.count) return null;
  let pts = timing.startDecodeTimestamp + (index - timing.startIndex) * timing.delta;
  const shift = entryAt(track.table.sampleCompositionTimeOffsets, index);
  if (shift && index < shift.startIndex + shift.count) pts += shift.offset;
  return (pts - track.editListOffset) / track.timescale;
}

/**
 * Each keyframe's file offset with its timestamp (source time), and where the track's last sample
 * ends (`mediaEnd`). Null when the table holds no sample (a fragmented file: its samples are in
 * the fragments).
 */
export function mp4ByteTimeIndex(track: Mp4Track): ByteTimeIndex | null {
  const { table } = track;
  const total = table.sampleTimingEntries.reduce((n, e) => Math.max(n, e.startIndex + e.count), 0);
  if (total === 0 || table.sampleSizes.length === 0 || !(track.timescale > 0)) return null;
  const keys = table.keySampleIndices ? new Set(table.keySampleIndices) : null;
  const sizeOf = (i: number) => table.sampleSizes[table.sampleSizes.length === 1 ? 0 : i] ?? 0;
  const points: ByteTimePoint[] = [];
  let mediaEnd = 0;
  let sample = 0;
  table.sampleToChunk.forEach((entry, e) => {
    const nextChunk = table.sampleToChunk[e + 1]?.startChunkIndex ?? table.chunkOffsets.length;
    for (let chunk = entry.startChunkIndex; chunk < nextChunk && sample < total; chunk++) {
      let byte = table.chunkOffsets[chunk];
      if (byte === undefined) return;
      for (let s = 0; s < entry.samplesPerChunk && sample < total; s++, sample++) {
        if (!keys || keys.has(sample)) {
          const time = timestampOf(track, sample);
          if (time !== null) points.push({ byte, time });
        }
        byte += sizeOf(sample);
        mediaEnd = Math.max(mediaEnd, byte);
      }
    }
  });
  if (points.length === 0) return null;
  return { points, whole: true, mediaEnd };
}

/**
 * `mp4ByteTimeIndex` of an MP4/MOV video track opened by Mediabunny; null for another container,
 * a fragmented file, or internals that changed shape. Never throws.
 */
export function mp4TrackIndex(videoTrack: InputVideoTrack): ByteTimeIndex | null {
  try {
    const internal = (
      videoTrack as unknown as {
        _backing?: {
          internalTrack?: Omit<Mp4Track, 'table'> & {
            demuxer?: {
              isFragmented?: boolean;
              getSampleTableForTrack?: (t: unknown) => Mp4SampleTable;
            };
          };
        };
      }
    )._backing?.internalTrack;
    const demuxer = internal?.demuxer;
    if (!internal || !demuxer || demuxer.isFragmented !== false) return null;
    if (typeof demuxer.getSampleTableForTrack !== 'function') return null;
    return mp4ByteTimeIndex({
      table: demuxer.getSampleTableForTrack(internal),
      timescale: internal.timescale,
      editListOffset: internal.editListOffset,
    });
  } catch (err) {
    console.warn('seek bar: no MP4 index:', err);
    return null;
  }
}
