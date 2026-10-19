/**
 * URL contract with the user-run Go relay (`relay/`, docs/decisions/0006). Pure helpers only; the
 * fetch glue is `relay-client.ts`, the setting `relay-settings.svelte.ts`.
 *
 * A relay URL is `scheme://host[:port]/<token>` — the token is the password, keep it out of logs.
 */
import type { TorrentStats } from '../player/types';

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
  /** `GET` → `{name: 'webtor-relay', version, api: 2, transcode: {available, ffmpeg, …}}`. */
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
  /**
   * `GET` → fragmented MP4 (H.264, no audio) of file `fileIndex` from element time `start` on, its
   * timestamps starting at 0 (api 2, ADR 0007 §2). Errors: 503 `transcode-unavailable`, 429
   * `transcode-busy`, 422 `transcode-failed`.
   */
  transcode(fileIndex: number, start: number): string;
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
    // Millisecond precision is plenty for ffmpeg's `-ss` and keeps the URL readable.
    transcode: (fileIndex, start) =>
      `${t}/transcode/${fileIndex}?start=${Math.max(0, Math.round(start * 1000) / 1000)}`,
  };
}

/** Messages for `checkRelayUrl` failures, shown under the URL field. */
export const RELAY_URL_PROBLEMS: Record<Exclude<RelayUrlCheck, { ok: true }>['reason'], string> = {
  invalid: 'That is not a relay URL. Paste the "Relay URL" line webtor-relay printed.',
  'no-token':
    'The URL needs the secret token path webtor-relay printed, like http://127.0.0.1:7881/<token>.',
  'mixed-content':
    'This page is served over HTTPS, so a relay on another machine needs an https:// URL (put it ' +
    'behind TLS). Plain http:// only works for 127.0.0.1 or localhost.',
};

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32ToHex(s: string): string | null {
  let bits = '';
  for (const c of s.toLowerCase()) {
    const v = BASE32.indexOf(c);
    if (v < 0) return null;
    bits += v.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4)
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

function normaliseInfoHash(s: string): string | null {
  if (/^[0-9a-f]{40}$/i.test(s)) return s.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(s)) return base32ToHex(s);
  return null;
}

/**
 * What the relay needs from user input (check `isTorrentId` first): the info hash as 40 hex digits
 * (base32 converted) and the magnet's query string, untouched, so the relay sees every `tr=` (UDP
 * and HTTP too), `dn=`, `x.pe=` and `ws=`. `ws` lists the magnet's own web seeds for WebTorrent.
 */
export function relayTorrentRef(
  input: string,
): { infoHash: string; magnetQuery: string; ws: string[] } | null {
  const s = input.trim();
  if (!s.toLowerCase().startsWith('magnet:?')) {
    const infoHash = normaliseInfoHash(s);
    return infoHash ? { infoHash, magnetQuery: `xt=urn:btih:${infoHash}`, ws: [] } : null;
  }
  const magnetQuery = s.slice('magnet:?'.length);
  const params = new URLSearchParams(magnetQuery);
  for (const xt of params.getAll('xt')) {
    const m = /^urn:btih:(.+)$/i.exec(xt);
    const infoHash = m ? normaliseInfoHash(m[1]!) : null;
    if (infoHash) {
      return { infoHash, magnetQuery, ws: params.getAll('ws').filter((u) => /^https?:/i.test(u)) };
    }
  }
  return null;
}

/** How a call to the relay went wrong; `relayErrorCode` turns it into what the user sees. */
export type RelayFailure =
  /** `fetch` rejected: relay not running, wrong host/port, CORS, or a denied Local Network Access prompt. */
  | { kind: 'network' }
  /** Our own deadline passed before the relay answered. */
  | { kind: 'timeout' }
  | { kind: 'http'; status: number; message?: string }
  /** 200, but not what a webtor-relay sends (e.g. the URL points at some other web server). */
  | { kind: 'bad-response' };

export type RelayErrorCode =
  | 'relay-unreachable'
  | 'relay-no-metadata'
  | 'relay-busy'
  | 'relay-error'
  | 'relay-transcode-unavailable'
  | 'relay-transcode-busy'
  | 'relay-transcode-failed';

/**
 * Error code for a failed metainfo fetch. 504 is the relay saying the swarm gave no metadata; 429
 * is its `-max-torrents` limit.
 */
export function relayErrorCode(f: RelayFailure): RelayErrorCode {
  if (f.kind === 'network') return 'relay-unreachable';
  if (f.kind === 'timeout') return 'relay-no-metadata';
  if (f.kind === 'http' && f.status === 504) return 'relay-no-metadata';
  if (f.kind === 'http' && f.status === 429) return 'relay-busy';
  return 'relay-error';
}

/**
 * Error code for a failed `…/transcode/{file}` request (ADR 0007 §2). The relay's JSON `error` names
 * the case; 504 means its swarm sent no input in time.
 */
