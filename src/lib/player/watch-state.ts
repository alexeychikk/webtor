/**
 * Per-video watch state (resume): the audio and subtitle track the user picked, the subtitle delay
 * and the playback position, remembered across reloads in localStorage under
 * `webtor:watch:<infohash>:<file path>`. Pure apart from the storage it is given; see
 * watch-state.test.ts. The global language preferences (`webtor:audio-lang`,
 * `webtor:subtitle-language`) stay the fallback for videos never opened before and for tracks that
 * can't be found again.
 */
import { defaultSubtitleKey, type SubtitlePreference } from '../subtitles/tracks';
import type { AudioTrackInfo, SubtitleSourceKind, SubtitleTrackInfo } from './types';

export const WATCH_PREFIX = 'webtor:watch:';
/** A user-uploaded subtitle file kept for one video (only the newest few are kept). */
export const UPLOAD_PREFIX = 'webtor:watch-upload:';
/** Videos remembered; the least recently updated ones are evicted beyond this. */
export const MAX_WATCHED = 200;
/** Uploaded subtitle files remembered (they are big next to everything else). */
export const MAX_UPLOADS = 5;
/**
 * Uploads whose stored form (JSON, escapes included) is above this many characters are not
 * remembered. localStorage holds ~5 M characters per origin, shared with everything else.
 */
export const MAX_UPLOAD_CHARS = 1_000_000;
/**
 * All stored uploads together (keys + values) stay under this many characters, so they never crowd
 * out the watch entries, the relay URL or the language preferences.
 */
export const UPLOAD_BUDGET_CHARS = 1_500_000;
/** No resume from the first seconds… */
export const RESUME_MIN_S = 10;
/** …nor from the end: the last 5 % of the video, at most the last 60 s, counts as watched. */
export const FINISHED_FRACTION = 0.05;
export const FINISHED_MAX_S = 60;

/** Enough of `AudioTrackInfo` to find the same track again. */
export interface AudioTrackRef {
  id: number;
  language: string;
  label: string;
  codec: string | null;
}

/** Enough of `SubtitleTrackInfo` to find the same track again. */
export interface SubtitleTrackRef {
  kind: SubtitleSourceKind;
  /** `embedded:<TrackNumber>`, `sidecar:<file index>`; uploads get a new key on every add. */
  key: string;
  language: string;
  label: string;
}

export interface WatchState {
  audio?: AudioTrackRef;
  /** `null` = the user turned subtitles off; absent = never chosen (language default applies). */
  subtitle?: SubtitleTrackRef | null;
  /** Subtitle delay in seconds, when not 0. */
  delay?: number;
  /** Element time the user was at, and the video's duration then (s). */
  position?: number;
  duration?: number;
  /** What the watch history lists and how it reopens the video (ADR 0010). */
  source?: WatchSource;
  /** `Date.now()` of the last write, for eviction (and "last watched" in the history). */
  updated: number;
}

/** How the history names and reopens a video (docs/decisions/0010). */
export interface WatchSource {
  /** Torrent name. */
  name: string;
  /** File name. */
  file: string;
  /** The file sits in a folder of the torrent (its path has a `/`): the history shows its name. */
  multi: boolean;
  /** Index into the torrent's files. */
  index: number;
  /** What reopens it: the magnet / info hash the user gave, or an opened .torrent's `magnetURI`. */
  magnet: string;
  /** Opened from a .torrent file: its bytes may be kept in IndexedDB (torrent-files.ts). */
  fromFile?: boolean;
}

/** A user-uploaded subtitle file, re-added on reopen. */
export interface StoredUpload {
  name: string;
  text: string;
  updated: number;
}

/** The part of `Storage` this module uses (tests pass a fake). */
export type WatchStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/** localStorage, or null where it is blocked (some private modes throw on access). */
export function defaultStorage(): WatchStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Storage key of one video: the torrent's info hash plus the file's path within it. */
export function watchKey(infoHash: string, filePath: string): string {
  return `${WATCH_PREFIX}${infoHash.toLowerCase()}:${filePath}`;
}

