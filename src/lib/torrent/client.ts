/**
 * The page's single WebTorrent client, created on first use (the bundle is ~400 kB) and one active
 * torrent at a time (docs/decisions/0002).
 */
import type WebTorrentType from 'webtorrent/dist/webtorrent.min.js';
import type { Torrent } from 'webtorrent/dist/webtorrent.min.js';
import { prepareTorrentId } from './trackers';

let clientPromise: Promise<WebTorrentType> | null = null;

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
  const client = await getClient();
  await Promise.all(client.torrents.map(destroyTorrent));
  const { torrentId, announce } = prepareTorrentId(input);
  return client.add(torrentId, {
    announce,
    destroyStoreOnDestroy: true,
    // Nothing is downloaded until the media pipeline reads a byte range (file.stream).
    deselect: true,
  });
}

/** Stops the torrent, drops it from the client and frees its OPFS/memory store. */
export function destroyTorrent(torrent: Torrent): Promise<void> {
  return new Promise((resolve) => torrent.destroy({ destroyStore: true }, () => resolve()));
}
