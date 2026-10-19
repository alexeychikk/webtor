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
