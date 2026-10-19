import { shareUrl } from '../url-hash';

/** How long the share icon shows its check after a copy. */
export const COPIED_MS = 2000;

/**
 * "Copy share link" (the bar's `link` icon, or More's row): copies `#magnet=…&file=…`.
 * `failed`: no clipboard access; the player then opens a small panel with the link selected.
 */
export class ShareLink {
  state = $state<'idle' | 'copied' | 'failed'>('idle');
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly source: () => { magnet: string | null; fileIndex: number | null }) {}

  get url(): string {
    const { magnet, fileIndex } = this.source();
    return magnet ? shareUrl(location, magnet, fileIndex) : '';
  }

  /** Resolves to whether the link reached the clipboard. */
  async copy(): Promise<boolean> {
    clearTimeout(this.#timer);
    try {
      await navigator.clipboard.writeText(this.url);
      this.state = 'copied';
      this.#timer = setTimeout(() => (this.state = 'idle'), COPIED_MS);
      return true;
    } catch {
      this.state = 'failed';
      return false;
    }
  }

  dispose() {
    clearTimeout(this.#timer);
  }
}
