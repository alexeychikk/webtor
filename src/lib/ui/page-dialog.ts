import { exitFullscreen, fullscreenElement } from '../player/fullscreen';

/**
 * Opens a page dialog (relay settings, help) as a modal. From inside the fullscreen player it
 * leaves fullscreen first (docs/decisions/0008 §5): the dialog belongs to the page, not the player.
 * `wanted` is asked again after that, in case the dialog was closed meanwhile. Resolves once shown.
 */
export async function showPageDialog(
  dialog: HTMLDialogElement,
  wanted: () => boolean,
): Promise<void> {
  if (fullscreenElement()) await exitFullscreen().catch(() => {});
  if (wanted() && !dialog.open) dialog.showModal();
}

/** The point lies outside the box: on a modal dialog's backdrop. */
export const outsideRect = (r: DOMRectReadOnly, x: number, y: number) =>
  x < r.left || x >= r.right || y < r.top || y >= r.bottom;

/**
 * Closes `dialog` (via `close`) on a click on its backdrop: a press and a release both outside its
 * box, so a text selection dragged out of it doesn't close it. Clicks on the backdrop target the
 * dialog itself. Returns the cleanup.
 */
export function closeOnBackdrop(dialog: HTMLDialogElement, close: () => void): () => void {
  const outside = (e: MouseEvent) =>
    e.target === dialog && outsideRect(dialog.getBoundingClientRect(), e.clientX, e.clientY);
  let pressedOutside = false;
  const down = (e: PointerEvent) => (pressedOutside = outside(e));
  const click = (e: MouseEvent) => {
    if (pressedOutside && outside(e)) close();
    pressedOutside = false;
  };
  dialog.addEventListener('pointerdown', down);
  dialog.addEventListener('click', click);
  return () => {
    dialog.removeEventListener('pointerdown', down);
    dialog.removeEventListener('click', click);
  };
}
