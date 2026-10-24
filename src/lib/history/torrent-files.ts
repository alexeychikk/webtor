/**
 * Opened .torrent files kept for the watch history (docs/decisions/0010): their magnet has no
 * `xs=`, so without a peer it can't get the metadata again. IndexedDB db `webtor`, store
 * `torrent-files`, key = lower-case info hash, value `{ bytes, updated }`; at most
 * `MAX_TORRENT_FILES` and `MAX_TORRENT_FILE_BYTES` (`torrentFilesToEvict`). Every error is
 * ignored: the history entry then falls back to its magnet.
 */
import { torrentFilesToEvict, type StoredTorrentFile } from './history';

const DB = 'webtor';
const STORE = 'torrent-files';

interface Stored {
  bytes: Uint8Array;
  updated: number;
}

let db: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  db ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return db;
}

/** Runs `body` in one transaction; resolves with its result once committed, null on any error. */
async function tx<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T | null> {
  const d = await open();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const t = d.transaction(STORE, mode);
      let result: T | null = null;
      t.oncomplete = () => resolve(result);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
      body(t.objectStore(STORE), (v) => (result = v));
    } catch {
      resolve(null);
    }
  });
}

/** Every stored file's key, size and age. */
function listStored(store: IDBObjectStore, done: (files: StoredTorrentFile[]) => void) {
  const files: StoredTorrentFile[] = [];
  const req = store.openCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return done(files);
    const v = cursor.value as Partial<Stored> | undefined;
    files.push({
      key: String(cursor.key),
      size: v?.bytes?.byteLength ?? 0,
      updated: Number(v?.updated) || 0,
    });
    cursor.continue();
  };
}

/** Keeps the bytes of an opened .torrent, evicting the oldest beyond the limits. */
export async function saveTorrentFile(infoHash: string, bytes: Uint8Array): Promise<void> {
  const key = infoHash.toLowerCase();
  const value: Stored = { bytes: new Uint8Array(bytes), updated: Date.now() };
  await tx<true>('readwrite', (store, done) => {
    store.put(value, key);
    listStored(store, (files) => {
      for (const k of torrentFilesToEvict(files)) store.delete(k);
      done(true);
    });
  });
}

/** The stored .torrent of `infoHash`, or null (none, IndexedDB unavailable). */
export async function loadTorrentFile(infoHash: string): Promise<Uint8Array | null> {
  return tx<Uint8Array | null>('readonly', (store, done) => {
    const req = store.get(infoHash.toLowerCase());
    req.onsuccess = () => {
      const v = req.result as Partial<Stored> | undefined;
      done(v?.bytes instanceof Uint8Array ? v.bytes : null);
    };
  });
}

/** Drops every stored file whose info hash is not in `keep` (lower-case). */
export async function pruneTorrentFiles(keep: ReadonlySet<string>): Promise<void> {
  await tx<true>('readwrite', (store, done) => {
    listStored(store, (files) => {
      for (const f of files) if (!keep.has(f.key)) store.delete(f.key);
      done(true);
    });
  });
}
