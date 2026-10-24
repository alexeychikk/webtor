import { describe, expect, it } from 'vitest';
import { watchKey, writeUpload, writeWatch, type WatchStorage } from '../player/watch-state';
import {
  MAX_TORRENT_FILES,
  boundedMagnet,
  clearHistory,
  entryProgress,
  entryState,
  entryTimes,
  entryTitle,
  historyEntryLabel,
  lastWatchedText,
  listHistory,
  removeEntry,
  torrentFileHashes,
  torrentFilesToEvict,
  undoRemove,
  type HistoryEntry,
} from './history';

class FakeStorage implements WatchStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

class BrokenStorage extends FakeStorage {
  override get length(): number {
    throw new DOMException('blocked', 'SecurityError');
  }
  override getItem(): string | null {
    throw new DOMException('blocked', 'SecurityError');
  }
  override setItem() {
    throw new DOMException('full', 'QuotaExceededError');
  }
}

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const source = (name: string, file: string, index = 0, extra = {}) => ({
  name,
  file,
  multi: name !== file,
  index,
  magnet: `magnet:?xt=urn:btih:${HASH_A}`,
  ...extra,
});

function seed(storage: FakeStorage) {
  writeWatch(
    watchKey(HASH_A, 'Show/ep1.mkv'),
    { position: 100, duration: 1000, source: source('Show', 'ep1.mkv', 0) },
    { storage, now: 1000 },
  );
  writeWatch(
    watchKey(HASH_A, 'Show/ep2.mkv'),
    { position: 990, duration: 1000, source: source('Show', 'ep2.mkv', 1) },
    { storage, now: 3000 },
  );
  // A track picked before the first position save: no source, not listed.
  writeWatch(watchKey(HASH_B, 'movie.mkv'), { delay: 1 }, { storage, now: 5000 });
  writeWatch(
    watchKey(HASH_B, 'other.mkv'),
    { position: 5, source: source('other.mkv', 'other.mkv', 0, { fromFile: true }) },
    { storage, now: 2000 },
  );
}

describe('listHistory', () => {
  it('lists entries with a source, most recently watched first', () => {
    const storage = new FakeStorage();
    seed(storage);
    storage.setItem('webtor:relay-url', 'https://relay.example/');
    storage.setItem(`webtor:watch:${HASH_A}:broken.mkv`, '{not json');
    const list = listHistory(storage);
    expect(list.map((e) => e.path)).toEqual(['Show/ep2.mkv', 'other.mkv', 'Show/ep1.mkv']);
    expect(list[0]).toMatchObject({
      key: `webtor:watch:${HASH_A}:Show/ep2.mkv`,
      infoHash: HASH_A,
      position: 990,
      duration: 1000,
      updated: 3000,
      source: { name: 'Show', file: 'ep2.mkv', multi: true, index: 1 },
    });
    expect(list[1]!.source.fromFile).toBe(true);
  });

  it('skips sources that are not well-formed', () => {
    const storage = new FakeStorage();
    storage.setItem(
      `webtor:watch:${HASH_A}:x.mkv`,
      JSON.stringify({ updated: 1, source: { name: 'x', file: 'x', index: -1, magnet: 'm' } }),
    );
    storage.setItem(`webtor:watch:${HASH_A}:y.mkv`, JSON.stringify({ updated: 1, source: 'y' }));
    expect(listHistory(storage)).toEqual([]);
  });

  it('ignores storage errors', () => {
    expect(listHistory(new BrokenStorage())).toEqual([]);
    expect(listHistory(null)).toEqual([]);
  });
});

describe('removeEntry / undoRemove', () => {
  it('forgets the video with its upload, and undo restores the exact values', () => {
    const storage = new FakeStorage();
    seed(storage);
    const key = watchKey(HASH_A, 'Show/ep1.mkv');
    writeUpload(
      key,
      { name: 'subs.srt', text: '1\n00:00:01,000 --> 00:00:02,000\nHi' },
      { storage },
    );
    const before = new Map(storage.map);
    const removed = removeEntry(key, storage);
    expect(removed?.values.map(([k]) => k)).toEqual([
      key,
      `webtor:watch-upload:${HASH_A}:Show/ep1.mkv`,
    ]);
    expect(storage.getItem(key)).toBeNull();
    expect(listHistory(storage).map((e) => e.path)).toEqual(['Show/ep2.mkv', 'other.mkv']);
    expect(undoRemove(removed!, storage)).toBe(true);
    expect(new Map([...storage.map].sort())).toEqual(new Map([...before].sort()));
  });

  it('returns null for nothing stored or broken storage', () => {
    expect(removeEntry(watchKey(HASH_A, 'none'), new FakeStorage())).toBeNull();
    expect(removeEntry(watchKey(HASH_A, 'none'), new BrokenStorage())).toBeNull();
    expect(removeEntry('webtor:relay-url', new FakeStorage())).toBeNull();
    expect(undoRemove({ key: 'k', values: [['k', 'v']] }, new BrokenStorage())).toBe(false);
  });
});

describe('clearHistory', () => {
  it('removes only the watch entries and uploads', () => {
    const storage = new FakeStorage();
    seed(storage);
    writeUpload(watchKey(HASH_A, 'Show/ep1.mkv'), { name: 's.srt', text: 'x' }, { storage });
    storage.setItem('webtor:relay-url', 'https://relay.example/');
    storage.setItem('webtor:audio-lang', 'en');
    storage.setItem('webtor:subtitle-language', 'off');
    storage.setItem('other-app', '1');
    clearHistory(storage);
    expect([...storage.map.keys()].sort()).toEqual([
      'other-app',
      'webtor:audio-lang',
      'webtor:relay-url',
      'webtor:subtitle-language',
    ]);
  });

  it('ignores storage errors', () => {
    expect(() => clearHistory(new BrokenStorage())).not.toThrow();
  });
});

