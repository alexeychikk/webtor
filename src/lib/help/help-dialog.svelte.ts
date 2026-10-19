/**
 * The help dialog ("Why won't my torrent play?" plus the keyboard shortcuts): opened from the
 * header, the no-peers card, the stalled toast and the `?` key (which scrolls to the shortcuts).
 */
class HelpDialog {
  open = $state(false);
  /** A section to scroll to once open (`shortcuts`), or `null` for the top. */
  section = $state<'shortcuts' | null>(null);

  show(section: 'shortcuts' | null = null) {
    this.section = section;
    this.open = true;
  }
}

export const helpDialog = new HelpDialog();
