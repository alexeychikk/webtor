/**
 * URL contract with the user-run Go relay (`relay/`, docs/decisions/0006). Pure helpers only; the
 * settings UI and the controller wiring build on these.
 *
 * A relay URL is `scheme://host[:port]/<token>` — the token is the password, keep it out of logs.
 */

export type RelayUrlCheck =
  { ok: true; base: string } | { ok: false; reason: 'invalid' | 'mixed-content' | 'no-token' };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Normalises a pasted relay URL (trims, drops a trailing slash) and checks that a page served from
 * `pageProtocol` may call it: HTTPS pages can only reach `https:` relays, or `http:` on loopback
 * (Chrome and Firefox; Safari blocks even that, which is why the relay also serves the app).
 */
export function checkRelayUrl(input: string, pageProtocol: string): RelayUrlCheck {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, reason: 'invalid' };
  if (url.search || url.hash || url.username || url.password)
    return { ok: false, reason: 'invalid' };
  const path = url.pathname.replace(/\/+$/, '');
  if (!/^\/[^/]{8,}$/.test(path)) return { ok: false, reason: 'no-token' };
  if (pageProtocol === 'https:' && url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, reason: 'mixed-content' };
  }
  return { ok: true, base: `${url.origin}${path}` };
}

export interface RelayEndpoints {
  /** `GET` → `{name: 'webtor-relay', version, api: 1}`. */
  info: string;
  /**
   * `GET` → .torrent (info dict only) once the swarm delivered it; 504 after ~90 s without; 429
   * `{error, maxTorrents}` when the relay already has its maximum of torrents open.
   */
  metainfo: string;
  /** `GET` → `[{index, path, length, webseedPath}]` (503 before metainfo). */
  files: string;
  /** `GET` → `{peers, activePeers, seeders, hasMetadata, bytesCompleted, …}`. */
  stats: string;
  /** BEP-19 web seed URL for WebTorrent's `urlList`. */
  webseed: string;
}

/**
 * Relay URLs for one torrent. `magnetQuery` is the magnet's query string (after `magnet:?`), passed
 * through untouched: the relay needs every `tr=` (UDP/HTTP too), `dn=`, `x.pe=` and `ws=`.
 */
export function relayEndpoints(
  base: string,
  infoHashHex: string,
  magnetQuery = '',
): RelayEndpoints {
  const t = `${base}/v1/torrents/${infoHashHex.toLowerCase()}`;
  return {
    info: `${base}/v1/info`,
    metainfo: magnetQuery ? `${t}/metainfo?${magnetQuery}` : `${t}/metainfo`,
    files: `${t}/files`,
    stats: `${t}/stats`,
    webseed: `${t}/webseed/`,
  };
}
