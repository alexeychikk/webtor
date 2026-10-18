import { describe, expect, it } from 'vitest';
import { bufferedAhead, evictionRange, isBuffered, toRanges } from './buffer';

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

describe('evictionRange', () => {
  it('drops what is more than 30 s behind the playhead', () => {
    expect(evictionRange(toRanges([[0, 100]]), 50)).toEqual([0, 20]);
    expect(evictionRange(toRanges([[0, 100]]), 20)).toBeNull();
    expect(evictionRange(toRanges([]), 100)).toBeNull();
  });
});
