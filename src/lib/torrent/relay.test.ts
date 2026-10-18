import { describe, expect, it } from 'vitest';
import {
  checkRelayUrl,
  mergeRelayStats,
  parseRelayInfo,
  parseRelayStats,
  relayEndpoints,
  relayErrorCode,
  relayErrorDetail,
  relayTorrentRef,
} from './relay';

describe('checkRelayUrl', () => {
  it('normalises a local relay URL', () => {
    expect(checkRelayUrl(' http://127.0.0.1:7881/0123456789abcdef/ ', 'https:')).toEqual({
      ok: true,
      base: 'http://127.0.0.1:7881/0123456789abcdef',
    });
  });
  it('allows remote relays only over https from an https page', () => {
    expect(checkRelayUrl('http://relay.example/0123456789', 'https:')).toEqual({
      ok: false,
      reason: 'mixed-content',
    });
    expect(checkRelayUrl('https://relay.example/0123456789', 'https:').ok).toBe(true);
    expect(checkRelayUrl('http://relay.example/0123456789', 'http:').ok).toBe(true);
  });
  it('needs a token path segment', () => {
    expect(checkRelayUrl('http://127.0.0.1:7881', 'https:')).toEqual({
      ok: false,
      reason: 'no-token',
    });
    expect(checkRelayUrl('http://127.0.0.1:7881/a/b', 'https:')).toEqual({
      ok: false,
      reason: 'no-token',
    });
  });
  it('rejects other schemes and garbage', () => {
    expect(checkRelayUrl('ws://127.0.0.1:7881/0123456789', 'https:').ok).toBe(false);
    expect(checkRelayUrl('not a url', 'https:').ok).toBe(false);
  });
});

describe('relayEndpoints', () => {
  it('builds the relay API URLs and keeps the magnet query as is', () => {
    const e = relayEndpoints(
      'http://127.0.0.1:7881/tok12345',
      'DAFC8C076CA2F3ED376EEAE7C76A0D6BE2415C45',
      'xt=urn:btih:dafc&tr=udp%3A%2F%2Ftracker.example%3A1337',
    );
    const t = 'http://127.0.0.1:7881/tok12345/v1/torrents/dafc8c076ca2f3ed376eeae7c76a0d6be2415c45';
    expect(e).toEqual({
      info: 'http://127.0.0.1:7881/tok12345/v1/info',
      metainfo: `${t}/metainfo?xt=urn:btih:dafc&tr=udp%3A%2F%2Ftracker.example%3A1337`,
      files: `${t}/files`,
      stats: `${t}/stats`,
      webseed: `${t}/webseed/`,
    });
  });
});

describe('relayTorrentRef', () => {
  const hex = '08ada5a7a6183aae1e09d831df6748d566095a10';
  it('passes the magnet query through untouched', () => {
    const q = `xt=urn:btih:${hex.toUpperCase()}&dn=Sintel&tr=udp%3A%2F%2Ft%3A1337&x.pe=1.2.3.4%3A5&ws=https%3A%2F%2Fw%2Fa`;
    expect(relayTorrentRef(`magnet:?${q}`)).toEqual({
      infoHash: hex,
      magnetQuery: q,
      ws: ['https://w/a'],
    });
  });
  it('converts base32 info hashes and bare hashes', () => {
    const b32 = 'BCW2LJ5GDA5K4HQJ3AY56Z2I2VTASWQQ';
    expect(relayTorrentRef(b32)).toEqual({
      infoHash: hex,
      magnetQuery: `xt=urn:btih:${hex}`,
      ws: [],
    });
    expect(relayTorrentRef(`magnet:?xt=urn:btih:${b32}`)?.infoHash).toBe(hex);
    expect(relayTorrentRef(hex.toUpperCase())?.infoHash).toBe(hex);
  });
  it('rejects input without a BitTorrent info hash', () => {
    expect(relayTorrentRef('magnet:?xt=urn:sha1:abc')).toBeNull();
    expect(relayTorrentRef('nope')).toBeNull();
  });
});

describe('relay error mapping', () => {
  it('maps failures to error codes', () => {
    expect(relayErrorCode({ kind: 'network' })).toBe('relay-unreachable');
    expect(relayErrorCode({ kind: 'http', status: 504 })).toBe('relay-no-metadata');
    expect(relayErrorCode({ kind: 'timeout' })).toBe('relay-no-metadata');
    expect(relayErrorCode({ kind: 'http', status: 429, message: 'too many torrents' })).toBe(
      'relay-error',
    );
    expect(relayErrorCode({ kind: 'http', status: 404 })).toBe('relay-error');
    expect(relayErrorCode({ kind: 'http', status: 400 })).toBe('relay-error');
    expect(relayErrorCode({ kind: 'bad-response' })).toBe('relay-error');
  });
  it('explains HTTP failures without the relay URL', () => {
    expect(relayErrorDetail({ kind: 'http', status: 429, message: 'too many torrents' })).toBe(
      'HTTP 429: too many torrents',
    );
    expect(relayErrorDetail({ kind: 'http', status: 404 })).toMatch(/^HTTP 404 — wrong token/);
    expect(relayErrorDetail({ kind: 'network' })).toBeUndefined();
  });
});

describe('relay responses', () => {
  it('recognises /v1/info', () => {
    expect(parseRelayInfo({ name: 'webtor-relay', version: '0.1.0', api: 1 })).toEqual({
      name: 'webtor-relay',
      version: '0.1.0',
      api: 1,
    });
    expect(parseRelayInfo({ name: 'nginx' })).toBeNull();
    expect(parseRelayInfo('<html>')).toBeNull();
    expect(parseRelayInfo(null)).toBeNull();
  });
  it('reads /stats', () => {
    expect(
      parseRelayStats({
        peers: 9,
        activePeers: 4,
        seeders: 2,
        hasMetadata: true,
        bytesCompleted: 1,
      }),
    ).toEqual({ activePeers: 4, seeders: 2, hasMetadata: true });
    expect(parseRelayStats({ error: 'torrent not added' })).toBeNull();
  });
});

describe('mergeRelayStats', () => {
  const base = { numPeers: 3, downloadSpeed: 1000, uploadSpeed: 10, progress: 0.5 };
  it('replaces the relay web seed wire with the swarm behind it', () => {
    // 2 WebRTC peers + 1 web seed (the relay) in WebTorrent, 7 peers at the relay
    expect(mergeRelayStats(base, 1, { activePeers: 7, seeders: 1, hasMetadata: true })).toEqual({
      ...base,
      numPeers: 9,
      relayPeers: 7,
    });
  });
  it('works before WebTorrent has any wire', () => {
    const zero = { numPeers: 0, downloadSpeed: 0, uploadSpeed: 0, progress: 0 };
    expect(mergeRelayStats(zero, 0, { activePeers: 2, seeders: 0, hasMetadata: false })).toEqual({
      ...zero,
      numPeers: 2,
      relayPeers: 2,
    });
  });
  it('leaves stats alone without relay stats', () => {
    expect(mergeRelayStats(base, 1, null)).toBe(base);
  });
});
