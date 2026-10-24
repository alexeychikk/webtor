/**
 * Open state of the watch history popup (docs/decisions/0011): the header button and the `H` key
 * open it. `returnTo` gets the focus back when it closes.
 */
class HistoryDialogState {
  open = $state(false);
  /** Focused again on close: the header button, or what was focused when `H` opened it. */
  returnTo: HTMLElement | null = null;

  show(returnTo: Element | null = null) {
    this.returnTo = returnTo instanceof HTMLElement ? returnTo : null;
    this.open = true;
  }
}

export const historyDialog = new HistoryDialogState();
