/**
 * The user's relay (docs/decisions/0006): its base URL in `localStorage['webtor:relay-url']`, and
 * whether the settings dialog is open. Without a relay set the app behaves as if relays didn't exist.
 */
import { checkRelayUrl } from './relay';

export const RELAY_URL_KEY = 'webtor:relay-url';

function load(): string | null {
  try {
    const stored = localStorage.getItem(RELAY_URL_KEY);
    if (!stored) return null;
    const check = checkRelayUrl(stored, location.protocol);
    return check.ok ? check.base : null;
  } catch {
    return null;
  }
}

class RelaySettings {
  /** Normalised base URL (`checkRelayUrl().base`), or `null` for no relay. */
  base = $state<string | null>(load());
  dialogOpen = $state(false);
  /** Pre-fills the dialog's URL field (e.g. an invalid `#relay=` value, so the user sees why). */
  draft = $state<string | null>(null);

  save(base: string | null) {
    this.base = base;
    try {
      if (base) localStorage.setItem(RELAY_URL_KEY, base);
      else localStorage.removeItem(RELAY_URL_KEY);
    } catch {
      // Storage disabled: the setting lasts for this page only.
    }
  }

  openDialog(draft: string | null = null) {
    this.draft = draft;
    this.dialogOpen = true;
  }
}

export const relaySettings = new RelaySettings();
