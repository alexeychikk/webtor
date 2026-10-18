import { describe, expect, it } from 'vitest';
import { announceList, DEFAULT_WS_TRACKERS, isTorrentId, prepareTorrentId } from './trackers';

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

describe('prepareTorrentId', () => {
  it('turns a bare info hash into a magnet with the default trackers', () => {
    const { torrentId, announce } = prepareTorrentId(' 08ADA5A7A6183AAE1E09D831DF6748D566095A10 ');
    expect(torrentId).toBe('magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10');
    expect(announce).toEqual([...DEFAULT_WS_TRACKERS]);
  });
  it('drops unreachable trackers and keeps xs=, ws= and ws trackers untouched', () => {
    const magnet =
      'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=a+b' +
      '&tr=udp%3A%2F%2Ftracker.example%3A1337&tr=ws%3A%2F%2F127.0.0.1%3A8000' +
      '&xs=http%3A%2F%2F127.0.0.1%3A9000%2Fa.torrent&ws=http%3A%2F%2F127.0.0.1%3A9000%2Fa';
    const { torrentId, announce } = prepareTorrentId(magnet);
    expect(torrentId).toBe(
      'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=a+b' +
        '&tr=ws%3A%2F%2F127.0.0.1%3A8000' +
        '&xs=http%3A%2F%2F127.0.0.1%3A9000%2Fa.torrent&ws=http%3A%2F%2F127.0.0.1%3A9000%2Fa',
    );
    expect(announce[0]).toBe('ws://127.0.0.1:8000');
    expect(announce).not.toContain('udp://tracker.example:1337');
  });
});
