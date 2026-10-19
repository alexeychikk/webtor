import { describe, expect, it } from 'vitest';
import {
  appendChunk,
  MAX_STARVED_HITS,
  mayAppend,
  MIN_AHEAD_S,
  newQuotaState,
  type AppendBuffer,
  type AppendHost,
} from './append';
import { bufferedAhead, toRanges, type Ranges } from './buffer';
import { PlaybackError } from './errors';

interface Chunk {
  start: number;
  end: number;
  bytes: number;
}

/** Element time range of each test chunk. */
const times = new WeakMap<Uint8Array, [number, number]>();

/** A SourceBuffer that holds at most `quota` bytes, like Safari's, and throws beyond it. */
class FakeSourceBuffer extends EventTarget implements AppendBuffer {
  updating = false;
  chunks: Chunk[] = [];
  appended = 0;
  constructor(public quota: number) {
    super();
  }
  get bytes(): number {
    return this.chunks.reduce((n, c) => n + c.bytes, 0);
  }
  get buffered(): Ranges {
    const pairs: [number, number][] = [];
    for (const c of [...this.chunks].sort((a, b) => a.start - b.start)) {
      const last = pairs.at(-1);
      if (last && c.start <= last[1] + 1e-9) last[1] = Math.max(last[1], c.end);
      else pairs.push([c.start, c.end]);
    }
    return toRanges(pairs);
  }
  appendBuffer(data: Uint8Array<ArrayBuffer>): void {
    if (this.updating) throw new DOMException('busy', 'InvalidStateError');
    if (this.bytes + data.byteLength > this.quota) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    const [start, end] = times.get(data)!;
    this.update(() => {
      this.chunks.push({ start, end, bytes: data.byteLength });
      this.appended++;
    });
  }
  remove(start: number, end: number): void {
    if (this.updating) throw new DOMException('busy', 'InvalidStateError');
    this.update(() => {
      this.chunks = this.chunks.filter((c) => !(c.start >= start && c.end <= end));
    });
  }
  private update(op: () => void) {
    this.updating = true;
    setTimeout(() => {
      op();
      this.updating = false;
      this.dispatchEvent(new Event('updateend'));
    }, 0);
  }
}

const BYTES_PER_S = 100;

function chunk(i: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(BYTES_PER_S);
  times.set(data, [i, i + 1]);
  return data;
}

/** A playhead that moves through what is buffered while `playing`, and the host around it. */
function setup(quota: number, opts: { relieve?: () => Promise<boolean> } = {}) {
  const sb = new FakeSourceBuffer(quota);
  const q = newQuotaState();
  const state = { t: 0, playing: true, streaming: true, maxAhead: 0 };
  let waiters: (() => void)[] = [];
  const host: AppendHost = {
    target: 60,
    currentTime: () => state.t,
    ahead: () => bufferedAhead(sb.buffered, state.t),
    streaming: () => state.streaming,
    progress: () => new Promise((resolve) => waiters.push(resolve)),
    check: () => {},
    safeCut: (cut) => cut,
    staleAhead: () => null,
    relieve: opts.relieve ?? (async () => false),
  };
  /** One playback step: the playhead moves `dt` (if playing and buffered), waiters wake. */
  async function tick(dt = 0.25) {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    if (state.playing) state.t += Math.min(dt, bufferedAhead(sb.buffered, state.t));
    state.maxAhead = Math.max(state.maxAhead, bufferedAhead(sb.buffered, state.t));
    const w = waiters;
    waiters = [];
    for (const wake of w) wake();
  }
  /** Feeds chunks [0, n) one after the other, like a pipeline's WritableStream. */
  function produce(n: number) {
    let settled = false;
    let error: unknown = null;
    const done = (async () => {
      for (let i = 0; i < n; i++) await appendChunk(sb, chunk(i), host, q);
    })().then(
      () => void (settled = true),
      (err: unknown) => {
        settled = true;
        error = err;
      },
    );
    return {
      done,
      get settled() {
        return settled;
      },
      get error() {
        return error;
      },
    };
  }
  async function runUntil(cond: () => boolean, maxTicks = 2000) {
    for (let i = 0; i < maxTicks && !cond(); i++) await tick();
  }
  return { sb, q, state, host, tick, produce, runUntil };
}

