import type { FileRange, TorrentFile } from 'webtorrent/dist/webtorrent.min.js';
import type { ByteSource } from '../player/types';

/**
 * Converts a Mediabunny range [start, end) (exclusive end) to WebTorrent's inclusive `{start, end}`.
 * WebTorrent treats `end: 0` as "to EOF", so a read of just byte 0 is widened to [0, 1] and
 * `take` says how many bytes of the result to keep.
 */
export function toFileRange(
  start: number,
  end: number,
  fileLength: number,
): { range: Required<FileRange>; take: number } {
  if (!(start >= 0 && end > start && end <= fileLength)) {
    throw new RangeError(`bad byte range [${start}, ${end}) for a file of ${fileLength} bytes`);
  }
  const take = end - start;
  const last = end - 1;
  if (last === 0) return { range: { start: 0, end: Math.min(1, fileLength - 1) }, take };
  return { range: { start, end: last }, take };
}

/** Random access over one torrent file. Reading prioritises (and waits for) the covering pieces. */
export function torrentByteSource(file: TorrentFile): ByteSource {
  return {
    size: file.length,
    read(start, end) {
      const { range, take } = toFileRange(start, end, file.length);
      if (take === range.end - range.start + 1) return file.stream(range);
      // Only the widened [0, 1] case: small enough to buffer.
      return file.arrayBuffer(range).then((buf) => new Uint8Array(buf, 0, take));
    },
  };
}

/** A `ByteSource` whose reads can all be taken back at once. */
export interface ClosableSource extends ByteSource {
  /** Cancels every stream in flight (its pieces are deselected) and fails every later read. */
  close(): void;
}

/**
 * `source` for one open of a file: closing it cancels the reads still waiting for pieces (the
 * demuxer's, the subtitle and index readers'), so WebTorrent drops their selections and the next
 * file's reads get the peers.
 */
export function closableSource(source: ByteSource): ClosableSource {
  const open = new Set<{ reader: ReadableStreamDefaultReader<Uint8Array>; fail(): void }>();
  let closed = false;
  const closedError = () => new Error('the file was closed');
  return {
    size: source.size,
    read(start, end) {
      if (closed) return Promise.reject(closedError());
      const result = source.read(start, end);
      if (!(result instanceof ReadableStream)) return result;
      const reader = result.getReader();
      let entry: { reader: ReadableStreamDefaultReader<Uint8Array>; fail(): void };
      return new ReadableStream<Uint8Array>({
        start(controller) {
          entry = { reader, fail: () => controller.error(closedError()) };
          open.add(entry);
        },
        async pull(controller) {
          try {
            const { value, done } = await reader.read();
            if (closed) return;
            if (done) {
              open.delete(entry);
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch (err) {
            open.delete(entry);
            if (!closed) controller.error(err);
          }
        },
        cancel(reason) {
          open.delete(entry);
          return reader.cancel(reason);
        },
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const { reader, fail } of open) {
        fail();
        void reader.cancel().catch(() => {});
      }
      open.clear();
    },
  };
}
