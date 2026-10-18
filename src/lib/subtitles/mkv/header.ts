/**
 * Matroska header pass (docs/decisions/0004): Segment → SeekHead → Info, Tracks; Cues and
 * Attachments are located here and read on demand (they often sit at the end of the file).
 */
import { ID, Master, dataEnd, type ElementHeader } from './ebml';
import type { ByteReader } from './reader';

export type SubtitleFormat = 'srt' | 'ass' | 'ssa' | 'webvtt';

/** A frame transform from `ContentEncodings` that we can undo. */
export type ContentEncoding =
  | { kind: 'zlib' }
  /** Header stripping: these bytes were removed from the start of every frame. */
  | { kind: 'strip'; bytes: Uint8Array };

export interface MkvSubtitleTrack {
  number: number;
  codecId: string;
  /** Text format we can turn into cues; `null` = unsupported (PGS, VobSub, DVB…). */
  format: SubtitleFormat | null;
  /** `LanguageBCP47` ?? `Language` (Matroska's default for a missing `Language` is `eng`). */
  language: string;
  name: string;
  isDefault: boolean;
  forced: boolean;
  /** For ASS/SSA: the script header (`[Script Info]`, `[V4+ Styles]`), for the styled renderer. */
  codecPrivate: Uint8Array | null;
  /** Frame transforms in decoding order; unsupported ones (encryption, bzlib…) make `format` null. */
  encodings: ContentEncoding[];
}

export interface MkvHeader {
  /** Nanoseconds per timestamp unit. */
  timestampScale: number;
  /** File offset of the Segment's data; Seek/Cue positions are relative to it. */
  segmentStart: number;
  /** End of the Segment's data (the file size when unknown). */
  segmentEnd: number;
  /** File offset of the first Cluster. */
  firstCluster: number | null;
  subtitleTracks: MkvSubtitleTrack[];
  /** File offsets of `Cues` / `Attachments`, if the file has them. */
  cuesPosition: number | null;
  attachmentsPosition: number | null;
}

const TRACK_TYPE_SUBTITLE = 0x11;

const TEXT_FORMATS: Record<string, SubtitleFormat> = {
  'S_TEXT/UTF8': 'srt',
  'S_TEXT/ASCII': 'srt',
  'S_TEXT/ASS': 'ass',
  S_ASS: 'ass',
  'S_TEXT/SSA': 'ssa',
  S_SSA: 'ssa',
  'S_TEXT/WEBVTT': 'webvtt',
};

/** "Is this a Matroska / WebM file?" from its first bytes. */
export function isEbml(firstBytes: Uint8Array): boolean {
  return (
    firstBytes[0] === 0x1a &&
    firstBytes[1] === 0x45 &&
    firstBytes[2] === 0xdf &&
    firstBytes[3] === 0xa3
  );
}

async function readMaster(reader: ByteReader, h: ElementHeader, limit: number): Promise<Master> {
  const end = dataEnd(h, limit);
  const buf = await reader.bytes(h.dataStart, end - h.dataStart);
  return new Master(buf);
}

/** Reads the header of a Matroska file; `null` when it isn't one or has no Tracks. */
export async function readMkvHeader(reader: ByteReader): Promise<MkvHeader | null> {
  if (!isEbml(await reader.bytes(0, 4))) return null;
  const ebml = await reader.header(0);
  if (!ebml || ebml.id !== ID.EBML || ebml.size === null) return null;
  const segment = await reader.header(ebml.dataStart + ebml.size);
  if (!segment || segment.id !== ID.Segment) return null;
  const segmentStart = segment.dataStart;
  const segmentEnd = dataEnd(segment, reader.size);

  const found = new Map<number, number>();
  const seekHeads: number[] = [];
  // Level-1 elements in front of the first Cluster (where muxers put the header).
  let pos = segmentStart;
  let firstCluster: number | null = null;
  while (pos < segmentEnd) {
    const h = await reader.header(pos);
    if (!h) break;
    if (h.id === ID.Cluster) {
      firstCluster = h.start;
      break;
    }
    if (!found.has(h.id)) found.set(h.id, h.start);
    if (h.id === ID.SeekHead) seekHeads.push(h.start);
    if (h.size === null) break;
    pos = h.dataStart + h.size;
  }
  // SeekHead entries point to the rest (Cues at the end, a second SeekHead, …).
  for (let i = 0; i < seekHeads.length && i < 4; i++) {
    const h = (await reader.header(seekHeads[i]!))!;
    for (const seek of (await readMaster(reader, h, segmentEnd)).all(ID.Seek)) {
      const idBytes = seek.bytes(ID.SeekID);
      const position = seek.uint(ID.SeekPosition);
      if (!idBytes || position === undefined) continue;
      const id = idBytes.reduce((v, b) => v * 256 + b, 0);
      const at = segmentStart + position;
      if (at >= segmentEnd || found.has(id)) continue;
      found.set(id, at);
      if (id === ID.SeekHead) seekHeads.push(at);
    }
  }

  const tracksAt = found.get(ID.Tracks);
  if (tracksAt === undefined) return null;
  const tracksHeader = await reader.header(tracksAt);
  if (!tracksHeader || tracksHeader.id !== ID.Tracks) return null;
  const tracks = await readMaster(reader, tracksHeader, segmentEnd);

  let timestampScale = 1_000_000;
  const infoAt = found.get(ID.Info);
  const infoHeader = infoAt === undefined ? null : await reader.header(infoAt);
  if (infoHeader?.id === ID.Info) {
    timestampScale =
      (await readMaster(reader, infoHeader, segmentEnd)).uint(ID.TimestampScale) ?? timestampScale;
  }

  return {
    timestampScale,
    segmentStart,
    segmentEnd,
    firstCluster,
    subtitleTracks: tracks
      .all(ID.TrackEntry)
      .filter((t) => t.uint(ID.TrackType) === TRACK_TYPE_SUBTITLE && t.uint(ID.FlagEnabled) !== 0)
      .map(parseSubtitleTrack),
    cuesPosition: found.get(ID.Cues) ?? null,
    attachmentsPosition: found.get(ID.Attachments) ?? null,
  };
}