describe('appendChunk under a SourceBuffer quota', () => {
  it('waits for playback instead of failing when nothing behind can be evicted', async () => {
    // 10 s of media fit; the time target (60 s) never would.
    const { sb, q, state, produce, runUntil } = setup(10 * BYTES_PER_S);
    const run = produce(40);
    await runUntil(() => run.settled);
    expect(run.error).toBeNull();
    expect(sb.appended).toBe(40);
    expect(q.hits).toBeGreaterThan(0);
    // It learned to stay below what fitted, so most chunks waited instead of hitting the quota.
    expect(q.cap).toBeLessThanOrEqual(10 * 0.8);
    expect(q.hits).toBeLessThan(20);
    expect(state.maxAhead).toBeLessThanOrEqual(10);
    // Playback went through all of it.
    await runUntil(() => state.t >= 40);
    expect(state.t).toBe(40);
  });

  it('holds while paused (no error) and resumes appending on play', async () => {
    const { sb, state, produce, runUntil, tick } = setup(10 * BYTES_PER_S);
    state.playing = false;
    const run = produce(30);
    for (let i = 0; i < 100; i++) await tick();
    expect(run.settled).toBe(false);
    expect(run.error).toBeNull();
    expect(sb.appended).toBe(10);
    expect(state.t).toBe(0);

    state.playing = true;
    await runUntil(() => run.settled);
    expect(run.error).toBeNull();
    expect(sb.appended).toBe(30);
  });

  it('respects ManagedMediaSource endstreaming, but never below MIN_AHEAD_S', async () => {
    const { sb, state, produce, tick, runUntil } = setup(Infinity);
    state.playing = false;
    state.streaming = false;
    const run = produce(30);
    for (let i = 0; i < 50; i++) await tick();
    expect(sb.appended).toBe(MIN_AHEAD_S);
    state.streaming = true;
    await runUntil(() => run.settled);
    expect(run.error).toBeNull();
    expect(sb.appended).toBe(30);
  });

  it('asks the other buffers for room when it is starved, then goes on', async () => {
    let relieved = 0;
    const ctx = setup(BYTES_PER_S / 2, {
      relieve: async () => {
        // The other SourceBuffer gave its share of a common quota back.
        relieved++;
        ctx.sb.quota = 10 * BYTES_PER_S;
        return true;
      },
    });
    const run = ctx.produce(5);
    await ctx.runUntil(() => run.settled);
    expect(run.error).toBeNull();
    expect(relieved).toBe(1);
    expect(ctx.sb.appended).toBe(5);
  });

  it('fails only when not even one chunk fits and nothing anywhere can be freed', async () => {
    const { produce, runUntil } = setup(BYTES_PER_S / 2);
    const run = produce(1);
    await runUntil(() => run.settled, MAX_STARVED_HITS * 4);
    expect(run.error).toBeInstanceOf(PlaybackError);
    expect((run.error as PlaybackError).code).toBe('playback-failed');
  });
});

describe('mayAppend', () => {
  it('follows the target, the learned cap and MMS streaming above the minimum', () => {
    expect(mayAppend(10, 60, Infinity, true)).toBe(true);
    expect(mayAppend(61, 60, Infinity, true)).toBe(false);
    expect(mayAppend(10, 60, 8, true)).toBe(false);
    expect(mayAppend(10, 60, Infinity, false)).toBe(false);
    expect(mayAppend(MIN_AHEAD_S - 1, 60, 1, false)).toBe(true);
    // A smaller configured target (the e2e knob) still wins.
    expect(mayAppend(2.5, 2, Infinity, true)).toBe(false);
  });
});
