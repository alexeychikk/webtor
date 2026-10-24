import { describe, expect, it } from 'vitest';
import { formatSpeed } from '../player/format';
import {
  checkRelayUrl,
  mergeRelayStats,
  parseRelayInfo,
  parseRelayStats,
  relayEndpoints,
  relayRateRows,
  relayErrorCode,
  relayErrorDetail,
  relayTorrentMissing,
  relayTorrentRef,
  relayTranscodeErrorCode,
  transcodeSummary,
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
      transcode: expect.any(Function),
    });
  });
  it('builds the transcode URL with the start in element seconds', () => {
    const e = relayEndpoints('http://127.0.0.1:7881/tok12345', 'ab'.repeat(20));
    const t = `http://127.0.0.1:7881/tok12345/v1/torrents/${'ab'.repeat(20)}/transcode`;
    expect(e.transcode(3, 0)).toBe(`${t}/3?start=0`);
    expect(e.transcode(0, 8.123456)).toBe(`${t}/0?start=8.123`);
    expect(e.transcode(0, -1)).toBe(`${t}/0?start=0`);
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
      'relay-busy',
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
    const off = { available: false, ffmpeg: '', maxHeight: 0, preset: '' };
    expect(parseRelayInfo({ name: 'webtor-relay', version: '0.1.0', api: 1 })).toEqual({
      name: 'webtor-relay',
      version: '0.1.0',
      api: 1,
      transcode: off,
    });
    const transcode = { available: true, ffmpeg: '7.0.2', maxHeight: 720, preset: 'veryfast' };
    expect(
      parseRelayInfo({
        name: 'webtor-relay',
        version: '0.2.0',
        api: 2,
        transcode: { ...transcode, maxTranscodes: 1 },
      }),
    ).toEqual({ name: 'webtor-relay', version: '0.2.0', api: 2, transcode });
    expect(
      parseRelayInfo({ name: 'webtor-relay', api: 2, transcode: { ...off, ffmpeg: 'x' } })
        ?.transcode,
    ).toEqual(off);
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
  it('reads the rates of api 3', () => {
    expect(
      parseRelayStats({
        activePeers: 4,
        seeders: 2,
        hasMetadata: true,
        downloadRate: 9_800_000,
        uploadRate: 1_048_576,
        servedRate: 5_100_000,
        uploadLimit: 1_048_576,
      })?.rates,
    ).toEqual({
      download: 9_800_000,
      upload: 1_048_576,
      served: 5_100_000,
      uploadLimit: 1_048_576,
    });
    // Upload rate and limit are optional; garbage never becomes a rate.
    expect(
      parseRelayStats({ activePeers: 1, downloadRate: 5, servedRate: -1, uploadRate: 'x' })?.rates,
    ).toEqual({ download: 5, upload: 0, served: 0, uploadLimit: 0 });
    expect(parseRelayStats({ activePeers: 1, downloadRate: 5 })?.rates).toBeUndefined();
  });
});

describe('relayRateRows', () => {
  const rates = { download: 9_800_000, upload: 1_000_000, served: 5_100_000, uploadLimit: 0 };
  it('labels swarm, peers and browser rates', () => {
    expect(relayRateRows(rates, formatSpeed)).toEqual([
      { key: 'download', label: 'From swarm', value: '9.8 MB/s' },
      { key: 'upload', label: 'To peers', value: '1.0 MB/s' },
      { key: 'served', label: 'To you', value: '5.1 MB/s' },
    ]);
  });
  it('shows the upload cap, or that upload is off', () => {
    const capped = relayRateRows({ ...rates, uploadLimit: 1_048_576 }, formatSpeed);
    expect(capped[1]!.value).toBe('1.0 MB/s (max 1.0 MB/s)');
    expect(relayRateRows({ ...rates, uploadLimit: -1 }, formatSpeed)[1]!.value).toBe('off');
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
  it('passes the relay rates on', () => {
    const rates = { download: 1, upload: 2, served: 3, uploadLimit: 0 };
    expect(
      mergeRelayStats(base, 1, { activePeers: 1, seeders: 0, hasMetadata: true, rates }).relayRates,
    ).toBe(rates);
  });
});

describe('relay video conversion', () => {
  it('maps transcode failures to their own codes', () => {
    const http = (status: number, message?: string) => ({ kind: 'http' as const, status, message });
    expect(relayTranscodeErrorCode(http(503, 'transcode-unavailable'))).toBe(
      'relay-transcode-unavailable',
    );
    expect(relayTranscodeErrorCode(http(429, 'transcode-busy'))).toBe('relay-transcode-busy');
    expect(relayTranscodeErrorCode(http(422, 'transcode-failed'))).toBe('relay-transcode-failed');
    expect(relayTranscodeErrorCode(http(504))).toBe('relay-transcode-failed');
    expect(relayTranscodeErrorCode({ kind: 'timeout' })).toBe('relay-transcode-failed');
    expect(relayTranscodeErrorCode(http(503, 'no metadata yet'))).toBe('relay-error');
    expect(relayTranscodeErrorCode(http(404))).toBe('relay-error');
    expect(relayTranscodeErrorCode({ kind: 'network' })).toBe('relay-unreachable');
  });
  it('summarises the relay’s conversion setting for the dialog', () => {
    expect(
      transcodeSummary({ available: true, ffmpeg: '7.0.2', maxHeight: 720, preset: 'veryfast' }),
    ).toBe('Video conversion: on (ffmpeg 7.0.2, up to 720p).');
    expect(transcodeSummary({ available: true, ffmpeg: '', maxHeight: 0, preset: '' })).toBe(
      'Video conversion: on.',
    );
    expect(transcodeSummary({ available: false, ffmpeg: '', maxHeight: 0, preset: '' })).toMatch(
      /^Video conversion: off\. .*install ffmpeg/,
    );
  });
});

describe('relayTorrentMissing', () => {
  it('spots the relay that lost the torrent, not a wrong token or a bad file index', () => {
    const http = (status: number, message?: string) => ({ kind: 'http' as const, status, message });
    expect(relayTorrentMissing(http(404, 'torrent not added; fetch metainfo first'))).toBe(true);
    expect(relayTorrentMissing(http(404))).toBe(false);
    expect(relayTorrentMissing(http(404, 'no file 3 in this torrent'))).toBe(false);
    expect(relayTorrentMissing(http(503, 'torrent not added; fetch metainfo first'))).toBe(false);
    expect(relayTorrentMissing({ kind: 'network' })).toBe(false);
  });
});
