import { describe, expect, it } from 'vitest';
import { clampShift } from './tooltip-context';

describe('clampShift', () => {
  it('keeps a tooltip inside its bounds', () => {
    expect(clampShift(100, 200, 0, 1000)).toBe(0);
    expect(clampShift(-20, 80, 0, 1000)).toBe(28);
    expect(clampShift(950, 1030, 0, 1000)).toBe(-38);
    // Wider than the bounds: pinned to the left edge.
    expect(clampShift(-50, 1100, 0, 1000)).toBe(58);
  });
});
