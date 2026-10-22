/**
 * How long the control layer (and the mouse pointer) stays after the last activity while playing
 * (pure; Player.svelte runs the timer). Windowed it stays longer; in fullscreen it gets out of the
 * picture's way sooner (a touch a bit later than a mouse move or a key).
 */

/** Windowed, any input. */
export const HIDE_DELAY_MS = 5000;
/** Fullscreen, after a mouse move or a key. */
export const HIDE_DELAY_FULLSCREEN_MS = 1000;
/** Fullscreen, after a touch. */
export const HIDE_DELAY_FULLSCREEN_TOUCH_MS = 3000;

export function hideDelay(s: { fullscreen: boolean; touch: boolean }): number {
  if (!s.fullscreen) return HIDE_DELAY_MS;
  return s.touch ? HIDE_DELAY_FULLSCREEN_TOUCH_MS : HIDE_DELAY_FULLSCREEN_MS;
}

/** What is left of the delay `since` ms after the activity (a fullscreen change mid-way). */
export function remainingDelay(delay: number, since: number): number {
  return Math.max(0, delay - Math.max(0, since));
}
