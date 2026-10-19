/**
 * Pure rules of the player's menus (docs/decisions/0008 §4): how a menu is presented, where a
 * panel sits, and how the arrow keys move between its items. Menu.svelte is the DOM glue.
 */

/** A screen at least this tall (px) shows menus as panels over the picture; else as a sheet. */
export const MENU_PANEL_MIN_SCREEN_HEIGHT = 352;

/** `panel`: glass panel inside the player screen; `sheet`: modal bottom sheet (`<dialog>`). */
export type MenuPresentation = 'panel' | 'sheet';

export function menuPresentation({
  screenHeight,
  fullscreen,
}: {
  screenHeight: number;
  fullscreen: boolean;
}): MenuPresentation {
  return fullscreen || screenHeight >= MENU_PANEL_MIN_SCREEN_HEIGHT ? 'panel' : 'sheet';
}

/**
 * Distance (px) of a panel's right edge from the screen's right edge: right-aligned under its
 * trigger (`anchorRight`, from the screen's left edge), clamped so the whole panel stays inside
 * the screen with `margin` on both sides.
 */
export function panelRight(
  anchorRight: number,
  panelWidth: number,
  screenWidth: number,
  margin = 8,
): number {
  const right = screenWidth - anchorRight;
  const max = Math.max(margin, screenWidth - panelWidth - margin);
  return Math.min(Math.max(right, margin), max);
}

/**
 * The item a key moves the focus to, among `count` enabled items with `current` focused (−1:
 * none): ↓/↑ the next/previous one (stopping at the ends), Home/End the first/last. `null` for
 * any other key or an empty list. Moving never selects (Enter/Space does).
 */
export function menuKeyTarget(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : Math.min(count - 1, current + 1);
    case 'ArrowUp':
      return current < 0 ? count - 1 : Math.max(0, current - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
