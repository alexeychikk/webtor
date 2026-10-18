import type { SubtitleFileEntry, VideoFileEntry } from '../player/types';

/** Containers Mediabunny demuxes (docs/decisions/0003). */
const PLAYABLE_VIDEO_EXTENSIONS = new Set([
  'mkv',
  'webm',
  'mp4',
  'm4v',
  'mov',
  'ts',
  'm2ts',
  'mts',
]);
/** Video containers we recognise but cannot open in the browser. */
const UNSUPPORTED_VIDEO_EXTENSIONS = new Set(['avi', 'wmv', 'flv', 'mpg', 'mpeg', 'vob', 'rmvb']);

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

/** The largest playable video file; tells "only AVI/WMV/…" apart from "no video at all". */
export function pickVideoFile(files: readonly FileLike[]): VideoFilePick {
  let best: VideoFileEntry | null = null;
  let sawUnsupported = false;
  files.forEach((f, index) => {
    const kind = classifyFile(f.name);
    if (kind === 'unsupported') sawUnsupported = true;
    if (kind !== 'playable' || (best && best.length >= f.length)) return;
    best = { index, path: f.path, name: f.name, length: f.length };
  });
  if (best) return { ok: true, file: best };
  return { ok: false, code: sawUnsupported ? 'unsupported-container' : 'no-playable-file' };
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
