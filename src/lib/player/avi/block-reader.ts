import { readRange } from '../../subtitles/mkv/reader';
import type { ByteSource } from '../types';

/**
 * Block cache over a `ByteSource`: AVI interleaves audio and video chunks, so the two pipelines
 * read the same file regions. Reads are rounded to blocks, missing neighbours are fetched in one
 * ranged read, and the most recent blocks are kept (LRU).
 */
export class BlockReader {
  private readonly blocks = new Map<number, Promise<Uint8Array>>();

  constructor(
    private readonly source: ByteSource,
    private readonly signal?: AbortSignal,
    private readonly blockSize = 256 * 1024,
    private readonly maxBlocks = 32,
  ) {}

  get size(): number {
    return this.source.size;
  }

  /** Bytes `[start, end)`, clamped to the file. */
  async read(start: number, end: number): Promise<Uint8Array> {
    end = Math.min(end, this.source.size);
    if (end <= start) return new Uint8Array(0);
    const bs = this.blockSize;
    const first = Math.floor(start / bs);
    const last = Math.floor((end - 1) / bs);
    // Bigger than the cache: read it directly.
    if (last - first + 1 > this.maxBlocks / 2)
      return readRange(this.source, start, end, this.signal);
    const blocks = this.fetch(first, last);
    if (first === last) {
      const block = await blocks[0]!;
      return block.subarray(start - first * bs, end - first * bs);
    }
    const out = new Uint8Array(end - start);
    for (let i = first; i <= last; i++) {
      const block = await blocks[i - first]!;
      const from = Math.max(start, i * bs);
      const to = Math.min(end, (i + 1) * bs);
      out.set(block.subarray(from - i * bs, to - i * bs), from - start);
    }
    return out;
  }

  /**
   * The blocks `[first, last]`: cached ones move to the newest LRU position, missing runs start one
   * ranged read each.
   */
  private fetch(first: number, last: number): Promise<Uint8Array>[] {
    const bs = this.blockSize;
    const out: Promise<Uint8Array>[] = [];
    let i = first;
    while (i <= last) {
      const cached = this.blocks.get(i);
      if (cached) {
        this.blocks.delete(i);
        this.blocks.set(i, cached);
        out.push(cached);
        i++;
        continue;
      }
      let j = i;
      while (j + 1 <= last && !this.blocks.has(j + 1)) j++;
      const runStart = i * bs;
      const runEnd = Math.min((j + 1) * bs, this.source.size);
      const run = readRange(this.source, runStart, runEnd, this.signal);
      for (let k = i; k <= j; k++) {
        const p = run.then((bytes) =>
          bytes.subarray(k * bs - runStart, Math.min((k + 1) * bs, runEnd) - runStart),
        );
        p.catch(() => {
          if (this.blocks.get(k) === p) this.blocks.delete(k);
        });
        this.blocks.set(k, p);
        out.push(p);
      }
      i = j + 1;
    }
    while (this.blocks.size > this.maxBlocks) {
      const oldest = this.blocks.keys().next().value as number;
      this.blocks.delete(oldest);
    }
    return out;
  }
}