const uploadKey = (key: string) => UPLOAD_PREFIX + key.slice(WATCH_PREFIX.length);

export function audioRef(t: AudioTrackInfo): AudioTrackRef {
  return { id: t.id, language: t.language, label: t.label, codec: t.codec };
}

export function subtitleRef(t: SubtitleTrackInfo): SubtitleTrackRef {
  return { kind: t.kind, key: t.key, language: t.language, label: t.label };
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null;
  }
}

/** The stored state of `key`, or null (none, unreadable, storage blocked). */
export function readWatch(key: string, storage = defaultStorage()): WatchState | null {
  try {
    return parse<WatchState>(storage?.getItem(key) ?? null);
  } catch {
    return null;
  }
}

/**
 * Merges `patch` into the state of `key` and stamps it. A new entry evicts the least recently
 * updated ones beyond `MAX_WATCHED`. Storage errors (blocked, quota) are ignored.
 */
export function writeWatch(
  key: string,
  patch: Partial<Omit<WatchState, 'updated'>>,
  { storage = defaultStorage(), now = Date.now() } = {},
): void {
  if (!storage) return;
  try {
    const prev = parse<WatchState>(storage.getItem(key));
    const next: WatchState = { ...prev, ...patch, updated: now };
    if (next.delay === 0) delete next.delay;
    setFreeingUploads(storage, key, JSON.stringify(next));
    if (!prev) evict(storage, WATCH_PREFIX, MAX_WATCHED, (k) => storage.removeItem(uploadKey(k)));
  } catch {
    // Storage blocked or full: this video just isn't remembered.
  }
}

/**
 * `setItem`, and when storage is full, drops stored uploads (oldest first) until it fits: a
 * position or track choice is worth more than a cached subtitle file. Throws when it still fails.
 */
function setFreeingUploads(storage: WatchStorage, key: string, value: string) {
  for (;;) {
    try {
      storage.setItem(key, value);
      return;
    } catch (e) {
      const oldest = entriesOf(storage, UPLOAD_PREFIX)[0];
      if (!oldest) throw e;
      storage.removeItem(oldest.key);
    }
  }
}

interface Entry {
  key: string;
  updated: number;
  /** Characters it takes in storage (key + value). */
  size: number;
}

/** The entries under `prefix`, oldest first (by their `updated`). */
function entriesOf(storage: WatchStorage, prefix: string): Entry[] {
  const entries: Entry[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(prefix)) continue;
    const raw = storage.getItem(key) ?? '';
    const updated = Number(parse<{ updated?: unknown }>(raw)?.updated);
    entries.push({
      key,
      updated: Number.isFinite(updated) ? updated : 0,
      size: key.length + raw.length,
    });
  }
  return entries.sort((a, b) => a.updated - b.updated);
}

/** Removes the oldest entries under `prefix` beyond `max` (by their `updated`). */
function evict(
  storage: WatchStorage,
  prefix: string,
  max: number,
  onEvict?: (key: string) => void,
) {
  const entries = entriesOf(storage, prefix);
  if (entries.length <= max) return;
  for (const { key } of entries.slice(0, entries.length - max)) {
    storage.removeItem(key);
    onEvict?.(key);
  }
}

