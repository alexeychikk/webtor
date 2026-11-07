/**
 * The seek overlay's running total (pure, see seek-streak.test.ts; Player.svelte runs the timer).
 *
 * Every relative skip (←/→, the centre ±5 s buttons, a double-tap streak) shows on its side
 * (left back, right forward). Skips the same way within `SKIP_STREAK_MS` of the previous one add
 * up; the other way, or a later skip, starts a new total.
 */
import { formatStreak, type SeekSide } from './touch-seek';

/** Same-way skips add up while each comes within this of the previous one (key presses, buttons). */
export const SKIP_STREAK_MS = 1000;

export interface SeekStreak {
  side: SeekSide;
  /** Seconds moved so far (positive; `side` gives the direction). */
  total: number;
  /** Time of the last skip (ms). */
  at: number;
  /** Skips shown so far (restarts the label's pulse on each). */
  n: number;
}

/** The overlay after a skip of `by` s (signed) at `at` ms. */
export function onSkip(
  streak: SeekStreak | null,
  by: number,
  at: number,
  windowMs = SKIP_STREAK_MS,
): SeekStreak {
  const side: SeekSide = by < 0 ? 'back' : 'forward';
  const n = (streak?.n ?? 0) + 1;
  const stacks = streak !== null && streak.side === side && at - streak.at <= windowMs;
  return { side, total: (stacks ? streak.total : 0) + Math.abs(by), at, n };
}

/** The overlay's label: "+15 s", "−1 min 15 s". */
export function streakLabel(side: SeekSide, total: number): string {
  return `${side === 'back' ? '−' : '+'}${formatStreak(total)}`;
}
