/**
 * When to show the non-fatal `no-peers` and `stalled` notices (docs/decisions/0002). Pure: the
 * controller samples torrent stats once a second and asks this.
 */
export const NO_PEERS_AFTER_MS = 20_000;
export const STALLED_AFTER_MS = 30_000;

export interface WatchdogSample {
  /** ms since the torrent was added. */
  elapsed: number;
  hasMetadata: boolean;
  numPeers: number;
  /** ms the download speed has been 0 while the player waited for data (0 if not waiting). */
  starvedFor: number;
}

export type WatchdogNotice = 'no-peers' | 'stalled' | null;

export function watchdogNotice(s: WatchdogSample): WatchdogNotice {
  if (!s.hasMetadata) {
    return s.numPeers === 0 && s.elapsed >= NO_PEERS_AFTER_MS ? 'no-peers' : null;
  }
  return s.starvedFor >= STALLED_AFTER_MS ? 'stalled' : null;
}
