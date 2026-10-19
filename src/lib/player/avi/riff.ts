/**
 * AVI (RIFF) header and `idx1` parsing (ADR 0007 §1). Pure: works on byte arrays; the demuxer does
 * the reads. Little-endian throughout.
 */

export const AVIF_HASINDEX = 0x10;
export const AVIIF_KEYFRAME = 0x10;

export interface AviMainHeader {
  microSecPerFrame: number;
  flags: number;
  totalFrames: number;
  width: number;
  height: number;
}

export interface WaveFormat {
  formatTag: number;
  channels: number;
  sampleRate: number;
  avgBytesPerSec: number;
  blockAlign: number;
  bitsPerSample: number;
  /** Bytes after the 18-byte WAVEFORMATEX (e.g. AAC AudioSpecificConfig). */
  extra: Uint8Array;
}

export interface BitmapInfo {
  width: number;
  height: number;
  compression: string;
  /** Bytes after the 40-byte BITMAPINFOHEADER (e.g. H.264 SPS/PPS). */
  extra: Uint8Array;
}

export interface AviStreamHeader {
  /** Stream number: the `NN` of `NNdc` / `NNwb` chunk ids. */
  index: number;
  type: string;
  handler: string;
  scale: number;
  rate: number;
  start: number;
  length: number;
  sampleSize: number;
  language: number;
  video?: BitmapInfo;
  audio?: WaveFormat;
  name: string | null;
  /** OpenDML super index (`indx` in the `strl`): its `ix##` chunks, in file order; null if none. */
  superIndex: SuperIndexEntry[] | null;
}

/** One `indx` entry: where an `ix##` standard index chunk is and how many stream ticks it covers. */
export interface SuperIndexEntry {
  /** File position of the `ix##` chunk header. */
  offset: number;
  /** Size of the chunk as the super index states it (0 when the writer left it out). */
  size: number;
  /** Stream ticks (`dwScale / dwRate` each; video: frames) its chunks cover. */
  duration: number;
}

export interface AviHeader {
  main: AviMainHeader;
  streams: AviStreamHeader[];
  /** File position of the `movi` FourCC (base of relative `idx1` offsets); its data follows. */
  moviPos: number;
  /** End of `LIST movi` (file position). */
  moviEnd: number;
  /** Size of the first `RIFF` (8 + its size): an OpenDML file continues with `RIFF AVIX` after it. */
  riffEnd: number;
}

const fourcc = (b: Uint8Array, o: number) =>
  String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Cheap format check on the first 12 bytes. */
export function isAvi(head: Uint8Array): boolean {
  return head.length >= 12 && fourcc(head, 0) === 'RIFF' && fourcc(head, 8) === 'AVI ';
}

export class AviFormatError extends Error {
  override name = 'AviFormatError';
}

/**
 * Walks the chunk list at `[start, end)` of `b` (positions are relative to `b`; `base` is the file
 * position of `b[0]`). Calls `visit` with each chunk's id, `LIST` type, and data range.
 */
function walk(
  b: Uint8Array,
  start: number,
  end: number,
  visit: (id: string, listType: string | null, dataStart: number, size: number) => void,
) {
  const dv = view(b);
  let o = start;
  while (o + 8 <= end) {
    const id = fourcc(b, o);
    const size = dv.getUint32(o + 4, true);
    const isList = id === 'LIST' || id === 'RIFF';
    visit(id, isList ? fourcc(b, o + 8) : null, o + 8, size);
    o += 8 + size + (size & 1);
  }
}

