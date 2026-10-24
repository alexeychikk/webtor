/**
 * Watch history (docs/decisions/0010): the videos the user watched, newest first, read from the
 * per-video watch entries (`webtor:watch:<infohash>:<path>`, watch-state.ts) that carry a
 * `source`. Pure apart from the storage it is given; see history.test.ts. Eviction stays the watch
 * entries' own (200, least recently updated), so history and resume never diverge.
 */
import { formatTime } from '../player/format';
import {
  UPLOAD_PREFIX,
  WATCH_PREFIX,
  defaultStorage,
  isWatched,
  type WatchSource,
  type WatchState,
  type WatchStorage,
} from '../player/watch-state';

/** Magnets longer than this keep `xt`, `dn`, every `xs`/`ws` and as many `tr` as fit. */
export const MAX_MAGNET_CHARS = 2000;
/** Opened .torrent files kept in IndexedDB: at most this many… */
export const MAX_TORRENT_FILES = 20;
/** …and this many bytes together; the least recently used go first. */
export const MAX_TORRENT_FILE_BYTES = 16 * 1024 * 1024;

export interface HistoryEntry {
  /** The watch entry's storage key. */
  key: string;
  /** Lower-case info hash. */
  infoHash: string;
  /** File path within the torrent. */
  path: string;
  source: WatchSource;
  position?: number;
  duration?: number;
  /** Last watched (`Date.now()`). */
  updated: number;
}

/** `progress`: left mid-way; `watched`: reached the watched end; `playing`: the file open now. */
export type HistoryEntryState = 'progress' | 'watched' | 'playing';

/** What `removeEntry` took out, to put back verbatim (`undoRemove`). */
export interface RemovedEntry {
  key: string;
  values: [key: string, value: string][];
}

function parseSource(v: unknown): WatchSource | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (typeof s.name !== 'string' || typeof s.file !== 'string' || typeof s.magnet !== 'string') {
    return null;
  }
  if (typeof s.index !== 'number' || !Number.isInteger(s.index) || s.index < 0) return null;
  return {
    name: s.name,
    file: s.file,
    multi: s.multi === true,
    index: s.index,
    magnet: s.magnet,
    ...(s.fromFile === true ? { fromFile: true } : {}),
  };
}

const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The history entry stored under `key` and `raw`, or null (not a watch entry, no `source`). */
export function parseEntry(key: string, raw: string | null): HistoryEntry | null {
  if (!key.startsWith(WATCH_PREFIX) || !raw) return null;
  const rest = key.slice(WATCH_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  let state: Partial<WatchState>;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    state = v as Partial<WatchState>;
  } catch {
    return null;
  }
  const source = parseSource(state.source);
  if (!source) return null;
  return {
    key,
    infoHash: rest.slice(0, colon),
    path: rest.slice(colon + 1),
    source,
    position: finite(state.position),
    duration: finite(state.duration),
    updated: finite(state.updated) ?? 0,
  };
}

/** Every watch entry with a `source`, most recently watched first. Storage errors → `[]`. */
export function listHistory(storage: WatchStorage | null = defaultStorage()): HistoryEntry[] {
  if (!storage) return [];
  const entries: HistoryEntry[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(WATCH_PREFIX)) continue;
      const entry = parseEntry(key, storage.getItem(key));
      if (entry) entries.push(entry);
    }
  } catch {
    return [];
  }
  return entries.sort((a, b) => b.updated - a.updated);
}

const uploadKeyOf = (key: string) => UPLOAD_PREFIX + key.slice(WATCH_PREFIX.length);

/**
 * Forgets one video: its watch entry (position, tracks, delay) and its stored upload. Returns what
 * was removed, for `undoRemove`; null when nothing was there or storage refused.
 */
export function removeEntry(
  key: string,
  storage: WatchStorage | null = defaultStorage(),
): RemovedEntry | null {
  if (!storage || !key.startsWith(WATCH_PREFIX)) return null;
  try {
    const values: [string, string][] = [];
    for (const k of [key, uploadKeyOf(key)]) {
      const v = storage.getItem(k);
      if (v === null) continue;
      values.push([k, v]);
      storage.removeItem(k);
    }
    return values.length ? { key, values } : null;
  } catch {
    return null;
  }
}

/** Puts a removed video back exactly as it was. False when storage refused. */
export function undoRemove(
  removed: RemovedEntry,
  storage: WatchStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    for (const [k, v] of removed.values) storage.setItem(k, v);
    return true;
  } catch {
    return false;
  }
}

/**
 * Forgets every video: all `webtor:watch:*` and `webtor:watch-upload:*` keys. Every other key
 * (relay URL, language preferences) stays. Storage errors are ignored.
 */
export function clearHistory(storage: WatchStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(WATCH_PREFIX) || key?.startsWith(UPLOAD_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Storage blocked: nothing to clear.
  }
}