/** The subtitle file the user uploaded for video `key` (when it was small enough to keep). */
export function readUpload(key: string, storage = defaultStorage()): StoredUpload | null {
  try {
    const u = parse<StoredUpload>(storage?.getItem(uploadKey(key)) ?? null);
    return u && typeof u.name === 'string' && typeof u.text === 'string' ? u : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the uploaded subtitle file of video `key`: one per video, at most `MAX_UPLOADS` and
 * `UPLOAD_BUDGET_CHARS` overall. Older uploads are evicted *before* it is written, so a full
 * storage never blocks eviction. Returns false when it is too big to keep or storage refused it
 * (then the video keeps no upload rather than an older one).
 */
export function writeUpload(
  key: string,
  upload: { name: string; text: string },
  { storage = defaultStorage(), now = Date.now() } = {},
): boolean {
  if (!storage || upload.text.length > MAX_UPLOAD_CHARS) return false;
  const own = uploadKey(key);
  const value = JSON.stringify({
    name: upload.name,
    text: upload.text,
    updated: now,
  } satisfies StoredUpload);
  if (value.length > MAX_UPLOAD_CHARS) return false;
  try {
    let room = UPLOAD_BUDGET_CHARS - own.length - value.length;
    let slots = MAX_UPLOADS - 1;
    for (const e of entriesOf(storage, UPLOAD_PREFIX).reverse()) {
      if (e.key === own) continue;
      if (slots > 0 && e.size <= room) {
        slots--;
        room -= e.size;
      } else {
        storage.removeItem(e.key);
      }
    }
    storage.setItem(own, value);
    return true;
  } catch {
    try {
      storage.removeItem(own);
    } catch {
      // Storage blocked: nothing stored either.
    }
    return false;
  }
}

/**
 * The stored audio track among `tracks`: the same id with the same language and label, else the
 * same language, label and codec (the file was remuxed), else the same id and language. Unsupported
 * tracks never match. Null = not found: the language preference applies.
 */
export function matchAudioTrack(
  tracks: readonly AudioTrackInfo[],
  ref: AudioTrackRef | null | undefined,
): AudioTrackInfo | null {
  if (!ref) return null;
  const playable = tracks.filter((t) => t.playback !== 'unsupported');
  return (
    playable.find((t) => t.id === ref.id && t.language === ref.language && t.label === ref.label) ??
    playable.find(
      (t) => t.language === ref.language && t.label === ref.label && t.codec === ref.codec,
    ) ??
    playable.find((t) => t.id === ref.id && t.language === ref.language) ??
    null
  );
}

/**
 * The stored subtitle track among `tracks`: the same key with the same language and label, else
 * the same kind, language and label (another track number or file index). Uploads are matched by
 * the caller (they get new keys). Null = not found.
 */
export function matchSubtitleTrack(
  tracks: readonly SubtitleTrackInfo[],
  ref: SubtitleTrackRef | null | undefined,
): SubtitleTrackInfo | null {
  if (!ref) return null;
  const usable = tracks.filter((t) => !t.unsupported && t.kind === ref.kind);
  return (
    usable.find((t) => t.key === ref.key && t.language === ref.language && t.label === ref.label) ??
    usable.find((t) => t.language === ref.language && t.label === ref.label) ??
    null
  );
}

/**
 * Where to resume a video of `duration` s last left at `position`: null (start from 0) for the
 * first `RESUME_MIN_S`, the watched end (the last 5 %, at most 60 s) and anything unknown.
 */
export function resumePoint(position: number | undefined, duration: number): number | null {
  if (position === undefined || !Number.isFinite(position) || position < RESUME_MIN_S) return null;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return inWatchedTail(position, duration) ? null : position;
}

const inWatchedTail = (position: number, duration: number) =>
  position >= duration - Math.min(FINISHED_MAX_S, duration * FINISHED_FRACTION);

/**
 * Whether a video left at `position` counts as watched: it reached the watched end (the same tail
 * `resumePoint` doesn't resume from). The first `RESUME_MIN_S` and an unknown duration never do.
 */
export function isWatched(position: number | undefined, duration: number | undefined): boolean {
  if (position === undefined || !Number.isFinite(position) || position < RESUME_MIN_S) return false;
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) return false;
  return inWatchedTail(position, duration);
}

/**
 * The subtitle track to select when a video opens: the stored one (or Off), else the language
 * default (`defaultSubtitleKey`). `'wait'` while the stored track may still be listed (embedded
 * tracks come after the file's header is read): `listed` says every source is in.
 */
export function initialSubtitleKey(
  tracks: readonly SubtitleTrackInfo[],
  stored: SubtitleTrackRef | null | undefined,
  preference: SubtitlePreference,
  listed: boolean,
): string | null | 'wait' {
  if (stored === null) return null;
  if (stored === undefined) return defaultSubtitleKey(tracks, preference);
  const match = matchSubtitleTrack(tracks, stored);
  if (match) return match.key;
  return listed ? defaultSubtitleKey(tracks, preference) : 'wait';
}
