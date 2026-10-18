import { describe, expect, it } from 'vitest';
import { announceList, DEFAULT_WS_TRACKERS, isTorrentId } from './trackers';

describe('isTorrentId', () => {
  it('accepts magnets and bare info hashes', () => {
    expect(
      isTorrentId('magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel'),
    ).toBe(true);
    expect(isTorrentId(' 08ada5a7a6183aae1e09d831df6748d566095a10 ')).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isTorrentId('https://example.com/file.torrent')).toBe(false);
    expect(isTorrentId('magnet:?dn=nothing')).toBe(false);
  });
});

describe('announceList', () => {
  it('keeps only websocket trackers and appends defaults once', () => {
    const list = announceList([
      'udp://tracker.example:1337',
      'ws://127.0.0.1:8000',
      DEFAULT_WS_TRACKERS[0]!,
    ]);
    expect(list[0]).toBe('ws://127.0.0.1:8000');
    expect(list).not.toContain('udp://tracker.example:1337');
    expect(new Set(list).size).toBe(list.length);
  });
});
