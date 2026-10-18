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

/** Adds a magnet / info hash (validated with `isTorrentId`), replacing any previous torrent. */
export async function addTorrent(input: string): Promise<Torrent> {
  const { torrentId, announce } = prepareTorrentId(input);
  return addTorrentId(torrentId, announce, []);
}

/** Adds a .torrent file the user opened, with the default WebSocket trackers on top of its own. */
export async function addTorrentFile(torrentFile: Uint8Array): Promise<Torrent> {
  return addTorrentId(torrentFile, announceList([]), []);
}

/**
 * Adds a .torrent fetched from the relay, with the magnet's WebSocket trackers (so WebRTC peers
 * still count) and the relay's web seed, replacing any previous torrent.
 */
export async function addRelayTorrent(
  torrentFile: Uint8Array,
  input: string,
  urlList: string[],
): Promise<Torrent> {
  return addTorrentId(torrentFile, prepareTorrentId(input).announce, urlList);
}

async function addTorrentId(
  torrentId: string | Uint8Array,
  announce: string[],
  urlList: string[],
): Promise<Torrent> {
  memoryOnly ??= canWriteOpfs().then((ok) => !ok);
  const [client, inMemory] = await Promise.all([getClient(), memoryOnly]);
  await Promise.all(client.torrents.map(destroyTorrent));
  return client.add(torrentId, {
    // Already in memory: no extra piece cache in front of it.
    ...(inMemory ? { store: MemoryChunkStore, storeCacheSlots: 0 } : {}),
    announce,
    ...(urlList.length ? { urlList } : {}),
    destroyStoreOnDestroy: true,
    // Nothing is downloaded until the media pipeline reads a byte range (file.stream).
    deselect: true,
  });
}

/** Stops the torrent, drops it from the client and frees its OPFS/memory store. */
export function destroyTorrent(torrent: Torrent): Promise<void> {
  return new Promise((resolve) => torrent.destroy({ destroyStore: true }, () => resolve()));
}
