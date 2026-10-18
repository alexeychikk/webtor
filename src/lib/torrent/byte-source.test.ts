import { describe, expect, it } from 'vitest';
import { toFileRange } from './byte-source';

describe('toFileRange', () => {
  it('turns an exclusive end into an inclusive one', () => {
    expect(toFileRange(0, 4, 100)).toEqual({ range: { start: 0, end: 3 }, take: 4 });
    expect(toFileRange(10, 100, 100)).toEqual({ range: { start: 10, end: 99 }, take: 90 });
  });
  it('never passes end: 0 (WebTorrent reads to EOF then)', () => {
    expect(toFileRange(0, 1, 100)).toEqual({ range: { start: 0, end: 1 }, take: 1 });
  });
  it('handles a one-byte file', () => {
    // end: 0 means EOF there, which is byte 0 here anyway.
    expect(toFileRange(0, 1, 1)).toEqual({ range: { start: 0, end: 0 }, take: 1 });
  });
  it('rejects empty and out-of-file ranges', () => {
    expect(() => toFileRange(5, 5, 100)).toThrow(RangeError);
    expect(() => toFileRange(0, 101, 100)).toThrow(RangeError);
    expect(() => toFileRange(-1, 3, 100)).toThrow(RangeError);
  });
});
