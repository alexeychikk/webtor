import { describe, expect, it } from 'vitest';
import { ByteWindow, KEEP_BEHIND_S, READ_AHEAD_SLACK } from './byte-window';

const MiB = 1024 * 1024;

/** Reads 2 MiB per second of media from `from` s to `to` s, producing each second. */
function play(w: ByteWindow, from: number, to: number) {
  for (let t = from; t <= to; t++) {
    w.read(t * 2 * MiB, (t + 1) * 2 * MiB);
    w.produced(t);
  }
}

describe('ByteWindow', () => {
  it('keeps everything until something was read', () => {
    const w = new ByteWindow();
    w.produced(1);
    expect(w.keep(0)).toBeNull();
  });

  it('keeps from a fragment KEEP_BEHIND_S back, minus the slack, to the furthest one plus it', () => {
    const w = new ByteWindow();
    play(w, 0, 60);
    expect(KEEP_BEHIND_S).toBe(10);
    expect(w.keep(5)).toEqual({ start: 0, end: 122 * MiB });
    expect(w.keep(40)).toEqual({ start: 62 * MiB - READ_AHEAD_SLACK, end: 122 * MiB });
    expect(w.keep(40.5)?.start).toBe(62 * MiB - READ_AHEAD_SLACK);
  });

  it('ignores a one-off read further on (Matroska Cues) for the end', () => {
    const w = new ByteWindow(0);
    w.read(1000 * MiB, 1001 * MiB);
    expect(w.keep(0)).toEqual({ start: 0, end: 1001 * MiB });
    play(w, 0, 20);
    expect(w.keep(20)).toEqual({ start: 22 * MiB, end: 42 * MiB });
  });

  it('after a seek keeps behind by the earlier samples and ahead by the new reads', () => {
    const w = new ByteWindow(0);
    play(w, 0, 50);
    w.restart();
    expect(w.keep(30)).toEqual({ start: 42 * MiB, end: Infinity });
    play(w, 30, 35);
    expect(w.keep(31)).toEqual({ start: 44 * MiB, end: 72 * MiB });
    expect(w.keep(60)).toEqual({ start: 72 * MiB, end: 72 * MiB });
  });

  it('ignores fragments before any read and non-finite times', () => {
    const w = new ByteWindow();
    w.produced(5);
    w.read(0, 10 * MiB);
    w.produced(-Infinity);
    w.produced(NaN);
    expect(w.keep(100)).toEqual({ start: 0, end: 10 * MiB });
  });
});
