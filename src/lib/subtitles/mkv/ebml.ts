/**
 * EBML primitives for the Matroska subtitle reader (docs/decisions/0004): element IDs, variable-size
 * integers, element headers and value decoding over plain byte arrays. Pure; see mkv.test.ts.
 */

/** Matroska element IDs we read (with their length-marker bits, as written in the file). */
export const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  FlagEnabled: 0xb9,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  Name: 0x536e,
  BlockAdditionMapping: 0x41e4,
  BlockAddIDType: 0x41e7,
  BlockAddIDExtraData: 0x41ed,
  ContentEncodings: 0x6d80,
  ContentEncoding: 0x6240,
  ContentEncodingScope: 0x5032,
  ContentEncodingType: 0x5033,
  ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254,
  ContentCompSettings: 0x4255,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueClusterPosition: 0xf1,
  Attachments: 0x1941a469,
  AttachedFile: 0x61a7,
  FileDescription: 0x467e,
  FileName: 0x466e,
  FileMimeType: 0x4660,
  FileData: 0x465c,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
} as const;

/** Level-1 elements: one of these ends a Cluster of unknown size. */
export const TOP_LEVEL_IDS: ReadonlySet<number> = new Set([
  ID.SeekHead,
  ID.Info,
  ID.Tracks,
  ID.Cues,
  ID.Attachments,
  ID.Cluster,
  ID.Tags,
  ID.Chapters,
]);

/** Longest element header: 4-byte ID + 8-byte size. */
export const MAX_HEADER_BYTES = 12;

export interface ElementHeader {
  id: number;
  /** Offset of the element's first byte (its ID). */
  start: number;
  /** Offset of its data, right after the header. */
  dataStart: number;
  /** Data size; `null` = unknown (live-muxed Segment/Cluster), runs to the parent's end. */
  size: number | null;
}

export const dataEnd = (h: ElementHeader, limit: number) =>
  h.size === null ? limit : Math.min(h.dataStart + h.size, limit);

/** Length in bytes of the vint starting with `first` (1–8); 0 if `first` is 0 (invalid). */
function vintLength(first: number): number {
  for (let len = 1; len <= 8; len++) if (first & (0x80 >> (len - 1))) return len;
  return 0;
}

/**
 * Reads a vint at `pos`. `keepMarker`: element IDs keep the length marker bit. Returns `null` when
 * the bytes run out (the caller reads more), `unknown` when every value bit is 1 (unknown size).
 */
export function readVint(
  buf: Uint8Array,
  pos: number,
  keepMarker = false,
): { value: number; length: number; unknown: boolean } | null {
  if (pos >= buf.length) return null;
  const first = buf[pos]!;
  const length = vintLength(first);
  if (length === 0) throw new Error(`invalid EBML vint at byte ${pos}`);
  if (pos + length > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const b = buf[pos + i]!;
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

/**
 * Parses the element header at `buf[pos]`; `base` is the file offset of `buf[0]`. `null` when `buf`
 * ends inside the header.
 */
export function readHeader(buf: Uint8Array, pos: number, base = 0): ElementHeader | null {
  const id = readVint(buf, pos, true);
  if (!id) return null;
  if (id.length > 4) throw new Error(`invalid EBML ID at byte ${base + pos}`);
  const size = readVint(buf, pos + id.length);
  if (!size) return null;
  return {
    id: id.value,
    start: base + pos,
    dataStart: base + pos + id.length + size.length,
    size: size.unknown ? null : size.value,
  };
}

/** Child elements of the master element whose data is `buf[start, end)`. */
export function* children(buf: Uint8Array, start = 0, end = buf.length): Generator<ElementHeader> {
  let pos = start;
  while (pos < end) {
    const h = readHeader(buf, pos);
    if (!h) return;
    yield h;
    if (h.size === null) return;
    pos = h.dataStart + h.size;
  }
}

export function readUint(buf: Uint8Array, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + buf[i]!;
  return value;
}

const utf8 = new TextDecoder('utf-8');

/** EBML string / UTF-8 value: trailing NUL padding dropped. */
export function readString(buf: Uint8Array, start: number, end: number): string {
  return utf8.decode(buf.subarray(start, end)).replace(/\0+$/, '');
}

/** Typed accessors for the children of a small master element held in memory. */
export class Master {
  private readonly items: ElementHeader[];
  constructor(
    private readonly buf: Uint8Array,
    start = 0,
    end = buf.length,
  ) {
    this.items = [...children(buf, start, end)];
    this.end = end;
  }
  private readonly end: number;

  all(id: number): Master[] {
    return this.items.filter((h) => h.id === id).map((h) => this.childMaster(h));
  }
  first(id: number): Master | undefined {
    const h = this.items.find((x) => x.id === id);
    return h ? this.childMaster(h) : undefined;
  }
  uint(id: number): number | undefined {
    const h = this.items.find((x) => x.id === id);
    return h ? readUint(this.buf, h.dataStart, dataEnd(h, this.end)) : undefined;
  }
  string(id: number): string | undefined {
    const h = this.items.find((x) => x.id === id);
    return h ? readString(this.buf, h.dataStart, dataEnd(h, this.end)) : undefined;
  }
  bytes(id: number): Uint8Array | undefined {
    const h = this.items.find((x) => x.id === id);
    return h ? this.buf.slice(h.dataStart, dataEnd(h, this.end)) : undefined;
  }
  private childMaster(h: ElementHeader) {
    return new Master(this.buf, h.dataStart, dataEnd(h, this.end));
  }
}