/**
 * `magnet` kept as is up to `max` characters; else only `xt`, `dn`, every `xs`/`ws` and as many
 * `tr` as fit (in order). Anything that is not a magnet link (an info hash) is kept as is.
 */
export function boundedMagnet(magnet: string, max = MAX_MAGNET_CHARS): string {
  if (magnet.length <= max || !/^magnet:\?/i.test(magnet)) return magnet;
  const params = magnet.slice(magnet.indexOf('?') + 1).split('&');
  const name = (p: string) => {
    const i = p.indexOf('=');
    return (i < 0 ? p : p.slice(0, i)).toLowerCase();
  };
  const kept = params.filter((p) => ['xt', 'dn', 'xs', 'ws'].includes(name(p)));
  let length = `magnet:?${kept.join('&')}`.length;
  for (const p of params) {
    if (name(p) !== 'tr' || length + 1 + p.length > max) continue;
    kept.push(p);
    length += 1 + p.length;
  }
  return `magnet:?${kept.join('&')}`;
}

/** The state an entry shows: the file open now, watched, or in progress. */
export function entryState(entry: HistoryEntry, playing: boolean): HistoryEntryState {
  if (playing) return 'playing';
  return isWatched(entry.position, entry.duration) ? 'watched' : 'progress';
}

/** Row line 1: the torrent name; a single-file torrent's is its file name. */
export const entryTitle = (entry: HistoryEntry) =>
  entry.source.multi ? entry.source.name : entry.source.file;

const knownDuration = (d: number | undefined): d is number =>
  d !== undefined && Number.isFinite(d) && d > 0;

/** `12:34 / 1:45:10`, or `12:34` with an unknown duration. */
export function entryTimes(entry: HistoryEntry): string {
  const at = formatTime(entry.position ?? 0);
  return knownDuration(entry.duration) ? `${at} / ${formatTime(entry.duration)}` : at;
}

/** Played fraction for the row's bar, or null (no bar: unknown duration). */
export function entryProgress(entry: HistoryEntry): number | null {
  if (!knownDuration(entry.duration)) return null;
  return Math.min(1, Math.max(0, (entry.position ?? 0) / entry.duration));
}

const DAY_MS = 86_400_000;
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * "Last watched" text: Just now, 5 min ago, 3 h ago (same day), Yesterday, 3 days ago (< 7 days),
 * else the date (`12 Oct`, plus the year when it isn't this one).
 */
export function lastWatchedText(updated: number, now: number, locale?: string): string {
  const ago = now - updated;
  if (ago < 60_000) return 'Just now';
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} min ago`;
  const days = Math.round((startOfDay(now) - startOfDay(updated)) / DAY_MS);
  if (days === 0) return `${Math.floor(ago / 3_600_000)} h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const sameYear = new Date(updated).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(updated);
}

/**
 * The row's accessible name: "Big Buck Bunny, episode-2.mkv, stopped at 12:34 of 1:45:10, 2 h ago";
 * watched: "…, watched, play from the start, Yesterday"; open now: "…, now playing".
 */
export function historyEntryLabel(entry: HistoryEntry, playing: boolean, now: number): string {
  const parts = [entryTitle(entry)];
  if (entry.source.multi) parts.push(entry.source.file);
  const state = entryState(entry, playing);
  if (state === 'playing') return [...parts, 'now playing'].join(', ');
  const when = lastWatchedText(entry.updated, now);
  if (state === 'watched') return [...parts, 'watched', 'play from the start', when].join(', ');
  const at = formatTime(entry.position ?? 0);
  const stopped = knownDuration(entry.duration)
    ? `stopped at ${at} of ${formatTime(entry.duration)}`
    : `stopped at ${at}`;
  return [...parts, stopped, when].join(', ');
}

/** Lower-case info hashes of entries opened from a .torrent (their stored files stay). */
export function torrentFileHashes(entries: readonly HistoryEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.source.fromFile).map((e) => e.infoHash));
}

export interface StoredTorrentFile {
  key: string;
  size: number;
  updated: number;
}

/**
 * Stored .torrent files to drop: beyond the newest `maxFiles`, or past `maxBytes` together
 * (newest kept first). Returns their keys.
 */
export function torrentFilesToEvict(
  files: readonly StoredTorrentFile[],
  maxFiles = MAX_TORRENT_FILES,
  maxBytes = MAX_TORRENT_FILE_BYTES,
): string[] {
  const evict: string[] = [];
  let count = 0;
  let bytes = 0;
  for (const f of [...files].sort((a, b) => b.updated - a.updated)) {
    if (count < maxFiles && bytes + f.size <= maxBytes) {
      count++;
      bytes += f.size;
    } else {
      evict.push(f.key);
    }
  }
  return evict;
}
