/** Player keyboard shortcuts: the key → action mapping, kept pure; Player.svelte runs the actions. */

export type ShortcutAction =
  | { type: 'toggle-play' }
  | { type: 'seek'; by: number }
  | { type: 'fullscreen' }
  | { type: 'mute' }
  | { type: 'volume'; by: number }
  | { type: 'cycle-subtitles' }
  | { type: 'help' }
  | { type: 'history' };

/** Seconds ←/→ jump. */
export const SEEK_STEP_S = 5;
/** Volume ↑/↓ step (volume is 0–1). */
export const VOLUME_STEP = 0.1;

/** For the help tooltip, in display order. */
export const SHORTCUTS: readonly { keys: string; action: string }[] = [
  { keys: 'Space', action: 'Play / pause' },
  { keys: '← / →', action: `Back / forward ${SEEK_STEP_S} s` },
  { keys: '↑ / ↓', action: 'Volume up / down' },
  { keys: 'F', action: 'Fullscreen' },
  { keys: 'M', action: 'Mute' },
  { keys: 'C', action: 'Next subtitle track (or off)' },
  { keys: 'H', action: 'Watch history' },
  { keys: '?', action: 'Keyboard shortcuts' },
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
   * The target is one of the player's own controls (its control bar). The shortcuts work there, as
   * on a browser's native video controls; only a slider keeps its arrows. Space plays/pauses even
   * on a button (the caller then cancels the button's own Space activation).
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
    case 'ArrowUp':
      return { type: 'volume', by: VOLUME_STEP };
    case 'ArrowDown':
      return { type: 'volume', by: -VOLUME_STEP };
    case 'f':
    case 'F':
      return { type: 'fullscreen' };
    case 'm':
    case 'M':
      return { type: 'mute' };
    case 'c':
    case 'C':
      return { type: 'cycle-subtitles' };
    case 'h':
    case 'H':
      return { type: 'history' };
    case '?':
      return { type: 'help' };
    default:
      return null;
  }
}

/** Whether a held key's auto-repeat runs the action again: seeking and volume, yes; toggles, never. */
export function repeats(action: ShortcutAction): boolean {
  return action.type === 'seek' || action.type === 'volume';
}

/** New volume after a ↑/↓ step, clamped to [0, 1] and rounded to the step (no 0.30000000000000004). */
export function volumeTarget(current: number, by: number): number {
  return Math.round(Math.min(1, Math.max(0, current + by)) * 100) / 100;
}

/** Seek target clamped to the media: never before 0 or past the end (an unknown end is no limit). */
export function seekTarget(current: number, by: number, duration: number): number {
  const end = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return Math.min(Math.max(0, current + by), end);
}
