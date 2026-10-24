/**
 * The help dialog ("Why won't my torrent play?" plus the keyboard shortcuts): opened from the
 * header, the no-peers card, the stalled toast and the `?` key (which scrolls to the shortcuts), and
 * from the HDR toast (which scrolls to the HDR section).
 */
export type HelpSection = 'shortcuts' | 'hdr';

class HelpDialog {
  open = $state(false);
  /** A section to scroll to once open, or `null` for the top. */
  section = $state<HelpSection | null>(null);

  show(section: HelpSection | null = null) {
    this.section = section;
    this.open = true;
  }
}

export const helpDialog = new HelpDialog();
