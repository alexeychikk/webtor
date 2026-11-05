import { describe, expect, it } from 'vitest';
import {
  aheadWithin,
  DEFAULT_WINDOW_BYTES,
  MAX_WINDOW_BYTES,
  MIN_WINDOW_BYTES,
  piecesToEvict,
  windowBudget,
} from './piece-window';

const MiB = 1024 * 1024;

describe('windowBudget', () => {
  it('takes a sixteenth of the device memory within bounds, a default without it', () => {
    expect(windowBudget(undefined)).toBe(DEFAULT_WINDOW_BYTES);
    expect(windowBudget(0)).toBe(DEFAULT_WINDOW_BYTES);
    expect(windowBudget(4)).toBe(256 * MiB);
    expect(windowBudget(0.5)).toBe(MIN_WINDOW_BYTES);
    expect(windowBudget(64)).toBe(MAX_WINDOW_BYTES);
  });
});

describe('aheadWithin', () => {
  it('keeps the target when the window fits the budget', () => {
    expect(aheadWithin(60, 256 * MiB, 2 * MiB)).toBe(60);
    expect(aheadWithin(60, 256 * MiB, NaN)).toBe(60);
    expect(aheadWithin(60, 256 * MiB, Infinity)).toBe(60);
  });

  it('shrinks it for high bitrates, never below 20 s (or the target)', () => {
    expect(aheadWithin(60, 256 * MiB, 4 * MiB)).toBe(48);
    expect(aheadWithin(60, 128 * MiB, 20 * MiB)).toBe(20);
    expect(aheadWithin(5, 128 * MiB, 20 * MiB)).toBe(5);
  });
});

describe('piecesToEvict', () => {
  const held = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  it('keeps the pieces that overlap the kept bytes', () => {
    expect(
      piecesToEvict({ held, pieceLength: 10, keep: { start: 25, end: 61 }, pinned: [] }),
    ).toEqual([0, 1, 7, 8, 9]);
    expect(
      piecesToEvict({ held, pieceLength: 10, keep: { start: 20, end: 60 }, pinned: [] }),
    ).toEqual([0, 1, 6, 7, 8, 9]);
  });

  it('never drops a pinned piece, and keeps everything without a range', () => {
    const pinned = [{ from: 8, to: 9 }];
    expect(
      piecesToEvict({ held: [9, 0, 8], pieceLength: 10, keep: { start: 20, end: 60 }, pinned }),
    ).toEqual([0]);
    expect(piecesToEvict({ held, pieceLength: 10, keep: null, pinned: [] })).toEqual([]);
  });

  it('drops everything for an empty range', () => {
    expect(
      piecesToEvict({ held: [3, 1], pieceLength: 10, keep: { start: 30, end: 30 }, pinned: [] }),
    ).toEqual([1, 3]);
  });
});
