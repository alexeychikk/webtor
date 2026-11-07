import { describe, expect, it } from 'vitest';
import { onSkip, SKIP_STREAK_MS, streakLabel, type SeekStreak } from './seek-streak';

/** Runs skips `[by, at]` from no overlay; returns the overlay after each. */
function skips(seq: [number, number][]) {
  let streak: SeekStreak | null = null;
  return seq.map(([by, at]) => {
    streak = onSkip(streak, by, at);
    return [streak.side, streak.total];
  });
}

describe('onSkip', () => {
  it('adds up skips the same way within the window', () => {
    expect(
      skips([
        [5, 0],
        [5, 300],
        [5, 300 + SKIP_STREAK_MS],
      ]),
    ).toEqual([
      ['forward', 5],
      ['forward', 10],
      ['forward', 15],
    ]);
    expect(
      skips([
        [-5, 0],
        [-5, 100],
      ]),
    ).toEqual([
      ['back', 5],
      ['back', 10],
    ]);
  });

  it('starts a new total on the other side', () => {
    expect(
      skips([
        [5, 0],
        [5, 100],
        [-5, 200],
        [5, 300],
      ]),
    ).toEqual([
      ['forward', 5],
      ['forward', 10],
      ['back', 5],
      ['forward', 5],
    ]);
  });

  it('starts again after the window', () => {
    expect(
      skips([
        [5, 0],
        [5, 1 + SKIP_STREAK_MS],
      ]),
    ).toEqual([
      ['forward', 5],
      ['forward', 5],
    ]);
  });

  it('counts every skip (the pulse restarts) and takes a custom window', () => {
    const a = onSkip(null, 5, 0);
    const b = onSkip(a, 10, 600, 700);
    expect([a.n, b.n, b.total]).toEqual([1, 2, 15]);
    expect(onSkip(b, 20, 1400, 700).total).toBe(20);
  });
});

describe('streakLabel', () => {
  it('signs the amount by side', () => {
    expect(streakLabel('forward', 15)).toBe('+15 s');
    expect(streakLabel('back', 75)).toBe('−1 min 15 s');
  });
});