describe('boundedMagnet', () => {
  const xt = `xt=urn:btih:${HASH_A}`;
  it('keeps a short magnet or an info hash as is', () => {
    const m = `magnet:?${xt}&dn=x&tr=wss%3A%2F%2Ft`;
    expect(boundedMagnet(m)).toBe(m);
    expect(boundedMagnet(HASH_A, 10)).toBe(HASH_A);
  });

  it('keeps xt, dn, xs and ws and as many trackers as fit', () => {
    const trs = Array.from({ length: 50 }, (_, i) => `tr=udp%3A%2F%2Ftracker${i}.example%3A80`);
    const m = `magnet:?${xt}&${trs.slice(0, 2).join('&')}&dn=Name&xs=http%3A%2F%2Fx%2Fa.torrent&ws=http%3A%2F%2Fw%2F&${trs.slice(2).join('&')}&foo=bar`;
    const out = boundedMagnet(m, 300);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toMatch(
      new RegExp(
        `^magnet:\\?${xt}&dn=Name&xs=http%3A%2F%2Fx%2Fa\\.torrent&ws=http%3A%2F%2Fw%2F&${trs[0]}&${trs[1]}&`,
      ),
    );
    expect(out).not.toContain('foo=');
    const kept = out.split('&').filter((p) => p.startsWith('tr='));
    expect(kept).toEqual(trs.slice(0, kept.length));
    expect(kept.length).toBeGreaterThan(2);
  });
});

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  key: watchKey(HASH_A, 'Show/ep2.mkv'),
  infoHash: HASH_A,
  path: 'Show/ep2.mkv',
  source: source('Show', 'ep2.mkv', 1),
  position: 754,
  duration: 6310,
  updated: 0,
  ...over,
});

describe('entry text', () => {
  const now = new Date(2026, 9, 24, 15, 0).getTime();
  const twoHoursAgo = now - 2 * 3_600_000;

  it('titles, times and progress', () => {
    expect(entryTitle(entry())).toBe('Show');
    expect(entryTitle(entry({ source: source('movie.mkv', 'movie.mkv') }))).toBe('movie.mkv');
    expect(entryTimes(entry())).toBe('12:34 / 1:45:10');
    expect(entryTimes(entry({ duration: undefined }))).toBe('12:34');
    expect(entryProgress(entry({ position: 30, duration: 120 }))).toBe(0.25);
    expect(entryProgress(entry({ duration: undefined }))).toBeNull();
  });

  it('states: playing, watched, in progress', () => {
    expect(entryState(entry(), true)).toBe('playing');
    expect(entryState(entry({ position: 6300 }), false)).toBe('watched');
    expect(entryState(entry(), false)).toBe('progress');
    // Under 10 s never counts as watched.
    expect(entryState(entry({ position: 8, duration: 8 }), false)).toBe('progress');
  });

  it('historyEntryLabel', () => {
    expect(historyEntryLabel(entry({ updated: twoHoursAgo }), false, now)).toBe(
      'Show, ep2.mkv, stopped at 12:34 of 1:45:10, 2 h ago',
    );
    expect(
      historyEntryLabel(
        entry({ updated: twoHoursAgo, duration: undefined, source: source('a.mkv', 'a.mkv') }),
        false,
        now,
      ),
    ).toBe('a.mkv, stopped at 12:34, 2 h ago');
    expect(historyEntryLabel(entry({ position: 6300, updated: twoHoursAgo }), false, now)).toBe(
      'Show, ep2.mkv, watched, play from the start, 2 h ago',
    );
    expect(historyEntryLabel(entry(), true, now)).toBe('Show, ep2.mkv, now playing');
  });

  it('lastWatchedText', () => {
    const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
    expect(lastWatchedText(now - 30_000, now)).toBe('Just now');
    expect(lastWatchedText(now + 60_000, now)).toBe('Just now');
    expect(lastWatchedText(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(lastWatchedText(at(24, 12), now)).toBe('3 h ago');
    expect(lastWatchedText(at(23, 23, 30), at(24, 1))).toBe('Yesterday');
    expect(lastWatchedText(at(23, 10), now)).toBe('Yesterday');
    expect(lastWatchedText(at(21, 10), now)).toBe('3 days ago');
    expect(lastWatchedText(at(12, 10), now, 'en-GB')).toBe('12 Oct');
    expect(lastWatchedText(new Date(2025, 11, 30).getTime(), now, 'en-GB')).toBe('30 Dec 2025');
  });
});

describe('stored .torrent files', () => {
  it('torrentFileHashes: the info hashes of entries opened from a file', () => {
    const storage = new FakeStorage();
    seed(storage);
    expect([...torrentFileHashes(listHistory(storage))]).toEqual([HASH_B]);
  });

  it('torrentFilesToEvict: beyond the count or the bytes, oldest first', () => {
    const files = Array.from({ length: MAX_TORRENT_FILES + 2 }, (_, i) => ({
      key: `k${i}`,
      size: 100,
      updated: i,
    }));
    expect(torrentFilesToEvict(files).sort()).toEqual(['k0', 'k1']);
    expect(
      torrentFilesToEvict(
        [
          { key: 'old', size: 600, updated: 1 },
          { key: 'new', size: 600, updated: 3 },
          { key: 'mid', size: 300, updated: 2 },
        ],
        20,
        1000,
      ),
    ).toEqual(['old']);
  });
});
