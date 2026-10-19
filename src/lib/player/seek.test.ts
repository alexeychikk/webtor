import { describe, expect, it } from 'vitest';
import { downloadedRanges, pointerFraction, sameRanges, timeFractions } from './seek';

const bits = (...have: number[]) => ({ get: (i: number) => have.includes(i) });
const ranges = (...r: [number, number][]) => ({
  length: r.length,
  start: (i: number) => r[i]![0],
  end: (i: number) => r[i]![1],
});

describe('downloadedRanges', () => {
  it('maps whole pieces of a single-file torrent to fractions and merges neighbours', () => {
    // 4 pieces of 100 bytes, file = the whole 400 bytes.
    expect(downloadedRanges(bits(0, 1, 3), 100, 0, 400)).toEqual([
      [0, 0.5],
      [0.75, 1],
    ]);
    expect(downloadedRanges(bits(), 100, 0, 400)).toEqual([]);
    expect(downloadedRanges(bits(0, 1, 2, 3), 100, 0, 400)).toEqual([[0, 1]]);
  });

  it('cuts the pieces shared with neighbouring files to this file', () => {
    // File at bytes 150..350 of the torrent: pieces 1 (100..200), 2 (200..300), 3 (300..400).
    expect(downloadedRanges(bits(1), 100, 150, 200)).toEqual([[0, 0.25]]);
    expect(downloadedRanges(bits(3), 100, 150, 200)).toEqual([[0.75, 1]]);
    expect(downloadedRanges(bits(1, 2, 3), 100, 150, 200)).toEqual([[0, 1]]);
    // Pieces of other files don't count.
    expect(downloadedRanges(bits(0, 4), 100, 150, 200)).toEqual([]);
  });

  it('handles a file inside one piece, and a short last piece', () => {
    expect(downloadedRanges(bits(2), 100, 210, 30)).toEqual([[0, 1]]);
    expect(downloadedRanges(bits(2), 100, 0, 250)).toEqual([[0.8, 1]]);
  });

  it('is empty for an empty file or a bad piece length', () => {
    expect(downloadedRanges(bits(0), 100, 0, 0)).toEqual([]);
    expect(downloadedRanges(bits(0), 0, 0, 100)).toEqual([]);
  });
});

describe('timeFractions', () => {
  it('maps time ranges to fractions of the duration, clamped', () => {
    expect(timeFractions(ranges([0, 3], [6, 15]), 12)).toEqual([
      [0, 0.25],
      [0.5, 1],
    ]);
  });

  it('is empty while the duration is unknown', () => {
    expect(timeFractions(ranges([0, 3]), NaN)).toEqual([]);
    expect(timeFractions(ranges([0, 3]), Infinity)).toEqual([]);
    expect(timeFractions(ranges([0, 3]), 0)).toEqual([]);
  });
});

describe('helpers', () => {
  it('compares ranges', () => {
    expect(sameRanges([[0, 1]], [[0, 1]])).toBe(true);
    expect(sameRanges([[0, 1]], [[0, 0.5]])).toBe(false);
    expect(sameRanges([], [[0, 1]])).toBe(false);
  });

  it('turns a pointer position into a fraction of the bar', () => {
    expect(pointerFraction(150, 100, 200)).toBe(0.25);
    expect(pointerFraction(50, 100, 200)).toBe(0);
    expect(pointerFraction(400, 100, 200)).toBe(1);
    expect(pointerFraction(10, 0, 0)).toBe(0);
  });
});
