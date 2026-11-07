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

  it('after a seek keeps everything during the keyframe search, then from its lowest read', () => {
    const w = new ByteWindow(0);
    play(w, 0, 50);
    w.restart();
    expect(w.keep(30)).toBeNull();
    w.read(900 * MiB, 901 * MiB)();
    w.read(30 * MiB, 31 * MiB)();
    expect(w.keep(30)).toEqual({ start: 0, end: 901 * MiB });
    play(w, 30, 35);
    expect(w.keep(31)).toEqual({ start: 30 * MiB, end: 72 * MiB });
    expect(w.keep(45)).toEqual({ start: 72 * MiB, end: 72 * MiB });
  });

  it('after a far seek keeps from the playhead, whatever the earlier cursor ran ahead to', () => {
    const w = new ByteWindow(0);
    // Before the seek the reads ran 30 s of media (60 MiB) ahead of each fragment.
    for (let t = 0; t < 40; t++) {
      w.read((t + 30) * 2 * MiB, (t + 31) * 2 * MiB)();
      w.produced(t);
    }
    expect(w.keep(35)?.start).toBe(112 * MiB);
    w.restart();
    play(w, 40, 42);
    expect(w.keep(40)).toEqual({ start: 80 * MiB, end: 86 * MiB });
    play(w, 43, 60);
    expect(w.keep(55)).toEqual({ start: 92 * MiB, end: 122 * MiB });
  });

  it('after a far seek back keeps from the new playhead, not the earlier run', () => {
    const w = new ByteWindow(0);
    play(w, 0, 100);
    w.restart();
    play(w, 20, 25);
    expect(w.keep(20)).toEqual({ start: 22 * MiB, end: 52 * MiB });
    play(w, 26, 40);
    expect(w.keep(40)).toEqual({ start: 62 * MiB, end: 82 * MiB });
  });

  it('after a resume keeps the window around the resume point from the first fragment', () => {
    const w = new ByteWindow(0);
    w.read(0, 1 * MiB)();
    w.read(999 * MiB, 1000 * MiB)();
    w.restart();
    w.read(999 * MiB, 1000 * MiB)();
    w.read(40 * MiB, 41 * MiB)();
    play(w, 20, 20);
    expect(w.keep(20)).toEqual({ start: 40 * MiB, end: 42 * MiB });
    play(w, 21, 40);
    expect(w.keep(30)).toEqual({ start: 42 * MiB, end: 82 * MiB });
    expect(w.keep(35)).toEqual({ start: 52 * MiB, end: 82 * MiB });
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

  it('keeps up to the subtitle scan reach until the next seek', () => {
    const w = new ByteWindow(0);
    play(w, 0, 20);
    w.read(42 * MiB, 62 * MiB, 'scan')();
    expect(w.keep(20)).toEqual({ start: 22 * MiB, end: 62 * MiB });
    w.restart();
    play(w, 30, 35);
    expect(w.keep(35)).toEqual({ start: 42 * MiB, end: 72 * MiB });
  });

  it('pins a one-off read only while it runs', () => {
    const w = new ByteWindow(0);
    play(w, 0, 20);
    const header = w.read(0, 1 * MiB, 'once');
    const fonts = w.read(900 * MiB, 901 * MiB, 'once');
    expect(w.keep(20)).toEqual({ start: 0, end: 901 * MiB });
    header();
    fonts();
    expect(w.keep(20)).toEqual({ start: 22 * MiB, end: 42 * MiB });
  });
});

describe('ByteWindow.points', () => {
  it('samples the read cursor per fragment, numbering the runs by seek', () => {
    const w = new ByteWindow();
    play(w, 0, 1);
    w.restart();
    play(w, 5, 5);
    expect(w.points()).toEqual([
      { time: 0, byte: 2 * MiB, run: 0 },
      { time: 1, byte: 4 * MiB, run: 0 },
      { time: 5, byte: 12 * MiB, run: 1 },
    ]);
  });

  it('adds the end at the furthest read ever once the pipelines appended through it', () => {
    const w = new ByteWindow();
    play(w, 0, 3);
    w.restart();
    w.read(2 * MiB, 3 * MiB)();
    w.produced(1);
    expect(w.points(10).at(-1)).toEqual({ time: 10, byte: 8 * MiB, run: 1 });
    expect(new ByteWindow().points(10)).toEqual([]);
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

  it('unpins a stream once it delivered its bytes, read to the end or not', async () => {
    const w = new ByteWindow(0);
    play(w, 0, 50);
    const source = trackedSource(
      { size: 1000 * MiB, read: () => new Blob([bytes]).stream() },
      w,
      'scan',
    );
    const reader = (source.read(0, 4) as ReadableStream<Uint8Array>).getReader();
    expect(w.keep(40)).toEqual({ start: 0, end: 102 * MiB });
    expect((await reader.read()).value).toEqual(bytes);
    reader.releaseLock();
    expect(w.keep(40)).toEqual({ start: 62 * MiB, end: 102 * MiB });
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
