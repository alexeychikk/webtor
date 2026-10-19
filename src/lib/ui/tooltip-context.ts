import { getContext, setContext } from 'svelte';

/**
 * Whether the control layer an icon button sits in is shown. Its tooltip goes away when the
 * controls hide (docs/decisions/0008). Buttons outside a player see "always shown".
 */
const KEY = Symbol('webtor:controls-shown');

export function provideControlsShown(shown: () => boolean) {
  setContext(KEY, shown);
}

export function controlsShown(): () => boolean {
  return getContext<(() => boolean) | undefined>(KEY) ?? (() => true);
}

/** Horizontal shift that keeps `[left, right]` inside `[min, max]` (with `margin`); pure. */
export function clampShift(left: number, right: number, min: number, max: number, margin = 8) {
  if (left < min + margin) return min + margin - left;
  if (right > max - margin) return Math.max(min + margin - left, max - margin - right);
  return 0;
}
