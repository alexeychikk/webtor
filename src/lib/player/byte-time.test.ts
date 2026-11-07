import { describe, expect, it } from 'vitest';
import {
  downloadedTimes,
  mappingPoints,
  monotonePoints,
  timeAtByte,
  type ByteTimeIndex,
  type ByteTimePoint,
} from './byte-time';
import { downloadedBytes } from './seek';

/*
 * A 100 s VBR file: a 1000-byte header, then 0–60 s at 1000 B/s (the film) and 60–100 s at
 * 100 B/s (the credits), then 1000 bytes of Cues. The credits hold 40 % of the time and 6 % of the
 * bytes, so a byte fraction plotted as time lands far right of the playhead there.
 */
const HEADER = 1000;
const DURATION = 100;
const byteAt = (t: number) => (t <= 60 ? HEADER + 1000 * t : HEADER + 60_000 + 100 * (t - 60));
const LENGTH = byteAt(DURATION) + 1000;
/** Cues: a cluster every 10 s. */
const cues: ByteTimePoint[] = Array.from({ length: 10 }, (_, i) => ({
  byte: byteAt(i * 10),
  time: i * 10,
}));
const index: ByteTimeIndex = { points: cues, whole: true, mediaEnd: byteAt(DURATION) };

const held = (from: number, to: number) => [{ start: byteAt(from), end: byteAt(to) }];
const times = (ranges: readonly (readonly [number, number])[]) =>
  ranges.map(([s, e]) => [s * DURATION, e * DURATION]);

/** Downloaded ranges in seconds for byte ranges, through `idx`. */
const draw = (bytes: { start: number; end: number }[], idx: ByteTimeIndex | null = index) =>
  times(downloadedTimes(bytes, idx, LENGTH, DURATION));

/** Seconds `[start, end]` of `ranges` match `want` within 1 ms. */
function expectRanges(got: number[][], want: [number, number][]) {
  expect(got).toHaveLength(want.length);
  got.forEach(([s, e], i) => {
    expect(s).toBeCloseTo(want[i]![0], 3);
    expect(e).toBeCloseTo(want[i]![1], 3);
  });
}

/** The ranges cover the playhead `t`: a range starts at or before it and ends after it. */
const covers = (ranges: number[][], t: number) => ranges.some(([s, e]) => s! <= t && e! > t);

describe('timeAtByte', () => {
  const points = mappingPoints(index, LENGTH, DURATION);

  it('is exact at the index points and linear between them', () => {
    expect(timeAtByte(points, byteAt(30))).toBeCloseTo(30);
    expect(timeAtByte(points, byteAt(80))).toBeCloseTo(80);
    expect(timeAtByte(points, byteAt(65))).toBeCloseTo(65);
    expect(timeAtByte(points, (byteAt(80) + byteAt(90)) / 2)).toBeCloseTo(85);
  });

  it('maps the header to 0 and the bytes after the last point on to the end of the media', () => {
    expect(timeAtByte(points, 0)).toBe(0);
    expect(timeAtByte(points, HEADER / 2)).toBeLessThan(0.01);
    expect(timeAtByte(points, byteAt(95))).toBeCloseTo(95);
    expect(timeAtByte(points, byteAt(DURATION))).toBe(DURATION);
    // The Cues after the media.
    expect(timeAtByte(points, LENGTH)).toBe(DURATION);
  });

  it('runs on to the file length without a media end', () => {
    const t = timeAtByte(
      mappingPoints({ points: cues, whole: true }, LENGTH, DURATION),
      byteAt(95),
    );
    expect(t).toBeGreaterThan(90);
    expect(t).toBeLessThan(DURATION);
  });
});

