import { describe, expect, it } from 'vitest';
import { magnetHash, readFileFromHash, readMagnetFromHash, takeRelayFromHash } from './url-hash';

const magnet =
  'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=wss%3A%2F%2Fx';

describe('url hash', () => {
  it('round-trips a magnet', () => {
    expect(readMagnetFromHash(magnetHash(magnet))).toBe(magnet);
  });
  it('accepts an unencoded magnet', () => {
    expect(readMagnetFromHash(`#magnet=${magnet}`)).toBe(magnet);
  });
  it('accepts a bare info hash and other params after it', () => {
    expect(readMagnetFromHash('#magnet=08ada5a7a6183aae1e09d831df6748d566095a10&file=2')).toBe(
      '08ada5a7a6183aae1e09d831df6748d566095a10',
    );
    expect(readMagnetFromHash('#file=2&magnet=abc')).toBe('abc');
  });
  it('drops our file= param from an unencoded magnet', () => {
    expect(readMagnetFromHash(`#magnet=${magnet}&file=3`)).toBe(magnet);
  });
  it('returns null without a magnet', () => {
    expect(readMagnetFromHash('')).toBeNull();
    expect(readMagnetFromHash('#magnet=')).toBeNull();
    expect(readMagnetFromHash('#foo=1')).toBeNull();
  });
});

describe('file in the hash', () => {
  it('round-trips the file index next to the magnet', () => {
    const hash = magnetHash(magnet, 2);
    expect(hash).toMatch(/^#magnet=magnet%3A.*&file=2$/);
    expect(readMagnetFromHash(hash)).toBe(magnet);
    expect(readFileFromHash(hash)).toBe(2);
    expect(readFileFromHash(`#magnet=${magnet}&file=0`)).toBe(0);
  });
  it('is null when absent or not an index', () => {
    expect(readFileFromHash(magnetHash(magnet))).toBeNull();
    expect(readFileFromHash('#magnet=abc&file=')).toBeNull();
    expect(readFileFromHash('#magnet=abc&file=-1')).toBeNull();
    expect(readFileFromHash('#magnet=abc&file=x')).toBeNull();
  });
});

describe('takeRelayFromHash', () => {
  const relay = 'http://127.0.0.1:7881/0123456789abcdef';
  it('takes the encoded relay URL webtor-relay prints and leaves nothing behind', () => {
    // Go's url.QueryEscape
    expect(takeRelayFromHash('#relay=http%3A%2F%2F127.0.0.1%3A7881%2F0123456789abcdef')).toEqual({
      relayUrl: relay,
      hash: '',
    });
  });
  it('accepts an unencoded relay URL', () => {
    expect(takeRelayFromHash(`#relay=${relay}`)).toEqual({ relayUrl: relay, hash: '' });
  });
  it('keeps a magnet next to it, before or after', () => {
    const encoded = magnetHash(magnet);
    expect(takeRelayFromHash(`#relay=${encodeURIComponent(relay)}&${encoded.slice(1)}`)).toEqual({
      relayUrl: relay,
      hash: encoded,
    });
    expect(takeRelayFromHash(`${encoded}&relay=${encodeURIComponent(relay)}`)).toEqual({
      relayUrl: relay,
      hash: encoded,
    });
    // An unencoded magnet first: `relay=` is not a magnet parameter, so it is taken out of it too.
    const { relayUrl, hash } = takeRelayFromHash(`#magnet=${magnet}&relay=${relay}`);
    expect(relayUrl).toBe(relay);
    expect(readMagnetFromHash(hash)).toBe(magnet);
  });
  it('returns the hash untouched without relay=', () => {
    expect(takeRelayFromHash('#magnet=abc')).toEqual({ relayUrl: null, hash: '#magnet=abc' });
    expect(takeRelayFromHash('')).toEqual({ relayUrl: null, hash: '' });
    // `relay=` inside an encoded magnet is not ours
    const encoded = magnetHash('magnet:?xt=urn:btih:abc&relay=x');
    expect(takeRelayFromHash(encoded).relayUrl).toBeNull();
  });
  it('strips an empty or broken value too', () => {
    expect(takeRelayFromHash('#relay=')).toEqual({ relayUrl: null, hash: '' });
    expect(takeRelayFromHash('#relay=%E0%A4%A&magnet=abc')).toEqual({
      relayUrl: null,
      hash: '#magnet=abc',
    });
  });
});
