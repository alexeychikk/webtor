import { describe, expect, it } from 'vitest';
import { appendOffset, elementDuration, restartPoint, timeline, toSourceTime } from './timeline';

describe('timeline with a zero start', () => {
  const tl = timeline(0);
  it('is the identity', () => {
    expect(toSourceTime(tl, 8)).toBe(8);
    expect(appendOffset(tl, 0)).toBe(0);
    expect(appendOffset(tl, 6)).toBe(6);
    expect(elementDuration(tl, 12)).toBe(12);
  });
});

describe('timeline with a non-zero start (MPEG-TS at 1.4 s)', () => {
  const tl = timeline(1.4);
  it('starts the element timeline at 0, so the first append has no gap before it', () => {
    expect(appendOffset(tl, restartPoint(tl, null))).toBe(0);
  });
  it('maps a seek to the keyframe before it and back', () => {
    // Seek to element time 8 → look up the keyframe before source time 9.4.
    expect(toSourceTime(tl, 8)).toBeCloseTo(9.4);
    // Keyframe at source 7.4 → appended from element time 6.
    expect(appendOffset(tl, restartPoint(tl, 7.4))).toBeCloseTo(6);
  });
  it('never restarts before the first frame', () => {
    expect(restartPoint(tl, 0)).toBe(1.4);
    expect(restartPoint(tl, undefined)).toBe(1.4);
    expect(appendOffset(tl, 1)).toBe(0);
  });
  it('shortens the duration by the start offset', () => {
    expect(elementDuration(tl, 13.4)).toBeCloseTo(12);
    expect(Number.isNaN(elementDuration(tl, Infinity))).toBe(true);
    expect(Number.isNaN(elementDuration(tl, 1))).toBe(true);
  });
  it('clamps negative or unknown first timestamps to 0', () => {
    expect(timeline(-0.08).startTime).toBe(0);
    expect(timeline(NaN).startTime).toBe(0);
  });
});
