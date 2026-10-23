import { describe, expect, it } from 'vitest';
import {
  aheadOf,
  atBufferedEnd,
  endOfStreamIn,
  bufferedAhead,
  bufferedToEnd,
  endSnap,
  endedBefore,
  evictionRange,
  gapJumpTarget,
  isBuffered,
  lastAtOrBefore,
  quotaEvictionRange,
  quotaEvictionRanges,
  toRanges,
  totalBuffered,
  trackStart,
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

describe('endedBefore', () => {
  // Audio ending at 6 s of a 12 s video.
  const audio = toRanges([[0, 6.01]]);

  it('is true past the track end while its SourceBuffer still holds its last media', () => {
    expect(endedBefore(audio, 9, 6.01)).toBe(true);
    expect(endedBefore(audio, 6, 6.01)).toBe(true);
    expect(endedBefore(toRanges([[5, 6]]), 11.9, 6.01)).toBe(true);
  });

  it('is false before the end, without its last media, or with the end unknown', () => {
    expect(endedBefore(audio, 3, 6.01)).toBe(false);
    expect(endedBefore(toRanges([[0, 4]]), 9, 6.01)).toBe(false);
    expect(endedBefore(toRanges([]), 9, 6.01)).toBe(false);
    expect(endedBefore(audio, 9, NaN)).toBe(false);
  });
});

describe('trackStart', () => {
  it('starts at k while the track has a packet at or after it', () => {
    expect(trackStart(8, { timestamp: 7.99, duration: 0.023, last: false })).toEqual({
      start: 8,
      end: null,
    });
    expect(trackStart(0, null)).toEqual({ start: 0, end: null });
    // The last packet starts exactly at k: it is part of the conversion.
    expect(trackStart(8, { timestamp: 8, duration: 0.5, last: true })).toEqual({
      start: 8,
      end: 8.5,
    });
  });

  it('starts a track that ended before k a second before its end', () => {
    expect(trackStart(8, { timestamp: 5.98, duration: 0.023, last: true })).toEqual({
      start: 5.003,
      end: 6.003,
    });
    // Ends inside k's packet: no packet starts at or after k.
    expect(trackStart(8, { timestamp: 7.99, duration: 0.032, last: true }).start).toBeCloseTo(
      7.022,
    );
  });

  it('never starts before the floor, and keeps a long last packet whole', () => {
    expect(trackStart(8, { timestamp: 0.3, duration: 0.2, last: true }, 0.1)).toEqual({
      start: 0.1,
      end: 0.5,
    });
    expect(trackStart(8, { timestamp: 4, duration: 2, last: true })).toEqual({ start: 4, end: 6 });
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

describe('atBufferedEnd', () => {
  const video = toRanges([[0, 40.04]]);
  const audio = toRanges([
    [0, 10],
    [12, 40.08],
  ]);

  it('is true once the playhead is within the lead of the earliest last range end', () => {
    expect(atBufferedEnd([video, audio], 39.8)).toBe(true); // lead 0.3
    expect(atBufferedEnd([video, audio], 39.7)).toBe(false);
    expect(atBufferedEnd([video, audio], 40.0, 0.05)).toBe(true);
    expect(atBufferedEnd([video, audio], 39.95, 0.05)).toBe(false);
    expect(atBufferedEnd([video, audio], 40.08, 0)).toBe(true);
  });

  it('is false with an empty SourceBuffer', () => {
    expect(atBufferedEnd([video, toRanges([])], 40)).toBe(false);
    expect(atBufferedEnd([], 40)).toBe(false);
  });
});

describe('endOfStreamIn', () => {
  const video = toRanges([[0, 40.008]]);
  const audio = toRanges([[0, 40.084]]);

  it('waits until EOS_AHEAD_S before the earliest last range end, at the playback rate', () => {
    expect(endOfStreamIn([video, audio], 39.5, 1)).toBeCloseTo(0.408);
    expect(endOfStreamIn([video, audio], 39.5, 2)).toBeCloseTo(0.204);
    expect(endOfStreamIn([video, audio], 39.95, 1)).toBe(0);
    expect(endOfStreamIn([video, audio], 40.05, 1)).toBe(0);
  });

  it('is null while the end is further than EOS_ARM_S away', () => {
    expect(endOfStreamIn([video, audio], 39.3, 1)).toBeNull();
    expect(endOfStreamIn([video, audio], 30, 1)).toBeNull();
  });

  it('is null without media or a forward rate', () => {
    expect(endOfStreamIn([video, toRanges([])], 39.9, 1)).toBeNull();
    expect(endOfStreamIn([], 39.9, 1)).toBeNull();
    expect(endOfStreamIn([video, audio], 39.9, 0)).toBeNull();
    expect(endOfStreamIn([video, audio], 39.9, -1)).toBeNull();
  });
});

describe('endSnap', () => {
  it('moves a target in the last moment back to its start', () => {
    expect(endSnap(39.9, 40.08)).toBeCloseTo(39.83, 6);
    expect(endSnap(40.03, 40.08)).toBeCloseTo(39.83, 6);
    expect(endSnap(39.83, 40.08)).toBeNull(); // the snapped seek itself
    expect(endSnap(39.8, 40.08)).toBeNull();
  });

  it('measures the last moment from where the video ends, when it ends first', () => {
    expect(endSnap(39.8, 40.08, 40.0)).toBeCloseTo(39.75, 6);
    expect(endSnap(39.7, 40.08, 40.0)).toBeNull();
    // A video end past the duration doesn't move the edge.
    expect(endSnap(39.8, 40.08, 41)).toBeNull();
    expect(endSnap(39.9, 40.08, NaN)).toBeCloseTo(39.83, 6);
  });

  it('leaves a seek to the duration, past it, or with an unknown duration alone', () => {
    expect(endSnap(40.08, 40.08)).toBeNull();
    expect(endSnap(45, 40.08)).toBeNull();
    expect(endSnap(39.9, NaN)).toBeNull();
    expect(endSnap(39.9, Infinity)).toBeNull();
    expect(endSnap(0.1, 0.2)).toBeNull();
  });
});
