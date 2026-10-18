import { describe, expect, it } from 'vitest';
import { checkRelayUrl, relayEndpoints } from './relay';

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
