import { describe, expect, it } from 'vitest';
import type { AudioTrackInfo, SubtitleTrackInfo } from './types';
import {
  MAX_UPLOADS,
  MAX_UPLOAD_CHARS,
  MAX_WATCHED,
  audioRef,
  initialSubtitleKey,
  matchAudioTrack,
  matchSubtitleTrack,
  readUpload,
  readWatch,
  resumePoint,
  subtitleRef,
  watchKey,
  writeUpload,
  writeWatch,
  type WatchStorage,
} from './watch-state';

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

const throwing: WatchStorage = {
  length: 0,
  key: () => null,
  getItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('full', 'QuotaExceededError');
  },
  removeItem: () => {},
};

const audio = (id: number, language: string, label: string, codec = 'aac'): AudioTrackInfo => ({
  id,
  codec,
  codecString: null,
  language,
  label,
  channels: 2,
  isDefault: false,
  playback: 'copy',
  outputCodec: codec,
});

const sub = (
  key: string,
  language: string,
  label: string,
  kind: SubtitleTrackInfo['kind'] = 'embedded',
): SubtitleTrackInfo => ({ key, kind, renderer: 'text', language, label });

describe('watchKey', () => {
  it('keys by lower-case info hash and file path', () => {
    expect(watchKey('ABCDEF', 'Show/ep1.mkv')).toBe('webtor:watch:abcdef:Show/ep1.mkv');
    expect(watchKey('abc', 'Show/ep1.mkv')).not.toBe(watchKey('abc', 'Show/ep2.mkv'));
  });
});

describe('readWatch / writeWatch', () => {
  it('merges patches per video and stamps them', () => {
    const storage = new FakeStorage();
    const a = watchKey('h', 'a.mkv');
    const b = watchKey('h', 'b.mkv');
    writeWatch(a, { position: 20, duration: 40 }, { storage, now: 1 });
    writeWatch(a, { subtitle: null }, { storage, now: 2 });
    writeWatch(b, { position: 5 }, { storage, now: 3 });
    expect(readWatch(a, storage)).toEqual({
      position: 20,
      duration: 40,
      subtitle: null,
      updated: 2,
    });
    expect(readWatch(b, storage)).toEqual({ position: 5, updated: 3 });
    expect(readWatch(watchKey('h', 'c.mkv'), storage)).toBeNull();
  });

  it('drops a zero delay', () => {
    const storage = new FakeStorage();
    writeWatch('webtor:watch:h:a', { delay: 1.5 }, { storage, now: 1 });
    writeWatch('webtor:watch:h:a', { delay: 0 }, { storage, now: 2 });
    expect(readWatch('webtor:watch:h:a', storage)).toEqual({ updated: 2 });
  });

  it('evicts the least recently updated videos beyond the limit, with their uploads', () => {
    const storage = new FakeStorage();
    storage.setItem('webtor:audio-lang', 'eng');
    for (let i = 0; i < MAX_WATCHED; i++) {
      writeWatch(watchKey('h', `f${i}`), { position: i }, { storage, now: 1000 + i });
    }
    writeUpload(watchKey('h', 'f0'), { name: 'a.srt', text: 'x' }, { storage });
    // f0 is touched again, so f1 is now the oldest.
    writeWatch(watchKey('h', 'f0'), { position: 1 }, { storage, now: 5000 });
    writeWatch(watchKey('h', 'new'), { position: 1 }, { storage, now: 6000 });
    const watched = [...storage.map.keys()].filter((k) => k.startsWith('webtor:watch:'));
    expect(watched).toHaveLength(MAX_WATCHED);
    expect(readWatch(watchKey('h', 'f1'), storage)).toBeNull();
    expect(readWatch(watchKey('h', 'f0'), storage)).not.toBeNull();
    expect(readUpload(watchKey('h', 'f0'), storage)).not.toBeNull();
    expect(storage.getItem('webtor:audio-lang')).toBe('eng');
  });

  it('ignores blocked or full storage and unreadable entries', () => {
    expect(() =>
      writeWatch('webtor:watch:h:a', { position: 3 }, { storage: throwing }),
    ).not.toThrow();
    expect(readWatch('webtor:watch:h:a', throwing)).toBeNull();
    expect(readWatch('webtor:watch:h:a', null)).toBeNull();
    const storage = new FakeStorage();
    storage.setItem('webtor:watch:h:a', '{not json');
    expect(readWatch('webtor:watch:h:a', storage)).toBeNull();
    writeWatch('webtor:watch:h:a', { position: 3 }, { storage, now: 1 });
    expect(readWatch('webtor:watch:h:a', storage)).toEqual({ position: 3, updated: 1 });
  });
});

