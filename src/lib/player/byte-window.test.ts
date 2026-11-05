import { describe, expect, it } from 'vitest';
import { ByteWindow, KEEP_BEHIND_S, READ_AHEAD_SLACK } from './byte-window';

const MiB = 1024 * 1024;

describe('ByteWindow', () => {
  it('keeps everything until a read happened', () => {
    const w = new ByteWindow();
    w.produced(1);
    expect(w.keep(0)).toBeNull();
  });

  it('keeps from the frontier of a fragment KEEP_BEHIND_S back, minus the slack, to the frontier', () => {
    const w = new ByteWindow();
    for (let t = 0; t <= 60; t++) {
      w.read(t * 2 * MiB, (t + 1) * 2 * MiB);
      w.produced(t);
    }
    expect(w.keep(5)).toEqual({ start: 0, end: 122 * MiB });
    expect(w.keep(40)).toEqual({ start: 62 * MiB - READ_AHEAD_SLACK, end: 122 * MiB });
    expect(w.keep(40 + 0.5)?.start).toBe(62 * MiB - READ_AHEAD_SLACK);
    expect(KEEP_BEHIND_S).toBe(10);
  });

  it('after a seek keeps only from the new reads on, with the samples of earlier runs', () => {
    const w = new ByteWindow();
    for (let t = 0; t <= 100; t++) {
      w.read(t * MiB, (t + 1) * MiB);
      w.produced(t);
    }
    w.restart();
    expect(w.keep(30)).toBeNull();
    w.read(30 * MiB, 31 * MiB);
    w.produced(30.5);
    expect(w.keep(30)).toEqual({ start: 21 * MiB - READ_AHEAD_SLACK, end: 31 * MiB });
    expect(w.keep(60)).toEqual({ start: 31 * MiB, end: 31 * MiB });
  });

  it('ignores fragments before any read and non-finite times', () => {
    const w = new ByteWindow();
    w.read(0, 10 * MiB);
    w.produced(-Infinity);
    w.produced(NaN);
    expect(w.keep(100)).toEqual({ start: 0, end: 10 * MiB });
  });
});
