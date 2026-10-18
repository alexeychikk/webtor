/**
 * In-memory abstract-chunk-store, for browsers whose OPFS can't be written (Safari private
 * browsing, some embedded WebKit builds): WebTorrent picks OPFS whenever `createWritable` exists,
 * and every write then fails. Mirrors `memory-chunk-store`, which the prebuilt bundle doesn't export.
 */
type Callback<T = void> = (err: Error | null, value?: T) => void;

const later = (fn: () => void) => queueMicrotask(fn);

export class MemoryChunkStore {
  readonly chunkLength: number;
  private readonly lastIndex: number;
  private readonly lastChunkLength: number;
  private chunks: (Uint8Array | undefined)[] = [];
  private closed = false;

  constructor(chunkLength: number, opts: { length?: number } = {}) {
    this.chunkLength = Number(chunkLength);
    if (!this.chunkLength) throw new Error('First argument must be a chunk length');
    const length = Number(opts.length) || Infinity;
    this.lastChunkLength = length % this.chunkLength || this.chunkLength;
    this.lastIndex = Number.isFinite(length) ? Math.ceil(length / this.chunkLength) - 1 : Infinity;
  }

  put(index: number, buf: Uint8Array, cb: Callback = () => {}) {
    if (this.closed) return later(() => cb(new Error('Storage is closed')));
    const expected = index === this.lastIndex ? this.lastChunkLength : this.chunkLength;
    if (buf.length !== expected) {
      return later(() => cb(new Error(`Chunk length must be ${expected}`)));
    }
    this.chunks[index] = buf;
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
    const buf = this.chunks[index];
    if (!buf) {
      const err = Object.assign(new Error('Chunk not found'), { notFound: true });
      return later(() => done(err));
    }
    const offset = opts?.offset ?? 0;
    const length = opts?.length ?? buf.length - offset;
    const out = offset === 0 && length === buf.length ? buf : buf.subarray(offset, offset + length);
    later(() => done(null, out));
  }

  close(cb: Callback = () => {}) {
    if (this.closed) return later(() => cb(new Error('Storage is closed')));
    this.closed = true;
    this.chunks = [];
    later(() => cb(null));
  }

  destroy(cb: Callback = () => {}) {
    this.close(cb);
  }
}

/** Whether this tab can write to OPFS (what WebTorrent's default browser store needs). */
export async function canWriteOpfs(): Promise<boolean> {
  const storage = globalThis.navigator?.storage;
  if (!storage?.getDirectory || !globalThis.FileSystemFileHandle?.prototype?.createWritable) {
    return true; // WebTorrent picks its memory store by itself.
  }
  const name = `webtor-probe-${Math.random().toString(36).slice(2)}`;
  try {
    const root = await storage.getDirectory();
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Uint8Array([1]));
    await writable.close();
    await root.removeEntry(name);
    return true;
  } catch (err) {
    console.warn('OPFS not writable, keeping pieces in memory:', err);
    return false;
  }
}