export function relayTranscodeErrorCode(f: RelayFailure): RelayErrorCode {
  if (f.kind === 'network') return 'relay-unreachable';
  if (f.kind === 'timeout') return 'relay-transcode-failed';
  if (f.kind !== 'http') return 'relay-error';
  if (f.status === 503 && f.message === 'transcode-unavailable') {
    return 'relay-transcode-unavailable';
  }
  if (f.status === 429) return 'relay-transcode-busy';
  if (f.status === 422 || f.status === 504) return 'relay-transcode-failed';
  return 'relay-error';
}

/**
 * The relay doesn't have the torrent (any more): it restarted, or dropped the torrent after its idle
 * timeout (e.g. a long pause). Registering it again (metainfo) and retrying once recovers.
 */
export function relayTorrentMissing(f: RelayFailure): boolean {
  return f.kind === 'http' && f.status === 404 && /^torrent not added/.test(f.message ?? '');
}

/** Technical detail appended to the message (never contains the relay URL: the token is a password). */
export function relayErrorDetail(f: RelayFailure): string | undefined {
  if (f.kind === 'http') {
    const hint = f.status === 404 ? ' — wrong token or not a webtor-relay?' : '';
    return `HTTP ${f.status}${f.message ? `: ${f.message}` : ''}${hint}`;
  }
  if (f.kind === 'bad-response') return 'unexpected response — is this a webtor-relay URL?';
  return undefined;
}

/** `/v1/info`'s `transcode` object (api 2): can this relay convert video with ffmpeg? */
export interface RelayTranscodeInfo {
  available: boolean;
  /** ffmpeg version, `''` when unavailable. */
  ffmpeg: string;
  maxHeight: number;
  preset: string;
}

export interface RelayInfo {
  name: 'webtor-relay';
  version: string;
  api: number;
  /** Relays before api 2 have no video conversion: `available: false`. */
  transcode: RelayTranscodeInfo;
}

const NO_TRANSCODE: RelayTranscodeInfo = { available: false, ffmpeg: '', maxHeight: 0, preset: '' };

/** Validates `GET /v1/info`; `null` when the body isn't a webtor-relay's. */
export function parseRelayInfo(json: unknown): RelayInfo | null {
  if (typeof json !== 'object' || json === null) return null;
  const { name, version, api, transcode } = json as Record<string, unknown>;
  if (name !== 'webtor-relay' || typeof api !== 'number') return null;
  return {
    name,
    version: typeof version === 'string' ? version : '?',
    api,
    transcode: parseTranscodeInfo(transcode),
  };
}

function parseTranscodeInfo(json: unknown): RelayTranscodeInfo {
  if (typeof json !== 'object' || json === null) return NO_TRANSCODE;
  const { available, ffmpeg, maxHeight, preset } = json as Record<string, unknown>;
  if (available !== true) return NO_TRANSCODE;
  return {
    available: true,
    ffmpeg: typeof ffmpeg === 'string' ? ffmpeg : '',
    maxHeight: typeof maxHeight === 'number' ? maxHeight : 0,
    preset: typeof preset === 'string' ? preset : '',
  };
}

/** One line for the relay dialog: whether (and how) the relay converts DivX/Xvid video. */
export function transcodeSummary(t: RelayTranscodeInfo): string {
  if (!t.available) {
    return 'Video conversion: off. To play DivX/Xvid AVIs, install ffmpeg on the relay’s computer and restart it.';
  }
  const details = [t.ffmpeg && `ffmpeg ${t.ffmpeg}`, t.maxHeight > 0 && `up to ${t.maxHeight}p`]
    .filter(Boolean)
    .join(', ');
  return `Video conversion: on${details ? ` (${details})` : ''}.`;
}

/** The part of `GET …/stats` the UI uses. */
export interface RelayStats {
  /** Peers the relay is connected to right now. */
  activePeers: number;
  seeders: number;
  hasMetadata: boolean;
}

export function parseRelayStats(json: unknown): RelayStats | null {
  if (typeof json !== 'object' || json === null) return null;
  const { activePeers, seeders, hasMetadata } = json as Record<string, unknown>;
  if (typeof activePeers !== 'number') return null;
  return {
    activePeers,
    seeders: typeof seeders === 'number' ? seeders : 0,
    hasMetadata: hasMetadata === true,
  };
}

/**
 * Peer count to show with a relay. WebTorrent sees the relay as one web-seed wire; the swarm behind
 * it is in the relay's `/stats`. So: WebTorrent's wires minus its web seeds, plus the relay's peers.
 * Speeds and progress stay WebTorrent's (everything the page gets passes through it).
 */
export function mergeRelayStats(
  base: TorrentStats,
  webSeedWires: number,
  relay: RelayStats | null,
): TorrentStats {
  if (!relay) return base;
  return {
    ...base,
    numPeers: Math.max(0, base.numPeers - webSeedWires) + relay.activePeers,
    relayPeers: relay.activePeers,
  };
}
