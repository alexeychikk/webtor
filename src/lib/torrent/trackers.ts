/**
 * WebSocket trackers injected into every torrent. Browsers can only reach WebRTC peers, and those are
 * only discoverable through WebSocket trackers (no DHT, no UDP/HTTP trackers, no PEX to TCP peers).
 *
 * Checked 2026-10-18 via scrape from the sandbox: tracker.webtorrent.dev answered; openwebtorrent timed
 * out; btorrent.xyz and files.fm refused. Keep dead ones out — each failing tracker costs a reconnect loop.
 * Source list worth re-checking: https://github.com/ngosang/trackerslist (trackers_all_ws.txt).
 */
export const DEFAULT_WS_TRACKERS: readonly string[] = [
  'wss://tracker.webtorrent.dev',
  'wss://tracker.openwebtorrent.com',
];

const INFO_HASH_HEX = /^[0-9a-f]{40}$/i;
const INFO_HASH_BASE32 = /^[a-z2-7]{32}$/i;

/** True for a `magnet:?xt=urn:btih:` URI or a bare 40-hex / 32-base32 info hash. */
export function isTorrentId(input: string): boolean {
  const s = input.trim();
  if (INFO_HASH_HEX.test(s) || INFO_HASH_BASE32.test(s)) return true;
  if (!s.toLowerCase().startsWith('magnet:?')) return false;
  const xt = new URLSearchParams(s.slice('magnet:?'.length)).getAll('xt');
  return xt.some((v) => /^urn:btih:/i.test(v));
}

/** Trackers to announce to: the torrent's own `ws(s)://` trackers first, then the defaults, deduplicated. */
export function announceList(torrentTrackers: readonly string[]): string[] {
  const ws = torrentTrackers.filter((t) => /^wss?:\/\//i.test(t));
  return [...new Set([...ws, ...DEFAULT_WS_TRACKERS])];
}

export interface PreparedTorrentId {
  /** Magnet to hand to `client.add`: the input with non-WebSocket `tr=` entries dropped. */
  torrentId: string;
  /** `announce` option for `client.add`: the magnet's WebSocket trackers plus the defaults. */
  announce: string[];
}

/**
 * Turns user input (magnet or bare info hash; check `isTorrentId` first) into what `client.add` needs.
 * UDP/HTTP trackers are unreachable from a page, so they are removed instead of failing on every
 * announce. Everything else (`xs=`, `ws=`, `dn=`, …) is kept byte-for-byte.
 */
export function prepareTorrentId(input: string): PreparedTorrentId {
  const s = input.trim();
  if (!s.toLowerCase().startsWith('magnet:?')) {
    return { torrentId: `magnet:?xt=urn:btih:${s.toLowerCase()}`, announce: announceList([]) };
  }
  const trackers: string[] = [];
  const kept = s
    .slice('magnet:?'.length)
    .split('&')
    .filter((part) => {
      if (!part.toLowerCase().startsWith('tr=')) return part !== '';
      let url: string;
      try {
        url = decodeURIComponent(part.slice(3).replace(/\+/g, ' '));
      } catch {
        return false;
      }
      trackers.push(url);
      return /^wss?:\/\//i.test(url);
    });
  return { torrentId: `magnet:?${kept.join('&')}`, announce: announceList(trackers) };
}
