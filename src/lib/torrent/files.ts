import type { SubtitleFileEntry, VideoFileEntry } from '../player/types';

/** Containers Mediabunny demuxes (docs/decisions/0003), plus AVI with our demuxer (0007). */
const PLAYABLE_VIDEO_EXTENSIONS = new Set([
  'mkv',
  'avi',
  'webm',
  'mp4',
  'm4v',
  'mov',
  'ts',
  'm2ts',
  'mts',
]);
/** Video containers we recognise but cannot open in the browser. */
const UNSUPPORTED_VIDEO_EXTENSIONS = new Set(['wmv', 'flv', 'mpg', 'mpeg', 'vob', 'rmvb']);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export type VideoFileKind = 'playable' | 'unsupported' | 'other';

export function classifyFile(name: string): VideoFileKind {
  const ext = extensionOf(name);
  if (PLAYABLE_VIDEO_EXTENSIONS.has(ext)) return 'playable';
  if (UNSUPPORTED_VIDEO_EXTENSIONS.has(ext)) return 'unsupported';
  return 'other';
}

interface FileLike {
  name: string;
  path: string;
  length: number;
}

export type VideoFilePick =
  | { ok: true; file: VideoFileEntry }
  | { ok: false; code: 'no-playable-file' | 'unsupported-container' };

/**
 * The file to play: `preferred` (an index into `files`, e.g. from `#file=`) when it is a playable
 * video, else the largest playable one. Tells "only WMV/FLV/…" apart from "no video at all".
 */
export function pickVideoFile(
  files: readonly FileLike[],
  preferred: number | null = null,
): VideoFilePick {
  const entry = (index: number): VideoFileEntry => {
    const f = files[index]!;
    return { index, path: f.path, name: f.name, length: f.length };
  };
  if (
    preferred !== null &&
    files[preferred] &&
    classifyFile(files[preferred].name) === 'playable'
  ) {
    return { ok: true, file: entry(preferred) };
  }
  let best: number | null = null;
  let sawUnsupported = false;
  files.forEach((f, index) => {
    const kind = classifyFile(f.name);
    if (kind === 'unsupported') sawUnsupported = true;
    if (kind !== 'playable' || (best !== null && files[best]!.length >= f.length)) return;
    best = index;
  });
  if (best !== null) return { ok: true, file: entry(best) };
  return { ok: false, code: sawUnsupported ? 'unsupported-container' : 'no-playable-file' };
}

export interface VideoFileListEntry extends VideoFileEntry {
  /** `unsupported` entries are listed greyed out (WMV, FLV, …). */
  kind: 'playable' | 'unsupported';
}

/** Video files of a torrent for the file picker, in path order (episodes sort naturally). */
export function listVideoFiles(files: readonly FileLike[]): VideoFileListEntry[] {
  const entries: VideoFileListEntry[] = [];
  files.forEach((f, index) => {
    const kind = classifyFile(f.name);
    if (kind === 'other') return;
    entries.push({ index, path: f.path, name: f.name, length: f.length, kind });
  });
  return entries.sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }),
  );
}

/** A dropped or picked file that should be opened as a torrent (by extension or MIME type). */
export function isTorrentFile(file: { name: string; type: string }): boolean {
  return extensionOf(file.name) === 'torrent' || file.type === 'application/x-bittorrent';
}

const BENCODE = { d: 0x64, e: 0x65, i: 0x69, l: 0x6c, colon: 0x3a, minus: 0x2d } as const;
const MAX_BENCODE_DEPTH = 64;
const isDigit = (byte: number | undefined) => byte !== undefined && byte >= 0x30 && byte <= 0x39;

/** End of the bencoded string at `pos` and where its bytes start, or null when malformed. */
function bencodeString(bytes: Uint8Array, pos: number): { start: number; end: number } | null {
  let length = 0;
  let at = pos;
  if (!isDigit(bytes[at])) return null;
  while (isDigit(bytes[at])) length = length * 10 + bytes[at++]! - 0x30;
  if (bytes[at] !== BENCODE.colon || at + 1 + length > bytes.length) return null;
  return { start: at + 1, end: at + 1 + length };
}

