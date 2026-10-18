import type { ByteSource } from '../../player/types';
import { MAX_HEADER_BYTES, readHeader, type ElementHeader } from './ebml';

/** Reads `[start, end)` of a source into one array; cancels the stream when `signal` aborts. */
export async function readRange(
  source: ByteSource,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (end <= start) return new Uint8Array(0);
  const result = source.read(start, end);
  if (!(result instanceof ReadableStream)) {
    const bytes = await result;
    signal?.throwIfAborted();
    return bytes;
  }
  const reader = result.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const out = new Uint8Array(end - start);
    let filled = 0;
    while (filled < out.length) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      const n = Math.min(value.length, out.length - filled);
      out.set(value.subarray(0, n), filled);
      filled += n;
    }
    if (filled < out.length) throw new Error(`short read at ${start}: ${filled}/${out.length}`);
    return out;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/**
 * Random access with a read-ahead window: small reads (element headers, block heads) are served
 * from the last window, so walking a Cluster costs a few large reads, not one per element.
 */
export class ByteReader {
  private window: Uint8Array = new Uint8Array(0);
  private windowStart = 0;

  constructor(
    private readonly source: ByteSource,
    private readonly windowSize = 64 * 1024,
    private readonly signal?: AbortSignal,
  ) {}

  get size(): number {
    return this.source.size;
  }

  /** Up to `length` bytes at `start` (fewer at the end of the file). */
  async bytes(start: number, length: number): Promise<Uint8Array> {
    const end = Math.min(this.size, start + length);
    const offset = start - this.windowStart;
    if (offset >= 0 && end - this.windowStart <= this.window.length) {
      return this.window.subarray(offset, offset + end - start);
    }
    const windowEnd = Math.min(this.size, start + Math.max(length, this.windowSize));
    this.window = await readRange(this.source, start, windowEnd, this.signal);
    this.windowStart = start;
    return this.window.subarray(0, end - start);
  }

  /** The element header at `pos`, or `null` at the end of the file. */
  async header(pos: number): Promise<ElementHeader | null> {
    if (pos >= this.size) return null;
    const h = readHeader(await this.bytes(pos, MAX_HEADER_BYTES), 0, pos);
    if (!h) throw new Error(`truncated EBML element at byte ${pos}`);
    return h;
  }
}
