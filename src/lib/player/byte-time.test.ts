import { describe, expect, it } from 'vitest';
import {
  downloadedTimes,
  indexedByteBefore,
  learnedPoints,
  mappingPoints,
  monotonePoints,
  timeAtByte,
  type ByteTimeIndex,
  type ByteTimePoint,
  type LearnedPoint,
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

describe('indexedByteBefore', () => {
  const points = [
    { byte: 3000, time: 6 },
    { byte: 100, time: 0 },
    { byte: 1000, time: 2 },
    { byte: 2000, time: 4 },
  ];

  it('is the keyframe before the last at or before the time', () => {
    expect(indexedByteBefore(points, 5)).toBe(1000);
    expect(indexedByteBefore(points, 6)).toBe(2000);
    expect(indexedByteBefore(points, 60)).toBe(2000);
  });

  it('is 0 before the second keyframe', () => {
    expect(indexedByteBefore(points, 3)).toBe(100);
    expect(indexedByteBefore(points, 1)).toBe(0);
    expect(indexedByteBefore([], 10)).toBe(0);
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

describe('learnedPoints', () => {
  /** Samples at `times` with the read cursor at `byte` each, in run `run`. */
  const at = (byte: number, times: number[], run = 0) => times.map((time) => ({ byte, time, run }));

  it('keeps the latest time of samples at one cursor (the demuxer cache holds the data)', () => {
    expect(learnedPoints([...at(100, [1, 2]), ...at(300, [3, 4, 5, 6])])).toEqual([
      { byte: 100, time: 2 },
      { byte: 300, time: 6 },
    ]);
  });

  it('drops a later sample at a smaller byte within a run (a reader behind another)', () => {
    expect(learnedPoints([...at(300, [3]), ...at(200, [4]), ...at(400, [5])])).toEqual([
      { byte: 300, time: 3 },
      { byte: 400, time: 5 },
    ]);
  });

  it('prefers the newest run where runs disagree, keeps an older one’s that fit', () => {
    // Run 0 played 0–30 s with 8 units of overshoot; run 1 (a seek back to 10 s) read 10–20 s with
    // a bigger one. The older points around 10–20 s don't fit the newer and go.
    const run0 = [5, 10, 15, 20, 25, 30].map((t) => ({ byte: t * 10 + 8, time: t, run: 0 }));
    const run1 = [10, 15, 20].map((t) => ({ byte: t * 10 + 60, time: t, run: 1 }));
    expect(learnedPoints([...run0, ...run1])).toEqual([
      { byte: 58, time: 5 },
      { byte: 160, time: 10 },
      { byte: 210, time: 15 },
      { byte: 260, time: 20 },
      { byte: 308, time: 30 },
    ]);
  });

  it('ignores non-finite samples and returns nothing for none', () => {
    expect(learnedPoints([])).toEqual([]);
    expect(learnedPoints([{ byte: NaN, time: 1, run: 0 }])).toEqual([]);
  });

  it('gives the same points as a point-by-point insertion on ~10k samples over a few runs', () => {
    // A long film learned over 4 runs (seeks back and forth), the cursor stopping now and then.
    const samples: LearnedPoint[] = [];
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const runs = [
      { run: 0, from: 0, to: 3000 },
      { run: 1, from: 2500, to: 6500 },
      { run: 2, from: 1000, to: 2000 },
      { run: 3, from: 5000, to: 6500 },
    ];
    for (const { run, from, to } of runs) {
      const overshoot = 50_000 + run * 30_000;
      for (let t = from; t < to; t += 1) {
        const cursorStopped = random() < 0.2;
        const byte = Math.round(t * 1_000_000 + (cursorStopped ? 0 : overshoot * random()));
        samples.push({ byte, time: t, run });
      }
    }
    expect(samples.length).toBeGreaterThan(9_000);
    const got = learnedPoints(samples);
    expect(got).toEqual(insertOneByOne(samples));
    for (let i = 1; i < got.length; i++) {
      expect(got[i]!.time).toBeGreaterThan(got[i - 1]!.time);
      expect(got[i]!.byte).toBeGreaterThan(got[i - 1]!.byte);
    }
  });

  describe('drawn', () => {
    /** A whole-file read up front (default prefetch): every sample has the cursor at the end. */
    const wholeRead = (times: number[]) => at(LENGTH, times);
    const drawLearned = (samples: ReturnType<typeof at>) =>
      draw([{ start: 0, end: LENGTH }], { points: learnedPoints(samples), whole: false });

    it('draws up to the furthest produced time when the cursor stopped (no empty layer)', () => {
      const got = drawLearned(wholeRead([0, 2, 4, 6, 8, 10]));
      expectRanges(got, [[0, 10]]);
      expect(covers(got, 7)).toBe(true);
    });

    it('draws the whole file at the end even at the same cursor as the samples', () => {
      expectRanges(drawLearned([...wholeRead([0, 2, 4]), ...wholeRead([DURATION])]), [
        [0, DURATION],
      ]);
    });

    it('covers the playhead after a seek whose reads stopped in the cache', () => {
      // Seek to 40 s: the reads ran through 60 s at once, then the cache serves 40–60 s.
      const samples = [
        ...[0, 2, 4, 6].map((t) => ({ byte: byteAt(t + 8), time: t, run: 0 })),
        ...at(byteAt(60), [40, 44, 50, 56, 60], 1),
      ];
      const got = draw(held(40, 60), { points: learnedPoints(samples), whole: false });
      expect(covers(got, 45.7)).toBe(true);
      expect(got[0]![0]).toBeLessThanOrEqual(40);
    });
  });
});

/** The reference for `learnedPoints`: each run's points inserted one by one, newest run first. */
function insertOneByOne(samples: readonly LearnedPoint[]): ByteTimePoint[] {
  const runs = [...new Set(samples.map((s) => s.run))].sort((a, b) => b - a);
  const out: ByteTimePoint[] = [];
  for (const run of runs) {
    const points = learnedPoints(samples.filter((s) => s.run === run));
    for (const p of points) {
      let i = 0;
      while (i < out.length && out[i]!.time < p.time) i++;
      const prev = out[i - 1];
      const next = out[i];
      if (next && !(next.time > p.time && next.byte > p.byte)) continue;
      if (prev && !(prev.byte < p.byte)) continue;
      out.splice(i, 0, p);
    }
  }
  return out;
}
