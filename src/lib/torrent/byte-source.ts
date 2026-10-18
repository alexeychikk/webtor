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
