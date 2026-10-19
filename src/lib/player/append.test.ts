import { describe, expect, it } from 'vitest';
import {
  appendChunk,
  formatRanges,
  initSegmentLength,
  MAX_APPEND_BYTES,
  mayAppend,
  MIN_AHEAD_S,
  MIN_APPEND_BYTES,
  newQuotaState,
  PRE_INIT_QUOTA_SHARE,
  simulateQuota,
  STARVED_TIMEOUT_MS,
  type AppendBuffer,
  type AppendHost,
} from './append';
import { aheadOf, bufferedAhead, gapJumpTarget, toRanges, type Ranges } from './buffer';
import { PlaybackError } from './errors';

/**
 * Test media is a fragmented-MP4-like byte stream: `ftyp` + `moov` (the init segment), then one
 * `moof` (start and end time as two float64) + `mdat` per fragment, like Mediabunny writes it.
 */
function box(type: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}

const INIT = concat(box('ftyp', new Uint8Array(8)), box('moov', new Uint8Array(1000)));
/** Bytes per second of media: 400 kbit/s. */
const BYTES_PER_S = 50_000;

function fragment(start: number, end: number, rate = BYTES_PER_S): Uint8Array<ArrayBuffer> {
  const times = new Uint8Array(16);
  const view = new DataView(times.buffer);
  view.setFloat64(0, start);
  view.setFloat64(8, end);
  return concat(box('moof', times), box('mdat', new Uint8Array((end - start) * rate - 40)));
}

/** Mediabunny's writes for `n` fragments of `len` s from `first`: init + fragment, then one each. */
function writes(n: number, len = 1, first = 0): Uint8Array<ArrayBuffer>[] {
  const out: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < n; i++) out.push(fragment(first + i * len, first + (i + 1) * len));
  out[0] = concat(INIT, out[0]!);
  return out;
}

interface Coded {
  start: number;
  end: number;
  bytes: number;
}

/**
 * A SourceBuffer with WebKit's quota rule: an append is refused when the coded frames held plus the
 * append's bytes pass the limit, which is `PRE_INIT_QUOTA_SHARE` of `quota` until an init segment
 * was parsed. Bytes arrive in any split; a fragment counts once its `mdat` is complete. `remove`
 * drops each fragment that starts in [start, end) (MSE removes up to the next keyframe).
 */
