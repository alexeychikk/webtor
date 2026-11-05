/**
 * The piece store of every torrent: an abstract-chunk-store in memory that the playback window
 * keeps bounded (`piece-window.ts`, docs/decisions/0012). Mirrors `memory-chunk-store`, which the
 * prebuilt bundle doesn't export, plus `delete` and the byte count for eviction.
 */
type Callback<T = void> = (err: Error | null, value?: T) => void;

const later = (fn: () => void) => queueMicrotask(fn);

/** The store WebTorrent created for a torrent (it passes itself as `opts.torrent`). */
const stores = new WeakMap<object, MemoryChunkStore>();

export function storeOf(torrent: object): MemoryChunkStore | undefined {
  return stores.get(torrent);
}

export class MemoryChunkStore {
  readonly chunkLength: number;
  private readonly lastIndex: number;
  private readonly lastChunkLength: number;
  private chunks = new Map<number, Uint8Array>();
  private closed = false;
  /** Bytes held. */
  bytes = 0;

  constructor(chunkLength: number, opts: { length?: number; torrent?: object } = {}) {
    this.chunkLength = Number(chunkLength);
    if (!this.chunkLength) throw new Error('First argument must be a chunk length');
    const length = Number(opts.length) || Infinity;
    this.lastChunkLength = length % this.chunkLength || this.chunkLength;
    this.lastIndex = Number.isFinite(length) ? Math.ceil(length / this.chunkLength) - 1 : Infinity;
    if (opts.torrent) stores.set(opts.torrent, this);
  }

  put(index: number, buf: Uint8Array, cb: Callback = () => {}) {
    if (this.closed) return later(() => cb(new Error('Storage is closed')));
    const expected = index === this.lastIndex ? this.lastChunkLength : this.chunkLength;
    if (buf.length !== expected) {
      return later(() => cb(new Error(`Chunk length must be ${expected}`)));
    }
    this.delete(index);
    this.chunks.set(index, buf);
    this.bytes += buf.length;
    later(() => cb(null));
  }

  get(
    index: number,
    opts: { offset?: number; length?: number } | null | Callback<Uint8Array>,
    cb?: Callback<Uint8Array>,
  ): void {
    if (typeof opts === 'function') return this.get(index, null, opts);
    const done = cb ?? (() => {});
    if (this.closed) return later(() => done(new Error('Storage is closed')));
    const buf = this.chunks.get(index);
    if (!buf) {
      const err = Object.assign(new Error('Chunk not found'), { notFound: true });
      return later(() => done(err));
    }
    const offset = opts?.offset ?? 0;
    const length = opts?.length ?? buf.length - offset;
    const out = offset === 0 && length === buf.length ? buf : buf.subarray(offset, offset + length);
    later(() => done(null, out));
  }

  /** Indices of the chunks held. */
  indices(): number[] {
    return [...this.chunks.keys()];
  }

  /** Drops a chunk (eviction); a later `get` of it is "not found". */
  delete(index: number) {
    const buf = this.chunks.get(index);
    if (!buf) return;
    this.chunks.delete(index);
    this.bytes -= buf.length;
  }

  close(cb: Callback = () => {}) {
    if (this.closed) return later(() => cb(new Error('Storage is closed')));
    this.closed = true;
    this.chunks.clear();
    this.bytes = 0;
    later(() => cb(null));
  }

  destroy(cb: Callback = () => {}) {
    this.close(cb);
  }
}

/**
 * Removes what earlier versions left in OPFS (WebTorrent's default store kept every piece there,
 * one directory per torrent, and never cleared it on a reload). Errors are ignored.
 */
export function clearOpfs(): Promise<void> {
  return removeOpfsEntries().catch(() => {});
}

async function removeOpfsEntries() {
  const root = (await globalThis.navigator?.storage?.getDirectory?.()) as
    (FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }) | undefined;
  if (!root?.keys) return;
  const names: string[] = [];
  for await (const name of root.keys()) names.push(name);
  await Promise.all(names.map((n) => root.removeEntry(n, { recursive: true }).catch(() => {})));
}
