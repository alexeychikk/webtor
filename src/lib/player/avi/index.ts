/**
 * Where an AVI's chunks are (ADR 0007 §1 "Index and torrent reads"). Three sources, one shape: a
 * `ChunkTable` per stream that may still grow.
 *
 * - `idx1`: read whole at open (`StaticIndex`).
 * - OpenDML: the `indx` super index lists `ix##` standard index chunks, which can sit in any of
 *   the file's `RIFF`s (files over 1 GB continue with `RIFF AVIX`). They load lazily, in order,
 *   one per `grow` (`OdmlIndex`).
 * - No usable index: `movi` is scanned chunk header by chunk header as playback reads forward
 *   (`ScanIndex`), into the `AVIX` RIFFs too. Seeking then stays within the scanned part.
 */
import type { BlockReader } from './block-reader';
import { ChunkTable, parseStdIndex, readFourCC, streamOf, type AviStreamHeader } from './riff';

export type IndexMode = 'idx1' | 'odml' | 'scan';

export interface AviIndex {
  readonly mode: IndexMode;
  /** Per stream (by stream number), in file order. */
  readonly tables: readonly ChunkTable[];
  /** No more chunks will be added to stream `s`. */
  complete(s: number): boolean;
  /**
   * Adds the next part of stream `s`'s chunks: OpenDML its next `ix##`; the scan the next stretch
   * of `movi` (for every stream). Resolves at once when complete.
   */
  grow(s: number): Promise<void>;
  /** Stream ticks the whole index covers, known before it is loaded (OpenDML), else null. */
  totalTicks(s: number): number | null;
}

type Read = (start: number, end: number) => Promise<Uint8Array>;

const u32 = (b: Uint8Array, o: number) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);

/** `idx1`: complete from the start. */
export class StaticIndex implements AviIndex {
  readonly mode = 'idx1';
  constructor(readonly tables: readonly ChunkTable[]) {}
  complete() {
    return true;
  }
  async grow() {}
  totalTicks() {
    return null;
  }
}

/** OpenDML: one `ix##` chunk per `grow`, in super index order. */
export class OdmlIndex implements AviIndex {
  readonly mode = 'odml';
  readonly tables: ChunkTable[];
  /** Next super index entry to load, per stream. */
  private readonly next: number[];
  private readonly jobs = new Map<number, Promise<void>>();

  constructor(
    private readonly streams: readonly AviStreamHeader[],
    private readonly read: Read,
  ) {
    this.tables = streams.map(() => new ChunkTable());
    this.next = streams.map(() => 0);
  }

  private entries(s: number) {
    return this.streams[s]?.superIndex ?? [];
  }

  complete(s: number) {
    return (this.next[s] ?? 0) >= this.entries(s).length;
  }

  totalTicks(s: number) {
    const e = this.entries(s);
    return e.length ? e.reduce((n, x) => n + x.duration, 0) : null;
  }

  grow(s: number): Promise<void> {
    if (this.complete(s)) return Promise.resolve();
    let job = this.jobs.get(s);
    if (!job) {
      job = this.load(s).finally(() => this.jobs.delete(s));
      this.jobs.set(s, job);
    }
    return job;
  }

  private async load(s: number) {
    const entries = this.entries(s);
    const k = this.next[s]!;
    const e = entries[k]!;
    // `dwSize` is the chunk size with or without its header, depending on the writer.
    let b = await this.read(e.offset, e.offset + Math.max(e.size, 24) + 8);
    const size = b.length >= 8 ? u32(b, 4) : 0;
    if (b.length >= 8 && readFourCC(b, 0).startsWith('ix') && b.length < 8 + size) {
      b = await this.read(e.offset, e.offset + 8 + size);
    }
    const ok =
      b.length >= 8 &&
      readFourCC(b, 0).startsWith('ix') &&
      parseStdIndex(b.subarray(8, 8 + size), this.tables[s]!);
    if (!ok) {
      // A damaged OpenDML index: play what the earlier ones cover.
      console.warn(`AVI: no standard index at ${e.offset} (stream ${s})`);
      this.next[s] = entries.length;
      return;
    }
    this.next[s] = k + 1;
  }
}

/** Is the chunk at `offset` (data, `size` bytes) of stream `s` a key frame? */
export type KeyFrameTest = (s: number, offset: number, size: number) => boolean | Promise<boolean>;

/** The `movi` scan: every `grow` reads the next `step` bytes of chunk headers (at least one chunk). */
export class ScanIndex implements AviIndex {
  readonly mode = 'scan';
  readonly tables: ChunkTable[];
  private done = false;
  private job: Promise<void> | null = null;

  /**
   * `pos`: the first chunk header in `movi` (after the `movi` FourCC); `end`: the end of `movi`;
   * `riffEnd`: the end of the RIFF holding it (an `AVIX` RIFF may follow).
   */
  constructor(
    streamCount: number,
    private readonly reader: BlockReader,
    private pos: number,
    private end: number,
    private riffEnd: number,
    private readonly isKey: KeyFrameTest,
    private readonly step = 512 * 1024,
  ) {
    this.tables = Array.from({ length: streamCount }, () => new ChunkTable());
  }

  complete() {
    return this.done;
  }

  totalTicks() {
    return null;
  }

  grow(): Promise<void> {
    if (this.done) return Promise.resolve();
    return (this.job ??= this.scan().finally(() => (this.job = null)));
  }

  private async scan() {
    const size = this.reader.size;
    const stop = this.pos + this.step;
    let added = false;
    while (!this.done && (this.pos < stop || !added)) {
      if (this.pos + 8 > Math.min(this.end, size)) {
        if (!(await this.nextRiff())) this.done = true;
        continue;
      }
      const h = await this.reader.read(this.pos, this.pos + 12);
      const id = readFourCC(h, 0);
      const len = u32(h, 4);
      const data = this.pos + 8;
      const next = data + len + (len & 1);
      if (id === 'LIST') {
        // `LIST rec ` groups chunks: step into it. Other lists hold no media.
        this.pos = h.length >= 12 && readFourCC(h, 8) === 'rec ' ? this.pos + 12 : next;
        continue;
      }
      // Not a chunk id (zero padding, garbage after a broken write): the movie data ends here.
      if (!/^[\x20-\x7e]{4}$/.test(id)) {
        this.done = true;
        break;
      }
      const s = streamOf(h, 0);
      if (s >= 0 && s < this.tables.length) {
        // A truncated file: its last chunk is cut.
        if (data + len > size) {
          this.done = true;
          break;
        }
        this.tables[s]!.push(data, len, await this.isKey(s, data, len));
        added = true;
      }
      this.pos = next;
    }
  }

  /** Moves to the `movi` of the `RIFF AVIX` after the current RIFF; false if there is none. */
  private async nextRiff(): Promise<boolean> {
    const size = this.reader.size;
    const at = this.riffEnd + (this.riffEnd & 1);
    if (at + 12 > size) return false;
    const h = await this.reader.read(at, at + 12);
    if (readFourCC(h, 0) !== 'RIFF' || readFourCC(h, 8) !== 'AVIX') return false;
    this.riffEnd = at + 8 + u32(h, 4);
    let p = at + 12;
    while (p + 12 <= Math.min(this.riffEnd, size)) {
      const c = await this.reader.read(p, p + 12);
      const len = u32(c, 4);
      if (readFourCC(c, 0) === 'LIST' && readFourCC(c, 8) === 'movi') {
        this.pos = p + 12;
        this.end = p + 8 + len;
        return true;
      }
      p += 8 + len + (len & 1);
    }
    return false;
  }
}
