/**
 * The page's single WebTorrent client, created on first use (the bundle is ~400 kB) and one active
 * torrent at a time (docs/decisions/0002).
 */
import type WebTorrentType from 'webtorrent/dist/webtorrent.min.js';
import type { Torrent } from 'webtorrent/dist/webtorrent.min.js';
import { canWriteOpfs, MemoryChunkStore } from './memory-store';
import { announceList, prepareTorrentId } from './trackers';

let clientPromise: Promise<WebTorrentType> | null = null;
/** Pieces go to OPFS (WebTorrent's default) unless this tab can't write there. */
let memoryOnly: Promise<boolean> | null = null;

function getClient(): Promise<WebTorrentType> {
  clientPromise ??= import('webtorrent/dist/webtorrent.min.js').then(({ default: WebTorrent }) => {
    const client = new WebTorrent();
    // Per-torrent errors arrive on the torrent; the rest (e.g. a tracker going away) is not fatal.
    client.on('error', (err) => console.warn('webtorrent:', err));
    return client;
  });
  return clientPromise;
}

/**
 * Asked right before `client.add`, after the previous torrents are gone: true when the playback
 * that wanted this torrent was replaced meanwhile. The add is then skipped (resolves `null`), so a
 * superseded load never adds a torrent that destroys, or duplicates, the current one.
 */
export type IsStale = () => boolean;

/** Adds a magnet / info hash (validated with `isTorrentId`), replacing any previous torrent. */
export async function addTorrent(input: string, isStale?: IsStale): Promise<Torrent | null> {
  const { torrentId, announce } = prepareTorrentId(input);
  return addTorrentId(torrentId, announce, [], undefined, isStale);
}

/** Adds a .torrent file the user opened, with the default WebSocket trackers on top of its own. */
export async function addTorrentFile(
  torrentFile: Uint8Array,
  isStale?: IsStale,
): Promise<Torrent | null> {
  return addTorrentId(torrentFile, announceList([]), [], undefined, isStale);
}

/**
 * Piece requests in flight per web seed with a relay. WebTorrent's default 4 caps a remote relay at
 * 4 pieces per round trip: ~7 MB/s with 256 KiB pieces at 100 ms (ADR 0006, "Throughput"). Over
 * HTTP/2 (the relay behind TLS) they share one connection; over HTTP/1.1 Chromium opens 6 at most.
 */
export const RELAY_WEB_CONNS = 16;

/**
 * Adds a .torrent fetched from the relay, with the magnet's WebSocket trackers (so WebRTC peers
 * still count) and the relay's web seed, replacing any previous torrent.
 */
export async function addRelayTorrent(
  torrentFile: Uint8Array,
  input: string,
  urlList: string[],
  isStale?: IsStale,
): Promise<Torrent | null> {
  return addTorrentId(
    torrentFile,
    prepareTorrentId(input).announce,
    urlList,
    RELAY_WEB_CONNS,
    isStale,
  );
}

async function addTorrentId(
  torrentId: string | Uint8Array,
  announce: string[],
  urlList: string[],
  maxWebConns?: number,
  isStale?: IsStale,
): Promise<Torrent | null> {
  memoryOnly ??= canWriteOpfs().then((ok) => !ok);
  const [client, inMemory] = await Promise.all([getClient(), memoryOnly]);
  // Also the ones a switch already destroys: re-adding the same torrent (A → B → A) must not
  // race the deletion of its store.
  await Promise.all([...client.torrents.map((t) => destroyTorrent(t)), ...destroying]);
  if (isStale?.()) return null;
  return client.add(torrentId, {
    // Already in memory: no extra piece cache in front of it.
    ...(inMemory ? { store: MemoryChunkStore, storeCacheSlots: 0 } : {}),
    announce,
    ...(urlList.length ? { urlList } : {}),
    ...(maxWebConns ? { maxWebConns } : {}),
    destroyStoreOnDestroy: true,
    // Nothing is downloaded until the media pipeline reads a byte range (file.stream).
    deselect: true,
  });
}

/**
 * How long a destroy may take before the next torrent goes ahead anyway. WebTorrent calls back only
 * once its store and trackers are closed, and an OPFS store whose cleanup throws (a piece write in
 * flight) never calls back at all; waiting for it left a switch on the landing view for good.
 */
export const DESTROY_TIMEOUT_MS = 3000;

/** Destroys in progress (each settles at the latest after `DESTROY_TIMEOUT_MS`). */
const destroying = new Set<Promise<void>>();
const destroys = new WeakMap<Torrent, Promise<void>>();

/**
 * Stops the torrent, drops it from the client and frees its OPFS/memory store. Resolves once that
 * is done or `timeoutMs` passed; calling it again for the same torrent returns the same promise
 * (WebTorrent never calls a second `destroy()` back).
 */
export function destroyTorrent(torrent: Torrent, timeoutMs = DESTROY_TIMEOUT_MS): Promise<void> {
  let done = destroys.get(torrent);
  if (done) return done;
  done = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`torrent ${torrent.infoHash}: destroy still pending after ${timeoutMs} ms`);
      resolve();
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    if (torrent.destroyed) return finish();
    try {
      torrent.destroy({ destroyStore: true }, finish);
    } catch (err) {
      console.warn('torrent destroy:', err);
      finish();
    }
  });
  const settled = done.then(() => void destroying.delete(settled));
  destroying.add(settled);
  destroys.set(torrent, done);
  return done;
}
