/** What the centre of the picture shows (pure, see centre.test.ts; drawn by PlayerCentre.svelte). */
import type { Phase } from './controller.svelte';

/**
 * - `loading`: spinner + caption (connecting, opening the file)
 * - `buffering`: spinner, once buffering lasted 500 ms
 * - `play` / `replay`: the paused (ended) circle; `pause`: touch row while playing
 * - `none`: nothing (playing, or touch with the controls hidden)
 */
export type CentreState = 'loading' | 'buffering' | 'play' | 'pause' | 'replay' | 'none';

/** A play/pause toggle to flash: the new state, and a counter that restarts the animation. */
export interface Flash {
  playing: boolean;
  n: number;
}

export function centreState(s: {
  phase: Phase;
  paused: boolean;
  ended: boolean;
  /** Buffering has lasted 500 ms (no spinner flicker on short waits). */
  bufferingLong: boolean;
  touch: boolean;
  /** The control layer shows. */
  shown: boolean;
}): CentreState {
  if (s.phase === 'idle' || s.phase === 'error') return 'none';
  if (s.phase === 'connecting' || s.phase === 'metadata') return 'loading';
  if (s.phase === 'buffering' && s.bufferingLong) return 'buffering';
  if (s.touch) {
    if (!s.shown) return 'none';
    return s.ended ? 'replay' : s.paused ? 'play' : 'pause';
  }
  if (s.phase === 'buffering' || !s.paused) return 'none';
  return s.ended ? 'replay' : 'play';
}
