import { describe, expect, it } from 'vitest';
import {
  HIDE_DELAY_FULLSCREEN_MS,
  HIDE_DELAY_FULLSCREEN_TOUCH_MS,
  HIDE_DELAY_MS,
  hideDelay,
  remainingDelay,
} from './auto-hide';

describe('hideDelay', () => {
  it('is 5 s windowed, for any input', () => {
    expect(HIDE_DELAY_MS).toBe(5000);
    expect(hideDelay({ fullscreen: false, touch: false })).toBe(HIDE_DELAY_MS);
    expect(hideDelay({ fullscreen: false, touch: true })).toBe(HIDE_DELAY_MS);
  });

  it('is 1 s in fullscreen (3 s after a touch)', () => {
    expect(hideDelay({ fullscreen: true, touch: false })).toBe(HIDE_DELAY_FULLSCREEN_MS);
    expect(HIDE_DELAY_FULLSCREEN_MS).toBe(1000);
    expect(hideDelay({ fullscreen: true, touch: true })).toBe(HIDE_DELAY_FULLSCREEN_TOUCH_MS);
  });
});

describe('remainingDelay', () => {
  it('counts from the activity, never below 0', () => {
    expect(remainingDelay(5000, 1200)).toBe(3800);
    expect(remainingDelay(1000, 1200)).toBe(0);
    expect(remainingDelay(1000, -5)).toBe(1000);
  });
});