class FakeSourceBuffer extends EventTarget implements AppendBuffer {
  updating = false;
  frames: Coded[] = [];
  initialized = false;
  /** Every accepted `appendBuffer` size, and every `remove`. */
  appends: number[] = [];
  removals: [number, number][] = [];
  private pending = new Uint8Array(0);
  private moof: Coded | null = null;
  constructor(public quota: number) {
    super();
  }
  get held(): number {
    return this.frames.reduce((n, c) => n + c.bytes, 0);
  }
  get fragments(): number {
    return this.frames.length;
  }
  get buffered(): Ranges {
    const pairs: [number, number][] = [];
    for (const c of [...this.frames].sort((a, b) => a.start - b.start)) {
      const last = pairs.at(-1);
      if (last && c.start <= last[1] + 1e-9) last[1] = Math.max(last[1], c.end);
      else pairs.push([c.start, c.end]);
    }
    return toRanges(pairs);
  }
  appendBuffer(data: Uint8Array<ArrayBuffer>): void {
    if (this.updating) throw new DOMException('busy', 'InvalidStateError');
    const limit = this.initialized ? this.quota : this.quota * PRE_INIT_QUOTA_SHARE;
    if (this.held + data.byteLength > limit) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    this.appends.push(data.byteLength);
    const bytes = data.slice();
    this.update(() => this.parse(bytes));
  }
  remove(start: number, end: number): void {
    if (this.updating) throw new DOMException('busy', 'InvalidStateError');
    this.removals.push([start, end]);
    this.update(() => {
      this.frames = this.frames.filter((c) => !(c.start >= start && c.start < end));
    });
  }
  private parse(data: Uint8Array) {
    const buf = concat(this.pending, data);
    const view = new DataView(buf.buffer);
    let pos = 0;
    while (pos + 8 <= buf.byteLength) {
      const size = view.getUint32(pos);
      if (pos + size > buf.byteLength) break;
      const type = String.fromCharCode(...buf.subarray(pos + 4, pos + 8));
      if (type === 'moov') this.initialized = true;
      if (type === 'moof') {
        if (!this.initialized) throw new Error('media segment before the init segment');
        this.moof = {
          start: view.getFloat64(pos + 8),
          end: view.getFloat64(pos + 16),
          bytes: size,
        };
      }
      if (type === 'mdat') {
        this.frames.push({ ...this.moof!, bytes: this.moof!.bytes + size });
        this.moof = null;
      }
      pos += size;
    }
    this.pending = buf.slice(pos);
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

/** A playhead that moves through what is buffered while `playing`, and the host around it. */
/**
 * `gop`/`first`: the stream's keyframes (one per fragment), known ahead like the demuxer's index,
 * for `safeCut` (MSE removes up to the next keyframe: a cut must not empty the GOP being played).
 */
function setup(
  quota: number,
  opts: { relieve?: () => Promise<boolean>; gop?: number; first?: number } = {},
) {
  const { gop = 1, first = 0 } = opts;
  const sb = new FakeSourceBuffer(quota);
  const q = newQuotaState();
  const state = { t: 0, clock: 0, playing: true, streaming: true, maxAhead: 0 };
  let waiters: (() => void)[] = [];
  const host: AppendHost = {
    name: 'video',
    target: 60,
    currentTime: () => state.t,
    ahead: () => aheadOf(sb.buffered, state.t),
    streaming: () => state.streaming,
    playing: () => state.playing,
    progress: () => new Promise((resolve) => waiters.push(resolve)),
    now: () => state.clock,
    check: () => {},
    safeCut: (cut) => first + Math.floor((cut - first) / gop + 1e-9) * gop,
    staleAhead: () => null,
    relieve: opts.relieve ?? (async () => false),
  };
  /** One playback step of `dt` s: the playhead jumps small gaps and plays what is buffered. */
  async function tick(dt = 0.25) {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    state.clock += dt * 1000;
    if (state.playing) {
      state.t = gapJumpTarget(sb.buffered, state.t) ?? state.t;
      state.t += Math.min(dt, bufferedAhead(sb.buffered, state.t));
    }
    state.maxAhead = Math.max(state.maxAhead, aheadOf(sb.buffered, state.t));
    const w = waiters;
    waiters = [];
    for (const wake of w) wake();
  }
  /** Appends `chunks` one after the other, like a pipeline's WritableStream. */
  function produce(chunks: Iterable<Uint8Array<ArrayBuffer>>) {
    let settled = false;
    let error: unknown = null;
    const done = (async () => {
      for (const c of chunks) await appendChunk(sb, c, host, q);
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
  async function runUntil(cond: () => boolean, maxTicks = 4000) {
    for (let i = 0; i < maxTicks && !cond(); i++) await tick();
  }
  return { sb, q, state, host, tick, produce, runUntil };
}

const isQuotaError = (fn: () => void) => {
  try {
    fn();
    return false;
  } catch (err) {
    return (err as Error).name === 'QuotaExceededError';
  }
};

describe('appendChunk under a WebKit-like quota', () => {
  it('root cause: appends the init segment alone, so the first fragment is not held to the pre-init 5 %', async () => {
    // 1 MB quota (iPad: ~105 MB) → 50 kB before the init segment; moov + a 2 s GOP is 101 kB.
    const chunks = writes(10, 2);
    expect(isQuotaError(() => new FakeSourceBuffer(1_000_000).appendBuffer(chunks[0]!))).toBe(true);

    const { sb, state, produce, runUntil } = setup(1_000_000, { gop: 2 });
    const run = produce(chunks);
    await runUntil(() => run.settled && state.t >= 20);
    expect(run.error).toBeNull();
    expect(sb.appends[0]).toBe(INIT.byteLength);
    expect(sb.fragments).toBe(10);
    expect(state.t).toBe(20);
  });

  it('plays a 4K-like stream under an iPad-sized quota in bounded appends', async () => {
    // 40 Mbit/s with 5 s GOPs (25 MB fragments), 105 MB per SourceBuffer (5.25 MB before the init
    // segment): the first write alone (moov + 25 MB) was refused every time.
    const rate = 5_000_000;
    const { sb, q, state, produce, runUntil } = setup(110_376_422, { gop: 5 });
    function* stream() {
      yield concat(INIT, fragment(0, 5, rate));
      for (let i = 1; i < 16; i++) yield fragment(i * 5, (i + 1) * 5, rate);
    }
    const run = produce(stream());
    await runUntil(() => run.settled && state.t >= 80, 8000);
    expect(run.error).toBeNull();
    expect(state.t).toBe(80);
    expect(sb.appends[0]).toBe(INIT.byteLength);
    expect(Math.max(...sb.appends)).toBeLessThanOrEqual(MAX_APPEND_BYTES);
    expect(q.hits).toBeGreaterThan(0);
    // A window, not the 60 s target: what fits (22 s) plus the fragment going in.
    expect(state.maxAhead).toBeLessThan(30);
  }, 30_000);

  it('waits for playback instead of failing when nothing behind can be evicted', async () => {
    // 10 s of media fit; the time target (60 s) never would.
    const { sb, q, state, produce, runUntil } = setup(10 * BYTES_PER_S);
    const run = produce(writes(40));
    await runUntil(() => run.settled);
    expect(run.error).toBeNull();
    expect(sb.fragments).toBeGreaterThan(5);
    expect(q.hits).toBeGreaterThan(0);
    // It learned to stay below what fitted, so most chunks waited instead of hitting the quota.
    expect(q.cap).toBeLessThanOrEqual(10 * 0.8);
    expect(q.hits).toBeLessThan(40);
    expect(state.maxAhead).toBeLessThanOrEqual(10);
    await runUntil(() => state.t >= 40);
    expect(state.t).toBe(40);
  });

  it('splits a chunk larger than the quota and shrinks the pieces until they fit', async () => {
    // One 2 MB write (40 fragments) against a 300 kB quota.
    const { sb, q, state, produce, runUntil } = setup(300_000);
    const all = concat(...writes(40));
    expect(all.byteLength).toBeGreaterThan(MAX_APPEND_BYTES);
    const run = produce([all]);
    await runUntil(() => run.settled && state.t >= 40);
    expect(run.error).toBeNull();
    expect(state.t).toBe(40);
    expect(Math.max(...sb.appends)).toBeLessThanOrEqual(300_000);
    expect(q.chunk).toBeGreaterThanOrEqual(MIN_APPEND_BYTES);
  });

  it('plays fragments larger than the quota, in pieces, dropping the one just played', async () => {
    // 40 kB quota, 50 kB fragments (this fake counts a fragment once it is parsed whole). Starved
    // at the end of a fragment, the pipeline drops it up to the playhead to make room for the next.
    const { sb, state, produce, runUntil } = setup(40_000);
    const run = produce(writes(8));
    await runUntil(() => run.settled && state.t >= 8);
    expect(run.error).toBeNull();
    expect(state.t).toBe(8);
    expect(sb.removals.length).toBeGreaterThan(0);
  });

  it('counts media just past the playhead (a small gap) as ahead, also while paused', async () => {
    // The first frame is at 0.6 s (audio after video, or an MPEG-TS start offset). bufferedAhead
    // reads 0 there: the old code took that as starved and failed while the playhead sat still.
    const { q, state, produce, runUntil, tick } = setup(4 * BYTES_PER_S, { first: 0.6 });
    state.playing = false;
    const run = produce(writes(20, 1, 0.6));
    for (let i = 0; i * 250 < 2 * STARVED_TIMEOUT_MS; i++) await tick();
    expect(run.settled).toBe(false);
    expect(q.cap).toBeLessThan(4);

    state.playing = true;
    await runUntil(() => run.settled && state.t >= 20.6);
    expect(run.error).toBeNull();
    expect(state.t).toBeCloseTo(20.6);
  });

  it('evicts media buffered far ahead (an earlier seek) that takes up the quota', async () => {
    // [30, 40] is left from before a seek back to 0; it fills the whole 10.5 s quota.
    const { sb, q, state, produce, runUntil } = setup(10.5 * BYTES_PER_S);
    const old = produce(writes(10, 1, 30));
    await runUntil(() => old.settled);
    expect(formatRanges(sb.buffered)).toBe('30.0–40.0 s');

    const run = produce(writes(40));
    await runUntil(() => run.settled && state.t >= 40);
    expect(run.error).toBeNull();
    expect(sb.removals).toContainEqual([30, Infinity]);
    expect(q.hits).toBeGreaterThan(0);
    expect(state.t).toBe(40);
  });

  it('holds while paused (no error) and resumes appending on play', async () => {
    const { sb, state, produce, runUntil, tick } = setup(10 * BYTES_PER_S);
    state.playing = false;
    const run = produce(writes(30));
    for (let i = 0; i * 250 < 2 * STARVED_TIMEOUT_MS; i++) await tick();
    expect(run.settled).toBe(false);
    expect(run.error).toBeNull();
    expect(sb.fragments).toBeGreaterThanOrEqual(8);
    expect(state.t).toBe(0);

    state.playing = true;
    await runUntil(() => run.settled);
    expect(run.error).toBeNull();
  });

  it('respects ManagedMediaSource endstreaming, but never below MIN_AHEAD_S', async () => {
    const { sb, state, produce, tick, runUntil } = setup(Infinity);
    state.playing = false;
    state.streaming = false;
    const run = produce(writes(30));
    for (let i = 0; i < 50; i++) await tick();
    expect(sb.fragments).toBe(MIN_AHEAD_S);
    state.streaming = true;
    await runUntil(() => run.settled);
    expect(run.error).toBeNull();
    expect(sb.fragments).toBe(30);
  });

  it('asks the other buffers for room when it is starved, then goes on', async () => {
    let relieved = 0;
    const ctx = setup(30_000, {
      relieve: async () => {
        // The other SourceBuffer gave its share of a common quota back.
        relieved++;
        ctx.sb.quota = 10 * BYTES_PER_S;
        return true;
      },
    });
    ctx.sb.initialized = true;
    ctx.sb.quota = 0;
    const run = ctx.produce(writes(5));
    await ctx.runUntil(() => run.settled);
    expect(run.error).toBeNull();
    expect(relieved).toBe(1);
    expect(ctx.sb.fragments).toBe(5);
  });

  it('fails only after STARVED_TIMEOUT_MS without room, with numbers in the message', async () => {
    // Not even the init segment fits (pre-init budget 500 B).
    const { state, produce, runUntil } = setup(10_000);
    const run = produce(writes(1));
    await runUntil(() => run.settled || state.clock >= STARVED_TIMEOUT_MS - 1000);
    expect(run.settled).toBe(false);
    await runUntil(() => run.settled, 200);
    expect(run.error).toBeInstanceOf(PlaybackError);
    const err = run.error as PlaybackError;
    expect(err.code).toBe('playback-failed');
    expect(err.message).toContain(`video: ${INIT.byteLength} B append refused`);
    expect(err.message).toContain('buffered nothing at 0.0 s');
    expect(err.message).toMatch(/\d+ quota hits/);
  });
  it('waits, then gives up, on an init segment over MIN_APPEND_BYTES that never fits (no spin)', async () => {
    // A big moov (many tracks/sample tables): above the smallest piece, so halving can't help; it
    // goes in whole or not at all. Pre-init budget 500 B: it never fits.
    const init = concat(box('ftyp', new Uint8Array(8)), box('moov', new Uint8Array(40_000)));
    expect(init.byteLength).toBeGreaterThan(MIN_APPEND_BYTES);
    const { sb, state, produce, runUntil } = setup(10_000);
    let attempts = 0;
    const append = sb.appendBuffer.bind(sb);
    sb.appendBuffer = (data) => {
      // A retry without a wait would call this thousands of times before the first tick.
      if (++attempts > 1000) throw new Error('append retried without waiting');
      append(data);
    };
    const run = produce([concat(init, fragment(0, 1))]);
    await runUntil(() => run.settled || state.clock >= STARVED_TIMEOUT_MS - 1000);
    expect(run.settled).toBe(false);
    const ticks = STARVED_TIMEOUT_MS / 250;
    expect(attempts).toBeLessThan(2 * ticks);
    await runUntil(() => run.settled, 200);
    expect(run.error).toBeInstanceOf(PlaybackError);
    expect((run.error as PlaybackError).message).toContain(
      `video: ${init.byteLength} B append refused`,
    );
    expect(sb.appends).toEqual([]);
  });
});

describe('initSegmentLength', () => {
  it('finds the init segment in front of media in the same chunk', () => {
    const [first, second] = writes(2);
    expect(initSegmentLength(first!)).toBe(INIT.byteLength);
    expect(initSegmentLength(second!)).toBe(0);
    // An init segment alone needs no split.
    expect(initSegmentLength(INIT)).toBe(0);
    // A moov cut off by the chunk end stays with what follows; only the ftyp before it goes first.
    expect(initSegmentLength(INIT.subarray(0, 500))).toBe(16);
  });
});

describe('simulateQuota', () => {
  it('refuses an append with media before the init segment past the pre-init share', async () => {
    const sb = new FakeSourceBuffer(Infinity);
    let hits = 0;
    simulateQuota(sb, 1_000_000, () => hits++);
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const [first] = writes(1, 2);
    expect(isQuotaError(() => sb.appendBuffer(first!))).toBe(true);
    expect(hits).toBe(1);
    sb.appendBuffer(INIT);
    await settle();
    sb.appendBuffer(fragment(0, 2));
    await settle();
    expect(formatRanges(sb.buffered)).toBe('0.0–2.0 s');
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
