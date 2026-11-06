import type { RelayStats } from '../torrent/relay';
import { formatSpeed } from './format';

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

/** Below this a relay rate counts as nothing (bytes/s): keep-alives and stats, no payload. */
export const RELAY_FLOW_MIN = 1024;

/** What the relay's `/stats` says about the data flow (api 3 rates, ADR 0006). */
export interface RelayFlow {
  activePeers: number;
  /** From the relay's peers, bytes/s. */
  download: number;
  /** From the relay to the browser, bytes/s. */
  served: number;
}

export type StalledNotice =
  | 'stalled'
  | 'relay-swarm-stalled'
  | 'relay-not-serving'
  | 'relay-swarm-slow'
  | 'relay-not-answering';

/** The stalled notices: a relay one says which side is stuck. */
export const STALLED_NOTICES: readonly StalledNotice[] = [
  'stalled',
  'relay-swarm-stalled',
  'relay-not-serving',
  'relay-swarm-slow',
  'relay-not-answering',
];

/** `/stats` polls in a row without an answer after which the relay's last stats count as stale. */
export const RELAY_STATS_MAX_MISSES = 2;

/**
 * The relay's data flow for `stalledNotice`: `unreachable` once its `/stats` went unanswered
 * `RELAY_STATS_MAX_MISSES` times in a row (its last rates are stale then), null without its rates
 * (api < 3).
 */
export function relayFlowOf(
  stats: RelayStats | null,
  misses: number,
): RelayFlow | 'unreachable' | null {
  if (misses >= RELAY_STATS_MAX_MISSES) return 'unreachable';
  if (!stats?.rates) return null;
  return {
    activePeers: stats.activePeers,
    download: stats.rates.download,
    served: stats.rates.served,
  };
}

/**
 * Which `stalled` notice to show: with a relay that reports its rates, the side that is stuck, and
 * the number for its message (`playbackErrorMessage`). Nothing from the relay's peers: the swarm
 * (`relay-swarm-stalled`, the peer count). The relay gets data but sends the browser none: the
 * relay (`relay-not-serving`, its download rate). Data reaches the browser, but no piece completed
 * in `STALLED_AFTER_MS`: a swarm too slow for the torrent's pieces (`relay-swarm-slow`, the rate).
 * The relay no longer answers `/stats`: the relay or the way to it (`relay-not-answering`).
 */
export function stalledNotice(relay: RelayFlow | 'unreachable' | null): {
  code: StalledNotice;
  detail?: string;
} {
  if (!relay) return { code: 'stalled' };
  if (relay === 'unreachable') return { code: 'relay-not-answering' };
  if (relay.served >= RELAY_FLOW_MIN) {
    return { code: 'relay-swarm-slow', detail: formatSpeed(relay.download) };
  }
  if (relay.download >= RELAY_FLOW_MIN) {
    return { code: 'relay-not-serving', detail: formatSpeed(relay.download) };
  }
  return { code: 'relay-swarm-stalled', detail: String(relay.activePeers) };
}

export interface StarvationSample {
  /** The player is waiting for data (opening the file or buffering). */
  waiting: boolean;
  /** `verifiedBytes(torrent)` now (only grows; `downloaded` drops when pieces are evicted). */
  downloaded: number;
  /** `verifiedBytes(torrent)` at the previous sample. */
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

/** Reopens in a row after stuck seeks (`onStuckSeek`, WebKit) before the open fails instead. */
export const MAX_REOPENS = 3;

/**
 * A seek got stuck (`onStuckSeek`): the number of this reopen in a row, or null when the open
 * fails instead (`playback-failed`, with Retry). `count` = reopens in a row so far; `recovered` =
 * the player the last reopen opened has since completed a seek or played on, which ends the row.
 */
export function nextReopen(count: number, recovered: boolean): number | null {
  const n = (recovered ? 0 : count) + 1;
  return n <= MAX_REOPENS ? n : null;
}