function parseStrl(b: Uint8Array, start: number, end: number, index: number): AviStreamHeader {
  const dv = view(b);
  let s: AviStreamHeader | null = null;
  let strf = null as [number, number] | null;
  let name: string | null = null;
  let superIndex: SuperIndexEntry[] | null = null;
  walk(b, start, end, (id, _list, d, size) => {
    if (id === 'strh' && size >= 48) {
      s = {
        index,
        type: fourcc(b, d),
        handler: fourcc(b, d + 4),
        language: dv.getUint16(d + 14, true),
        scale: dv.getUint32(d + 20, true),
        rate: dv.getUint32(d + 24, true),
        start: dv.getUint32(d + 28, true),
        length: dv.getUint32(d + 32, true),
        sampleSize: dv.getUint32(d + 44, true),
        name: null,
        superIndex: null,
      };
    } else if (id === 'strf') {
      strf = [d, Math.min(size, end - d)];
    } else if (id === 'strn') {
      const bytes = b.subarray(d, Math.min(d + size, end));
      const nul = bytes.indexOf(0);
      name = new TextDecoder('latin1').decode(nul >= 0 ? bytes.subarray(0, nul) : bytes).trim();
    } else if (id === 'indx') {
      superIndex = parseSuperIndex(b.subarray(d, Math.min(d + size, end)));
    }
  });
  if (!s) throw new AviFormatError('stream without strh');
  const stream: AviStreamHeader = s;
  stream.name = name || null;
  stream.superIndex = superIndex;
  if (strf) {
    const [d, size] = strf;
    if (stream.type === 'vids' && size >= 40) {
      stream.video = {
        width: dv.getInt32(d + 4, true),
        height: Math.abs(dv.getInt32(d + 8, true)),
        compression: fourcc(b, d + 16),
        extra: b.slice(d + 40, d + size),
      };
    } else if (stream.type === 'auds' && size >= 14) {
      let formatTag = dv.getUint16(d, true);
      const cbSize = size >= 18 ? dv.getUint16(d + 16, true) : 0;
      // WAVE_FORMAT_EXTENSIBLE: the real tag is the first 2 bytes of the SubFormat GUID.
      if (formatTag === 0xfffe && size >= 40) formatTag = dv.getUint16(d + 24, true);
      stream.audio = {
        formatTag,
        channels: dv.getUint16(d + 2, true),
        sampleRate: dv.getUint32(d + 4, true),
        avgBytesPerSec: dv.getUint32(d + 8, true),
        blockAlign: dv.getUint16(d + 12, true),
        bitsPerSample: size >= 16 ? dv.getUint16(d + 14, true) : 0,
        extra: b.slice(d + 18, d + 18 + Math.min(cbSize, Math.max(0, size - 18))),
      };
    }
  }
  return stream;
}

/** Parses `LIST hdrl` data (`b[start, end)`): `avih` and one `strl` per stream. */
export function parseHdrl(
  b: Uint8Array,
  start: number,
  end: number,
): Omit<AviHeader, 'moviPos' | 'moviEnd' | 'riffEnd'> {
  const dv = view(b);
  let main: AviMainHeader | null = null;
  const streams: AviStreamHeader[] = [];
  walk(b, start, end, (id, list, d, size) => {
    if (id === 'avih' && size >= 40) {
      main = {
        microSecPerFrame: dv.getUint32(d, true),
        flags: dv.getUint32(d + 12, true),
        totalFrames: dv.getUint32(d + 16, true),
        width: dv.getUint32(d + 32, true),
        height: dv.getUint32(d + 36, true),
      };
    } else if (id === 'LIST' && list === 'strl') {
      streams.push(parseStrl(b, d + 4, Math.min(d + size, end), streams.length));
    }
  });
  if (!main) throw new AviFormatError('no avih');
  return { main, streams };
}

/**
 * One stream's chunks in file (= decode) order, from `idx1`, OpenDML `ix##` chunks or the `movi`
 * scan. It grows while the lazy indexes load; `length` is the number of chunks known so far.
 */
export class ChunkTable {
  /** File position of each chunk's data (after its 8-byte header). */
  offsets: Float64Array;
  sizes: Uint32Array;
  /** Key frame flag per chunk. */
  keys: Uint8Array;
  length = 0;

  constructor(capacity = 64) {
    this.offsets = new Float64Array(capacity);
    this.sizes = new Uint32Array(capacity);
    this.keys = new Uint8Array(capacity);
  }

  push(offset: number, size: number, key: boolean) {
    if (this.length === this.sizes.length) {
      const cap = Math.max(64, this.length * 2);
      const offsets = new Float64Array(cap);
      const sizes = new Uint32Array(cap);
      const keys = new Uint8Array(cap);
      offsets.set(this.offsets);
      sizes.set(this.sizes);
      keys.set(this.keys);
      Object.assign(this, { offsets, sizes, keys });
    }
    const i = this.length++;
    this.offsets[i] = offset;
    this.sizes[i] = size;
    this.keys[i] = key ? 1 : 0;
  }

