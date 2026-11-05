import { describe, expect, it } from 'vitest';
import { ByteWindow, KEEP_BEHIND_S, READ_AHEAD_SLACK, trackedSource } from './byte-window';

const MiB = 1024 * 1024;

/** Reads 2 MiB per second of media from `from` s to `to` s, producing each second. */
function play(w: ByteWindow, from: number, to: number) {
  for (let t = from; t <= to; t++) {
    w.read(t * 2 * MiB, (t + 1) * 2 * MiB)();
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
    w.read(1000 * MiB, 1001 * MiB)();
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
    w.read(0, 10 * MiB)();
    w.produced(-Infinity);
    w.produced(NaN);
    expect(w.keep(100)).toEqual({ start: 0, end: 10 * MiB });
  });

  it('keeps reads still running, wherever they are', () => {
    const w = new ByteWindow(0);
    play(w, 0, 50);
    const early = w.read(4 * MiB, 6 * MiB);
    const late = w.read(300 * MiB, 302 * MiB);
    expect(w.keep(40)).toEqual({ start: 4 * MiB, end: 302 * MiB });
    early();
    late();
    w.read(102 * MiB, 104 * MiB)();
    expect(w.keep(40)).toEqual({ start: 62 * MiB, end: 104 * MiB });
  });

  it('keeps up to the latest read when it runs past the furthest fragment', () => {
    const w = new ByteWindow(0);
    play(w, 0, 20);
    w.read(42 * MiB, 80 * MiB)();
    expect(w.keep(20)).toEqual({ start: 22 * MiB, end: 80 * MiB });
  });
});

describe('trackedSource', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);

  it('pins a streamed read until it ends', async () => {
    const w = new ByteWindow(0);
    play(w, 0, 50);
    const source = trackedSource({ size: 1000 * MiB, read: () => new Blob([bytes]).stream() }, w);
    const stream = source.read(0, 4) as ReadableStream<Uint8Array>;
    expect(w.keep(40)?.start).toBe(0);
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(bytes);
    expect(w.keep(40)?.start).toBe(62 * MiB);
  });

  it('unpins a cancelled stream and a settled promise', async () => {
    const w = new ByteWindow(0);
    play(w, 0, 50);
    const source = trackedSource(
      {
        size: 1000 * MiB,
        read: (start) => (start === 0 ? new Blob([bytes]).stream() : Promise.resolve(bytes)),
      },
      w,
    );
    await (source.read(0, 4) as ReadableStream<Uint8Array>).cancel();
    expect(w.keep(40)?.start).toBe(62 * MiB);
    const promise = source.read(2 * MiB, 3 * MiB);
    expect(w.keep(40)?.start).toBe(2 * MiB);
    await promise;
    expect(w.keep(40)?.start).toBe(62 * MiB);
  });
});
