/**
 * Touch gestures on the picture (pure, see touch-seek.test.ts; Player.svelte runs the timers).
 *
 * A double-tap on the left third seeks back, on the right third forward. While the streak goes
 * on, every further tap on the same side within `SEEK_STREAK_MS` of the previous one seeks the
 * next step: 5, 10, 20, 40… s (capped at `SEEK_STREAK_MAX_STEP_S`). A tap on the other side during
 * a streak starts a new streak there at 5 s. The middle third keeps the plain tap.
 */

/** A second tap on the same side within this makes a double-tap. */
export const DOUBLE_TAP_MS = 300;
/** A streak goes on while each further tap comes within this of the previous one. */
export const SEEK_STREAK_MS = 700;
/** First step of a streak (the double-tap itself). */
export const SEEK_STREAK_FIRST_S = 5;
/** The step doubles up to this (5 min). */
export const SEEK_STREAK_MAX_STEP_S = 300;
/** Seek taps closer than this go to the player as one seek (no seek flood during a streak). */
export const SEEK_COALESCE_MS = 300;

export type TapZone = 'back' | 'middle' | 'forward';
export type SeekSide = Exclude<TapZone, 'middle'>;

/** Which third of the picture `x` (from its left edge) falls in. */
export function tapZone(x: number, width: number): TapZone {
  if (!(width > 0)) return 'middle';
  if (x < width / 3) return 'back';
  if (x >= (width * 2) / 3) return 'forward';
  return 'middle';
}

/** Step of the streak's `n`-th seek (1-based): 5, 10, 20, 40… s, capped. */
export function streakStep(n: number): number {
  const step = SEEK_STREAK_FIRST_S * 2 ** Math.max(0, n - 1);
  return Math.min(step, SEEK_STREAK_MAX_STEP_S);
}

export interface TapState {
  /** Side of the last tap (`null`: no tap pending, no streak). */
  side: SeekSide | null;
  /** Time of the last tap (ms). */
  at: number;
  /** Seeks in the current streak (0: a first tap, waiting for a second). */
  seeks: number;
  /** Seconds the streak has moved so far (always positive; `side` gives the direction). */
  total: number;
}

export const NO_TAPS: TapState = { side: null, at: -Infinity, seeks: 0, total: 0 };

export type TapAction =
  /** A plain tap, at once (middle third). */
  | { type: 'tap' }
  /** A first tap on a side: a plain tap unless another comes within `DOUBLE_TAP_MS`. */
  | { type: 'wait' }
  /** Seek by `by` s (signed); `total` is the streak's amount so far. */
  | { type: 'seek'; side: SeekSide; by: number; total: number };

/** Next state and what to do for a tap in `zone` at time `at` (ms). */
export function onTap(
  state: TapState,
  zone: TapZone,
  at: number,
): { state: TapState; action: TapAction } {
  if (zone === 'middle') return { state: NO_TAPS, action: { type: 'tap' } };
  const since = at - state.at;
  const streaking = state.side !== null && state.seeks > 0 && since <= SEEK_STREAK_MS;
  let seeks = 0;
  let total = 0;
  if (state.side === zone && (streaking || (state.seeks === 0 && since <= DOUBLE_TAP_MS))) {
    seeks = state.seeks + 1;
    total = state.total;
  } else if (streaking) {
    // The other side during a streak: a new streak there, at once.
    seeks = 1;
  }
  if (seeks === 0)
    return { state: { side: zone, at, seeks: 0, total: 0 }, action: { type: 'wait' } };
  const step = streakStep(seeks);
  total += step;
  return {
    state: { side: zone, at, seeks, total },
    action: { type: 'seek', side: zone, by: zone === 'back' ? -step : step, total },
  };
}

/** The streak's amount for the overlay: "35 s", "2 min 35 s", "5 min". */
export function formatStreak(total: number): string {
  const s = Math.round(total);
  if (s < 60) return `${s} s`;
  const rest = s % 60;
  return rest ? `${Math.floor(s / 60)} min ${rest} s` : `${s / 60} min`;
}
