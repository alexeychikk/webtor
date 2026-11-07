import { readFileSync } from 'node:fs';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { downloadedTimes } from './byte-time';
import { mp4ByteTimeIndex, mp4TrackIndex, type Mp4SampleTable } from './mp4-index';

/*
 * 12 samples at 1 s (timescale 1000), keyframes 0, 4, 8, B-frame-like composition offsets of
 * 500 on every sample. Chunks of 3 samples, 100 bytes each except the keyframes (400).
 */
const table: Mp4SampleTable = {
  sampleTimingEntries: [{ startIndex: 0, startDecodeTimestamp: 0, count: 12, delta: 1000 }],
  sampleCompositionTimeOffsets: [{ startIndex: 0, count: 12, offset: 500 }],
  sampleSizes: Array.from({ length: 12 }, (_, i) => (i % 4 === 0 ? 400 : 100)),
  keySampleIndices: [0, 4, 8],
  chunkOffsets: [1000, 2000, 3000, 4000],
  sampleToChunk: [{ startSampleIndex: 0, startChunkIndex: 0, samplesPerChunk: 3 }],
};

describe('mp4ByteTimeIndex', () => {
  it('places each keyframe at its offset inside its chunk, at its packet timestamp', () => {
    const index = mp4ByteTimeIndex({ table, timescale: 1000, editListOffset: 500 });
    expect(index).toEqual({
      whole: true,
      points: [
        { byte: 1000, time: 0 },
        { byte: 2100, time: 4 },
        { byte: 3200, time: 8 },
      ],
      mediaEnd: 4300,
    });
  });

  it('follows sample-to-chunk runs and a single sample size', () => {
    const index = mp4ByteTimeIndex({
      table: {
        ...table,
        sampleSizes: [10],
        keySampleIndices: null,
        sampleCompositionTimeOffsets: [],
        chunkOffsets: [100, 500, 900],
        sampleToChunk: [
          { startSampleIndex: 0, startChunkIndex: 0, samplesPerChunk: 2 },
          { startSampleIndex: 2, startChunkIndex: 1, samplesPerChunk: 5 },
        ],
      },
      timescale: 1000,
      editListOffset: 0,
    });
    expect(index!.points.map((p) => p.byte)).toEqual([
      100, 110, 500, 510, 520, 530, 540, 900, 910, 920, 930, 940,
    ]);
    expect(index!.points.map((p) => p.time)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(index!.mediaEnd).toBe(950);
  });

  it('is null without samples (a fragmented file)', () => {
    const empty: Mp4SampleTable = {
      sampleTimingEntries: [],
      sampleCompositionTimeOffsets: [],
      sampleSizes: [],
      keySampleIndices: null,
      chunkOffsets: [],
      sampleToChunk: [],
    };
    expect(mp4ByteTimeIndex({ table: empty, timescale: 1000, editListOffset: 0 })).toBeNull();
  });
});

describe('mp4TrackIndex on vbr.mp4', () => {
  const bytes = readFileSync(new URL('../../../e2e/fixtures/vbr.mp4', import.meta.url));

  it('reads every keyframe from Mediabunny, the noisy half holding most of the bytes', async () => {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
    const track = (await input.getPrimaryVideoTrack())!;
    const index = mp4TrackIndex(track)!;
    expect(index.whole).toBe(true);
    const times = index.points.map((p) => p.time);
    expect(times[0]).toBe(0);
    expect(times.at(-1)).toBeGreaterThan(28);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const at = (t: number) => index.points.find((p) => p.time >= t)!.byte;
    expect(at(16)).toBeGreaterThan(0.85 * bytes.length);
    expect(at(14)).toBeLessThan(at(16));

    // A held range from the first keyframe at 14 s or later is drawn from that keyframe's time.
    const key = index.points.find((p) => p.time >= 14)!;
    const duration = 30;
    const [range] = downloadedTimes(
      [{ start: key.byte, end: bytes.length }],
      index,
      bytes.length,
      duration,
    );
    expect(range![0] * duration).toBeCloseTo(key.time, 3);
    expect(range![1]).toBe(1);
  });

  it('is null for a Matroska track', async () => {
    const mkv = readFileSync(new URL('../../../e2e/fixtures/sample.mkv', import.meta.url));
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(mkv) });
    expect(mp4TrackIndex((await input.getPrimaryVideoTrack())!)).toBeNull();
  });
});