describe('uploads', () => {
  it('keeps small uploads, the newest few only', () => {
    const storage = new FakeStorage();
    for (let i = 0; i <= MAX_UPLOADS; i++) {
      expect(
        writeUpload(watchKey('h', `f${i}`), { name: `${i}.srt`, text: 'x' }, { storage, now: i }),
      ).toBe(true);
    }
    expect(readUpload(watchKey('h', 'f0'), storage)).toBeNull();
    expect(readUpload(watchKey('h', `f${MAX_UPLOADS}`), storage)).toMatchObject({
      name: `${MAX_UPLOADS}.srt`,
      text: 'x',
    });
  });

  it('refuses big files and blocked storage', () => {
    const storage = new FakeStorage();
    const text = 'x'.repeat(MAX_UPLOAD_CHARS + 1);
    expect(writeUpload(watchKey('h', 'a'), { name: 'big.ass', text }, { storage })).toBe(false);
    expect(readUpload(watchKey('h', 'a'), storage)).toBeNull();
    expect(
      writeUpload(watchKey('h', 'a'), { name: 'a.srt', text: 'x' }, { storage: throwing }),
    ).toBe(false);
  });
});

describe('matchAudioTrack', () => {
  const tracks = [audio(1, 'eng', 'English'), audio(2, 'rus', 'Russian', 'ac3')];

  it('finds the stored track by id, then by language + label + codec, then by id + language', () => {
    expect(matchAudioTrack(tracks, audioRef(tracks[1]!))?.id).toBe(2);
    expect(matchAudioTrack(tracks, { ...audioRef(tracks[1]!), id: 7 })?.id).toBe(2);
    expect(matchAudioTrack(tracks, { ...audioRef(tracks[1]!), label: 'Dub' })?.id).toBe(2);
  });

  it('returns null (language preference applies) when the track is gone or unplayable', () => {
    expect(matchAudioTrack(tracks, null)).toBeNull();
    expect(
      matchAudioTrack(tracks, { id: 9, language: 'jpn', label: 'J', codec: 'aac' }),
    ).toBeNull();
    const unsupported = [tracks[0]!, { ...tracks[1]!, playback: 'unsupported' as const }];
    expect(matchAudioTrack(unsupported, audioRef(tracks[1]!))).toBeNull();
  });
});

describe('matchSubtitleTrack', () => {
  const tracks = [
    sub('embedded:3', 'eng', 'English'),
    sub('embedded:4', 'eng', 'English SDH'),
    sub('sidecar:2', 'eng', 'movie.en.srt', 'sidecar'),
  ];

  it('tells same-language tracks apart', () => {
    expect(matchSubtitleTrack(tracks, subtitleRef(tracks[1]!))?.key).toBe('embedded:4');
    expect(matchSubtitleTrack(tracks, subtitleRef(tracks[0]!))?.key).toBe('embedded:3');
  });

  it('finds a sidecar by file and falls back to kind + language + label', () => {
    expect(matchSubtitleTrack(tracks, subtitleRef(tracks[2]!))?.key).toBe('sidecar:2');
    expect(matchSubtitleTrack(tracks, { ...subtitleRef(tracks[1]!), key: 'embedded:9' })?.key).toBe(
      'embedded:4',
    );
  });

  it('returns null when the track is not there (yet)', () => {
    expect(matchSubtitleTrack(tracks, null)).toBeNull();
    expect(matchSubtitleTrack(tracks, { ...subtitleRef(tracks[0]!), label: 'Signs' })).toBeNull();
    expect(matchSubtitleTrack(tracks.slice(2), subtitleRef(tracks[0]!))).toBeNull();
  });
});

describe('resumePoint', () => {
  it('resumes in the middle', () => {
    expect(resumePoint(20, 40)).toBe(20);
    expect(resumePoint(3600, 7200)).toBe(3600);
  });

  it('starts over near the start, near the end and when unknown', () => {
    expect(resumePoint(undefined, 40)).toBeNull();
    expect(resumePoint(9.9, 40)).toBeNull();
    // Last 5 %…
    expect(resumePoint(38.5, 40)).toBeNull();
    expect(resumePoint(37.9, 40)).toBe(37.9);
    // …at most the last 60 s.
    expect(resumePoint(7200 - 61, 7200)).toBe(7139);
    expect(resumePoint(7200 - 59, 7200)).toBeNull();
    expect(resumePoint(20, NaN)).toBeNull();
  });
});

describe('initialSubtitleKey', () => {
  const tracks = [sub('embedded:3', 'eng', 'English'), sub('embedded:4', 'eng', 'English SDH')];

  it('restores the stored track or Off', () => {
    expect(initialSubtitleKey(tracks, subtitleRef(tracks[1]!), 'eng', false)).toBe('embedded:4');
    expect(initialSubtitleKey(tracks, null, 'eng', false)).toBeNull();
  });

  it('falls back to the language preference for new videos and lost tracks', () => {
    expect(initialSubtitleKey(tracks, undefined, 'eng', false)).toBe('embedded:3');
    const gone = { ...subtitleRef(tracks[1]!), label: 'Signs' };
    expect(initialSubtitleKey(tracks, gone, 'eng', false)).toBe('wait');
    expect(initialSubtitleKey(tracks, gone, 'eng', true)).toBe('embedded:3');
    expect(initialSubtitleKey(tracks, gone, 'off', true)).toBeNull();
  });
});
