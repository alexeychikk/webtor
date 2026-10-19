/** Player keyboard shortcuts: the key → action mapping, kept pure; Player.svelte runs the actions. */

export type ShortcutAction =
  | { type: 'toggle-play' }
  | { type: 'seek'; by: number }
  | { type: 'fullscreen' }
  | { type: 'mute' }
  | { type: 'cycle-subtitles' };

/** Seconds ←/→ jump. */
export const SEEK_STEP_S = 5;

/** For the help tooltip, in display order. */
export const SHORTCUTS: readonly { keys: string; action: string }[] = [
  { keys: 'Space', action: 'Play / pause' },
  { keys: '← / →', action: `Back / forward ${SEEK_STEP_S} s` },
  { keys: 'F', action: 'Fullscreen' },
  { keys: 'M', action: 'Mute' },
  { keys: 'C', action: 'Next subtitle track (or off)' },
];

/** The parts of a `KeyboardEvent` (and its target) the mapping looks at. */
export interface ShortcutKey {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** `tagName` of the event target, e.g. `INPUT`. */
  targetTag?: string;
  targetEditable?: boolean;
  /**
   * The target is one of the player's own controls (its control bar). Those keep only the keys they
   * use (Space on a button, arrows on a slider); the other shortcuts still work there, as they do
   * on a browser's native video controls.
   */
  inPlayerControls?: boolean;
}

/** Targets that use these keys themselves: typing, picking an option, pressing a button. */
const OWN_KEYS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY', 'A']);

/** The action for a key press, or `null` to leave the key alone. */
export function shortcutFor(e: ShortcutKey): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.inPlayerControls) {
    const tag = e.targetTag?.toUpperCase();
    if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Spacebar')) return null;
    if (tag === 'INPUT' && e.key.startsWith('Arrow')) return null;
    return keyAction(e.key);
  }
  if (e.targetEditable || (e.targetTag && OWN_KEYS.has(e.targetTag.toUpperCase()))) return null;
  return keyAction(e.key);
}

function keyAction(key: string): ShortcutAction | null {
  switch (key) {
    case ' ':
    case 'Spacebar':
      return { type: 'toggle-play' };
    case 'ArrowLeft':
      return { type: 'seek', by: -SEEK_STEP_S };
    case 'ArrowRight':
      return { type: 'seek', by: SEEK_STEP_S };
    case 'f':
    case 'F':
      return { type: 'fullscreen' };
    case 'm':
    case 'M':
      return { type: 'mute' };
    case 'c':
    case 'C':
      return { type: 'cycle-subtitles' };
    default:
      return null;
  }
}

/** Seek target clamped to the media: never before 0 or past the end (an unknown end is no limit). */
export function seekTarget(current: number, by: number, duration: number): number {
  const end = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return Math.min(Math.max(0, current + by), end);
}