describe('downloadedTimes', () => {
  it('draws the bytes around the playhead in the credits at the playhead (no gap)', () => {
    // Playhead at 80 s (credits): the window holds 70–90 s. As byte fractions that was 93.9–96.9 %.
    const got = draw(held(70, 90));
    expectRanges(got, [[70, 90]]);
    expect(covers(got, 80)).toBe(true);
    expect((byteAt(70) / LENGTH) * DURATION).toBeGreaterThan(93);
  });

  it('draws the film part at its times too (uneven bitrate both ways)', () => {
    expectRanges(draw(held(20, 40)), [[20, 40]]);
    expectRanges(draw(held(55, 65)), [[55, 65]]);
  });

  it('draws several held ranges (after a seek, behind the playhead) at their own times', () => {
    // Seek from 30 s to 85 s: the old window (25–40 s) not evicted yet, the new one 85–90 s.
    const got = draw([...held(25, 40), ...held(85, 90)]);
    expectRanges(got, [
      [25, 40],
      [85, 90],
    ]);
  });

  it('merges ranges that meet in time and drops empty ones', () => {
    expectRanges(draw([...held(10, 20), ...held(20, 30)]), [[10, 30]]);
    expect(draw([{ start: 100, end: 400 }])).toEqual([]);
  });

  it('covers the playhead after every kind of seek once the bytes there are held', () => {
    // Window: 10 s behind the playhead to a few seconds ahead (ADR 0012), whatever moved it.
    const window = (t: number) => held(Math.max(0, t - 10), Math.min(DURATION, t + 4));
    // ←/→ and ±5 s skips, double-tap streaks (5, 10, 20 s), seek-bar jumps, start and end.
    for (const t of [0, 0.5, 5, 15, 35, 59, 61, 75, 80, 95, 99.5]) {
      expect(covers(draw(window(t)), t), `playhead ${t}`).toBe(true);
    }
  });

  it('places a multi-file torrent’s pieces through the file offset', () => {
    // The file sits at byte 5000 of the torrent, after another file; 1000-byte pieces.
    const offset = 5000;
    const have = new Set<number>();
    for (let b = byteAt(70) + offset; b < byteAt(90) + offset; b += 1000)
      have.add(Math.floor(b / 1000));
    const bytes = downloadedBytes({ get: (i) => have.has(i) }, 1000, offset, LENGTH);
    const got = draw(bytes);
    expect(got).toHaveLength(1);
    expect(got[0]![0]).toBeLessThanOrEqual(70);
    expect(got[0]![0]).toBeGreaterThan(69);
    expect(got[0]![1]).toBeGreaterThanOrEqual(90);
    expect(got[0]![1]).toBeLessThan(91);
  });

  it('draws nothing without an index, a duration or a file length', () => {
    expect(draw(held(70, 90), null)).toEqual([]);
    expect(draw(held(70, 90), { points: [], whole: true })).toEqual([]);
    expect(downloadedTimes(held(70, 90), index, LENGTH, NaN)).toEqual([]);
    expect(downloadedTimes(held(70, 90), index, LENGTH, 0)).toEqual([]);
    expect(downloadedTimes(held(70, 90), index, 0, DURATION)).toEqual([]);
  });

  it('leaves out the bytes past a partial index (an AVI scan, learned points)', () => {
    const partial: ByteTimeIndex = { points: cues.filter((p) => p.time <= 70), whole: false };
    // Up to the last point (70 s) drawn; past it nothing, rather than a guess.
    expectRanges(draw(held(65, 90), partial), [[65, 70]]);
    expect(draw(held(75, 90), partial)).toEqual([]);
  });

  it('covers a resume or far seek from the first learned point (the keyframe) on', () => {
    // A resume at 80 s from the keyframe at 78 s: the reads learned only 78 s and on, each sample
    // at a fragment's start with the read cursor past it (ByteWindow.produced).
    const learned: ByteTimeIndex = {
      points: [78, 80, 82, 84, 86].map((t) => ({ byte: byteAt(t + 1), time: t })),
      whole: false,
    };
    const got = draw(held(78, 88), learned);
    expect(got).toHaveLength(1);
    expect(covers(got, 80)).toBe(true);
    expect(got[0]![0]).toBeLessThan(78);
    expect(got[0]![1]).toBeCloseTo(86);
  });

  it('runs on to the end once the reads reached it (a point at the end of the reads)', () => {
    const learned: ByteTimeIndex = {
      points: [
        ...[90, 92, 94, 96, 98].map((t) => ({ byte: byteAt(t + 1), time: t })),
        { byte: byteAt(DURATION), time: DURATION },
      ],
      whole: false,
    };
    expect(covers(draw(held(90, 100), learned), 99.5)).toBe(true);
  });

  it('keeps the layer at or before the playhead when learned points overshoot', () => {
    // Read-ahead: each sample's byte is up to 3 s of media past its time (prefetch), so the
    // mapping places bytes early, never late.
    const learned: ByteTimeIndex = {
      points: [70, 72, 74, 76, 78, 80, 82, 84].map((t) => ({ byte: byteAt(t + 3), time: t })),
      whole: false,
    };
    const got = draw(held(70, 90), learned);
    expect(covers(got, 80)).toBe(true);
    expect(got[0]![0]).toBeLessThanOrEqual(70);
  });
});

describe('monotonePoints', () => {
  it('sorts by time and drops points whose byte does not rise', () => {
    expect(
      monotonePoints([
        { byte: 300, time: 3 },
        { byte: 100, time: 1 },
        { byte: 250, time: 2 },
        { byte: 200, time: 2.5 },
        { byte: NaN, time: 4 },
        { byte: 400, time: 4 },
      ]),
    ).toEqual([
      { byte: 100, time: 1 },
      { byte: 250, time: 2 },
      { byte: 300, time: 3 },
      { byte: 400, time: 4 },
    ]);
  });

  it('clamps times to the duration and keeps points inside the file', () => {
    const points = mappingPoints(
      {
        points: [
          { byte: 10, time: -1 },
          { byte: 50, time: 5 },
          { byte: 90, time: 20 },
          { byte: 200, time: 30 },
        ],
        whole: false,
      },
      100,
      10,
    );
    expect(points).toEqual([
      { byte: 0, time: 0 },
      { byte: 10, time: 0 },
      { byte: 50, time: 5 },
      { byte: 90, time: 10 },
    ]);
  });
});