  /** End (file position) of the last chunk's data, 0 if empty. */
  get end(): number {
    const i = this.length - 1;
    return i < 0 ? 0 : this.offsets[i]! + this.sizes[i]!;
  }
}

/** Stream number of a chunk id like `00dc` / `01wb`, or -1 (`ix00`, `rec `, `JUNK`…). */
export function streamOf(b: Uint8Array, o: number): number {
  const d0 = (b[o] ?? 0) - 48;
  const d1 = (b[o + 1] ?? 0) - 48;
  if (d0 < 0 || d0 > 9 || d1 < 0 || d1 > 9) return -1;
  const t = String.fromCharCode(b[o + 2] ?? 0, b[o + 3] ?? 0);
  return t === 'dc' || t === 'db' || t === 'wb' ? d0 * 10 + d1 : -1;
}

/**
 * Splits `idx1` data into per-stream tables. Offsets are relative to the `movi` FourCC or absolute
 * file positions: `absolute` decides (see `idx1IsAbsolute`).
 */
export function parseIdx1(
  b: Uint8Array,
  streamCount: number,
  moviPos: number,
  absolute: boolean,
): ChunkTable[] {
  const dv = view(b);
  const n = Math.floor(b.length / 16);
  const counts = new Array<number>(streamCount).fill(0);
  for (let i = 0; i < n; i++) {
    const s = streamOf(b, i * 16);
    if (s >= 0 && s < streamCount) counts[s]!++;
  }
  const tables = counts.map((c) => new ChunkTable(Math.max(1, c)));
  const base = absolute ? 0 : moviPos;
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    const s = streamOf(b, o);
    if (s < 0 || s >= streamCount) continue;
    tables[s]!.push(
      base + dv.getUint32(o + 8, true) + 8,
      dv.getUint32(o + 12, true),
      (dv.getUint32(o + 4, true) & AVIIF_KEYFRAME) !== 0,
    );
  }
  return tables;
}

const u64 = (dv: DataView, o: number) =>
  dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32;

/** `AVI_INDEX_OF_INDEXES` (`indx` data): the `ix##` chunks it lists; null for other index types. */
export function parseSuperIndex(b: Uint8Array): SuperIndexEntry[] | null {
  if (b.length < 24) return null;
  const dv = view(b);
  const longs = dv.getUint16(0, true);
  if (b[3] !== 0x00 || longs < 4) return null;
  const n = dv.getUint32(4, true);
  const out: SuperIndexEntry[] = [];
  for (let i = 0, o = 24; i < n && o + 16 <= b.length; i++, o += longs * 4) {
    const offset = u64(dv, o);
    if (offset === 0) continue;
    out.push({ offset, size: dv.getUint32(o + 8, true), duration: dv.getUint32(o + 12, true) });
  }
  return out.length ? out : null;
}

/**
 * Appends an `AVI_INDEX_OF_CHUNKS` (`ix##` data, after its 8-byte header) to `table`. Entry offsets
 * are relative to `qwBaseOffset` and point at chunk data; bit 31 of the size marks a non-key frame.
 * Returns false when `b` is not a standard index.
 */
export function parseStdIndex(b: Uint8Array, table: ChunkTable): boolean {
  if (b.length < 24) return false;
  const dv = view(b);
  const longs = dv.getUint16(0, true);
  if (b[3] !== 0x01 || longs < 2) return false;
  const n = dv.getUint32(4, true);
  const base = u64(dv, 12);
  for (let i = 0, o = 24; i < n && o + 8 <= b.length; i++, o += longs * 4) {
    const size = dv.getUint32(o + 4, true);
    table.push(base + dv.getUint32(o, true), size & 0x7fffffff, (size & 0x80000000) === 0);
  }
  return true;
}

/** First `idx1` entry: chunk id and raw offset, to decide relative vs absolute offsets. */
export function firstIdx1Entry(b: Uint8Array): { id: string; offset: number } | null {
  if (b.length < 16) return null;
  return { id: fourcc(b, 0), offset: view(b).getUint32(8, true) };
}

export { fourcc as readFourCC };
