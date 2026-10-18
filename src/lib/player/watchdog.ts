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
  /** ms without any received bytes while the player waited for data (see `nextStarvedFor`). */
  starvedFor: number;
}

export type WatchdogNotice = 'no-peers' | 'stalled' | null;

export function watchdogNotice(s: WatchdogSample): WatchdogNotice {
  if (!s.hasMetadata) {
    return s.numPeers === 0 && s.elapsed >= NO_PEERS_AFTER_MS ? 'no-peers' : null;
  }
  return s.starvedFor >= STALLED_AFTER_MS ? 'stalled' : null;
}

export interface StarvationSample {
  /** The player is waiting for data (opening the file or buffering). */
  waiting: boolean;
  /** `torrent.downloaded` now. */
  downloaded: number;
  /** `torrent.downloaded` at the previous sample. */
  lastDownloaded: number;
  /** ms since the previous sample. */
  dt: number;
}

/**
 * Next `starvedFor`: grows while the player waits and no bytes arrive. Counted from bytes actually
 * received, not from `downloadSpeed`: a failing web seed is retried every ~10 s, and each attempt
 * blips the speed estimate above 0 without delivering any payload.
 */
export function nextStarvedFor(starvedFor: number, s: StarvationSample): number {
  if (!s.waiting || s.downloaded > s.lastDownloaded) return 0;
  return starvedFor + s.dt;
}
