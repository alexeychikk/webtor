import { describe, expect, it } from 'vitest';
import { hdrFormatOf, toneMapped } from './hdr';

describe('hdrFormatOf', () => {
  it('PQ is HDR10', () => {
    expect(hdrFormatOf({ primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl' })).toBe(
      'hdr10',
    );
    expect(hdrFormatOf({ transfer: 16 })).toBe('hdr10');
  });

  it('HLG is HLG', () => {
    expect(hdrFormatOf({ primaries: 'bt2020', transfer: 'hlg', matrix: 'bt2020-ncl' })).toBe('hlg');
    expect(hdrFormatOf({ transfer: 18 })).toBe('hlg');
  });

  it('BT.709 and unknown colour spaces are SDR', () => {
    expect(hdrFormatOf({ transfer: 'bt709' })).toBeNull();
    expect(hdrFormatOf({ transfer: 'iec61966-2-1' })).toBeNull();
    expect(hdrFormatOf({})).toBeNull();
    expect(hdrFormatOf(null)).toBeNull();
    expect(hdrFormatOf(undefined)).toBeNull();
  });

  it('BT.2020 with an SDR transfer (14, BT.2020 10-bit) is SDR', () => {
    expect(hdrFormatOf({ transfer: 14 })).toBeNull();
    // Mediabunny has no name for 14: the transfer comes out undefined, the primaries stay BT.2020.
    expect(
      hdrFormatOf({ primaries: 'bt2020', transfer: undefined, matrix: 'bt2020-ncl' }),
    ).toBeNull();
  });
});

describe('toneMapped', () => {
  it('warns only for HDR video on an SDR display', () => {
    expect(toneMapped('hdr10', false)).toBe(true);
    expect(toneMapped('hlg', false)).toBe(true);
    expect(toneMapped('hdr10', true)).toBe(false);
    expect(toneMapped(null, false)).toBe(false);
    expect(toneMapped(null, true)).toBe(false);
  });
});
