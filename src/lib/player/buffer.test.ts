import { describe, expect, it } from 'vitest';
import {
  aheadOf,
  bufferedAhead,
  bufferedToEnd,
  evictionRange,
  gapJumpTarget,
  isBuffered,
  lastAtOrBefore,
  quotaEvictionRange,
  quotaEvictionRanges,
  toRanges,
  totalBuffered,
} from './buffer';

describe('bufferedAhead', () => {
  it('measures the contiguous range containing t', () => {
    expect(bufferedAhead(toRanges([[0, 10]]), 4)).toBe(6);
    expect(bufferedAhead(toRanges([[0, 10]]), 12)).toBe(0);
    expect(bufferedAhead(toRanges([]), 0)).toBe(0);
  });
  it('bridges tiny gaps but not real ones', () => {
    expect(
      bufferedAhead(
        toRanges([
          [0, 5],
          [5.1, 9],
          [20, 30],
        ]),
        1,
      ),
    ).toBeCloseTo(8);
  });
  it('accepts a range that starts just after t (keyframe restart)', () => {
    expect(bufferedAhead(toRanges([[6.02, 12]]), 6)).toBeCloseTo(6);
  });
});

describe('isBuffered', () => {
  it('is false outside the ranges', () => {
    const r = toRanges([
      [0, 4],
      [8, 12],
    ]);
    expect(isBuffered(r, 2)).toBe(true);
    expect(isBuffered(r, 6)).toBe(false);
    expect(isBuffered(r, 9)).toBe(true);
  });
});

describe('bufferedToEnd', () => {
  const r = toRanges([
    [0, 4],
    [8, 40.08],
  ]);

  it('is true at, in the last moment of, and past the end of a last range that reaches the end', () => {
    expect(bufferedToEnd(r, 40.08, 40.08)).toBe(true);
    expect(bufferedToEnd(r, 40.06, 40.08)).toBe(true);
    expect(bufferedToEnd(r, 41, 40.08)).toBe(true);
    // Audio ending a frame before the video (the element's duration).
    expect(bufferedToEnd(toRanges([[8, 40.06]]), 40.08, 40.08)).toBe(true);
  });

  it('is false in a hole, before the last range, or when the tail is missing', () => {
    expect(bufferedToEnd(r, 6, 40.08)).toBe(false);
    expect(bufferedToEnd(toRanges([[0, 30]]), 40, 40.08)).toBe(false);
    expect(bufferedToEnd(toRanges([]), 40, 40.08)).toBe(false);
    expect(bufferedToEnd(r, 40, NaN)).toBe(false);
  });
});

describe('evictionRange', () => {
  it('drops what is more than 30 s behind the playhead', () => {
    expect(evictionRange(toRanges([[0, 100]]), 50)).toEqual([0, 20]);
    expect(evictionRange(toRanges([[0, 100]]), 20)).toBeNull();
    expect(evictionRange(toRanges([]), 100)).toBeNull();
  });
});

describe('gapJumpTarget', () => {
  it('skips a small hole in front of the playhead', () => {
    expect(gapJumpTarget(toRanges([[0.1, 10]]), 0)).toBe(0.1);
    expect(
      gapJumpTarget(
        toRanges([
          [0, 4],
          [4.6, 9],
        ]),
        4.05,
      ),
    ).toBe(4.6);
  });
  it('leaves buffered positions and large holes alone', () => {
    expect(gapJumpTarget(toRanges([[0, 10]]), 3)).toBeNull();
    expect(gapJumpTarget(toRanges([[5, 10]]), 0)).toBeNull();
    expect(gapJumpTarget(toRanges([]), 0)).toBeNull();
    expect(gapJumpTarget(toRanges([[0, 4]]), 6)).toBeNull();
  });
});

describe('quotaEvictionRange', () => {
  it('drops all but a second behind the playhead', () => {
    expect(quotaEvictionRange(toRanges([[0, 100]]), 50)).toEqual([0, 49]);
    expect(quotaEvictionRange(toRanges([[0, 100]]), 1)).toBeNull();
    expect(quotaEvictionRange(toRanges([]), 50)).toBeNull();
  });
  it('ends on a random-access point so the GOP being played stays', () => {
    const keyframes = [0, 4, 8, 12];
    const cut = (c: number) => lastAtOrBefore(keyframes, c);
    expect(quotaEvictionRange(toRanges([[0, 20]]), 10, cut)).toEqual([0, 8]);
    expect(quotaEvictionRange(toRanges([[0, 20]]), 4.5, cut)).toBeNull();
  });
});

describe('quotaEvictionRanges', () => {
  it('also drops media that starts past the media at the playhead', () => {
    // A seek back from 30 s left [30, 40]; the playhead is at 2 in [0, 5].
    const ranges = toRanges([
      [0, 5],
      [30, 40],
    ]);
    expect(quotaEvictionRanges(ranges, 2)).toEqual([
      [0, 1],
      [30, Infinity],
    ]);
    expect(quotaEvictionRanges(ranges, 0.5)).toEqual([[30, Infinity]]);
  });
  it('keeps media just past a small gap at the playhead, and nothing behind when starved', () => {
    expect(quotaEvictionRanges(toRanges([[0.6, 5]]), 0)).toEqual([]);
    expect(quotaEvictionRanges(toRanges([[0, 3]]), 2.9, undefined, -0.5)).toEqual([[0, 3.4]]);
    expect(quotaEvictionRanges(toRanges([[0, 3]]), 3)).toEqual([[0, 2]]);
  });
});

describe('aheadOf', () => {
  it('counts media that starts in a small gap after the playhead', () => {
    expect(aheadOf(toRanges([[0.6, 5]]), 0)).toBeCloseTo(5);
    expect(aheadOf(toRanges([[0, 5]]), 2)).toBe(3);
    expect(aheadOf(toRanges([[3, 5]]), 0)).toBe(0);
    expect(aheadOf(toRanges([[0, 5]]), 6)).toBe(0);
    expect(aheadOf(toRanges([]), 0)).toBe(0);
  });
});

describe('totalBuffered', () => {
  it('sums every range', () => {
    expect(
      totalBuffered(
        toRanges([
          [0, 5],
          [30, 40],
        ]),
      ),
    ).toBe(15);
  });
});

describe('lastAtOrBefore', () => {
  it('finds the last point at or before t', () => {
    expect(lastAtOrBefore([1, 3, 5], 3)).toBe(3);
    expect(lastAtOrBefore([1, 3, 5], 4.9)).toBe(3);
    expect(lastAtOrBefore([1, 3, 5], 0)).toBe(-Infinity);
  });
});
