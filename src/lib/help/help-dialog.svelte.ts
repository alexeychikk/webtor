/** Whether the "Why won't my torrent play?" dialog is open; opened from the header and from notices. */
class HelpDialog {
  open = $state(false);
}

export const helpDialog = new HelpDialog();