function parseSubtitleTrack(t: Master): MkvSubtitleTrack {
  const codecId = t.string(ID.CodecID) ?? '';
  const { encodings, supported } = parseEncodings(t.first(ID.ContentEncodings));
  return {
    number: t.uint(ID.TrackNumber) ?? 0,
    codecId,
    format: supported ? (TEXT_FORMATS[codecId] ?? null) : null,
    language: t.string(ID.LanguageBCP47) || t.string(ID.Language) || 'eng',
    name: t.string(ID.Name) ?? '',
    // Spec defaults: FlagDefault 1, FlagForced 0.
    isDefault: (t.uint(ID.FlagDefault) ?? 1) === 1,
    forced: (t.uint(ID.FlagForced) ?? 0) === 1,
    codecPrivate: t.bytes(ID.CodecPrivate) ?? null,
    encodings: encodings,
  };
}

/** `ContentEncodings`, in decoding order (highest `ContentEncodingOrder` first = file order reversed). */
function parseEncodings(list: Master | undefined): {
  encodings: ContentEncoding[];
  supported: boolean;
} {
  const encodings: ContentEncoding[] = [];
  for (const enc of list?.all(ID.ContentEncoding) ?? []) {
    // Scope bit 1 = frame contents; other scopes (CodecPrivate, next encoding) don't touch frames.
    if (((enc.uint(ID.ContentEncodingScope) ?? 1) & 1) === 0) continue;
    if ((enc.uint(ID.ContentEncodingType) ?? 0) !== 0) return { encodings, supported: false };
    const comp = enc.first(ID.ContentCompression);
    const algo = comp?.uint(ID.ContentCompAlgo) ?? 0;
    if (algo === 0) encodings.push({ kind: 'zlib' });
    else if (algo === 3) {
      encodings.push({
        kind: 'strip',
        bytes: comp?.bytes(ID.ContentCompSettings) ?? new Uint8Array(0),
      });
    } else return { encodings, supported: false };
  }
  return { encodings: encodings.reverse(), supported: true };
}

export interface CuePoint {
  /** Seconds. */
  time: number;
  /** File offset of the Cluster. */
  cluster: number;
}

/** The file's Cues (cluster index), sorted by time; empty if it has none. */
export async function readCuePoints(reader: ByteReader, header: MkvHeader): Promise<CuePoint[]> {
  if (header.cuesPosition === null) return [];
  const h = await reader.header(header.cuesPosition);
  if (!h || h.id !== ID.Cues) return [];
  const points: CuePoint[] = [];
  const seen = new Set<number>();
  for (const point of (await readMaster(reader, h, header.segmentEnd)).all(ID.CuePoint)) {
    const time = point.uint(ID.CueTime);
    if (time === undefined) continue;
    for (const pos of point.all(ID.CueTrackPositions)) {
      const rel = pos.uint(ID.CueClusterPosition);
      if (rel === undefined) continue;
      const cluster = header.segmentStart + rel;
      if (seen.has(cluster)) continue;
      seen.add(cluster);
      points.push({ time: (time * header.timestampScale) / 1e9, cluster });
    }
  }
  return points.sort((a, b) => a.time - b.time || a.cluster - b.cluster);
}

export interface MkvAttachment {
  name: string;
  mimeType: string;
  description: string;
  /** File offset and size of the data, read it with `readRange`. */
  dataStart: number;
  size: number;
}

/**
 * Lists the attached files (fonts for ASS) without reading their data. Walks element headers, so a
 * large font costs nothing until it is read.
 */
export async function readAttachments(
  reader: ByteReader,
  header: MkvHeader,
): Promise<MkvAttachment[]> {
  if (header.attachmentsPosition === null) return [];
  const h = await reader.header(header.attachmentsPosition);
  if (!h || h.id !== ID.Attachments) return [];
  const end = dataEnd(h, header.segmentEnd);
  const files: MkvAttachment[] = [];
  for (let pos = h.dataStart; pos < end;) {
    const file = await reader.header(pos);
    if (!file || file.size === null) break;
    pos = file.dataStart + file.size;
    if (file.id !== ID.AttachedFile) continue;
    const att: MkvAttachment = { name: '', mimeType: '', description: '', dataStart: 0, size: 0 };
    for (let p = file.dataStart; p < pos;) {
      const c = await reader.header(p);
      if (!c || c.size === null) break;
      p = c.dataStart + c.size;
      if (c.id === ID.FileData) {
        att.dataStart = c.dataStart;
        att.size = c.size;
      } else if (c.id === ID.FileName || c.id === ID.FileMimeType || c.id === ID.FileDescription) {
        const text = new Master(await reader.bytes(c.start, p - c.start)).string(c.id) ?? '';
        if (c.id === ID.FileName) att.name = text;
        else if (c.id === ID.FileMimeType) att.mimeType = text;
        else att.description = text;
      }
    }
    if (att.size > 0) files.push(att);
  }
  return files;
}