/** Position after the bencoded value at `pos`, or -1 when it is malformed or nested too deep. */
function skipBencode(bytes: Uint8Array, pos: number, depth: number): number {
  if (depth > MAX_BENCODE_DEPTH) return -1;
  const type = bytes[pos];
  if (type === BENCODE.i) {
    let at = pos + 1;
    if (bytes[at] === BENCODE.minus) at++;
    if (!isDigit(bytes[at])) return -1;
    while (isDigit(bytes[at])) at++;
    return bytes[at] === BENCODE.e ? at + 1 : -1;
  }
  if (type === BENCODE.l || type === BENCODE.d) {
    let at = pos + 1;
    while (at < bytes.length && bytes[at] !== BENCODE.e) {
      if (type === BENCODE.d) {
        const key = bencodeString(bytes, at);
        if (!key) return -1;
        at = key.end;
      }
      at = skipBencode(bytes, at, depth + 1);
      if (at < 0) return -1;
    }
    return bytes[at] === BENCODE.e ? at + 1 : -1;
  }
  return bencodeString(bytes, pos)?.end ?? -1;
}

const INFO_KEY = 'info';

/** The bytes are a .torrent: a well-formed bencoded dictionary with an `info` dictionary. */
export function isTorrentBytes(bytes: Uint8Array): boolean {
  if (bytes[0] !== BENCODE.d) return false;
  let at = 1;
  let hasInfo = false;
  while (at < bytes.length && bytes[at] !== BENCODE.e) {
    const key = bencodeString(bytes, at);
    if (!key) return false;
    const isInfo =
      key.end - key.start === INFO_KEY.length &&
      String.fromCharCode(...bytes.subarray(key.start, key.end)) === INFO_KEY;
    if (isInfo) hasInfo = bytes[key.end] === BENCODE.d;
    at = skipBencode(bytes, key.end, 1);
    if (at < 0) return false;
  }
  return bytes[at] === BENCODE.e && hasInfo;
}

/** Larger than any real .torrent (a few MB at most): such a pick is never read whole. */
export const MAX_TORRENT_FILE_BYTES = 64 * 1024 * 1024;

/**
 * The bytes of a picked or dropped file when it is a .torrent, judged by its content alone (iOS
 * can save one without its extension), else null. Anything not starting a dictionary is rejected
 * after one byte.
 */
export async function readTorrentFile(file: Blob): Promise<Uint8Array | null> {
  if (file.size === 0 || file.size > MAX_TORRENT_FILE_BYTES) return null;
  const first = new Uint8Array(await file.slice(0, 1).arrayBuffer());
  if (first[0] !== BENCODE.d) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return isTorrentBytes(bytes) ? bytes : null;
}

const SUBTITLE_FORMATS = new Set<SubtitleFileEntry['format']>(['srt', 'vtt', 'ass', 'ssa']);

const stem = (name: string) => name.replace(/\.[^.]*$/, '').toLowerCase();

/**
 * Subtitle files in the torrent (docs/decisions/0004): those whose name starts with the video's
 * basename first (`Movie.mkv` → `Movie.en.srt`), then the rest, each group in path order.
 */
export function listSubtitleFiles(
  files: readonly FileLike[],
  videoName: string | null,
): SubtitleFileEntry[] {
  const video = videoName ? stem(videoName) : null;
  const entries: (SubtitleFileEntry & { matches: boolean })[] = [];
  files.forEach((f, index) => {
    const format = extensionOf(f.name) as SubtitleFileEntry['format'];
    if (!SUBTITLE_FORMATS.has(format)) return;
    const matches = video !== null && f.name.toLowerCase().startsWith(video);
    entries.push({ index, path: f.path, name: f.name, length: f.length, format, matches });
  });
  return entries
    .sort((a, b) => Number(b.matches) - Number(a.matches) || a.path.localeCompare(b.path))
    .map(({ matches: _, ...entry }) => entry);
}
