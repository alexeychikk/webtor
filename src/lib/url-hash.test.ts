import { describe, expect, it } from 'vitest';
import { magnetHash, readMagnetFromHash } from './url-hash';

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
  it('returns null without a magnet', () => {
    expect(readMagnetFromHash('')).toBeNull();
    expect(readMagnetFromHash('#magnet=')).toBeNull();
    expect(readMagnetFromHash('#foo=1')).toBeNull();
  });
});
