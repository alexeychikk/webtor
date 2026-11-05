import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Torrent } from 'webtorrent/dist/webtorrent.min.js';
import { destroyTorrent, evictPieces, storedBytes } from './client';
import { MemoryChunkStore } from './memory-store';

/** A torrent whose `destroy` calls back after `after` ms, or never (`null`), like WebTorrent's. */
function fakeTorrent(after: number | null) {
  const t = {
    infoHash: 'a'.repeat(40),
    destroyed: false,
    destroy: vi.fn((_opts: unknown, cb: () => void) => {
      // WebTorrent returns early (no callback) when it is destroyed already.
      if (t.destroyed) return;
      t.destroyed = true;
      if (after !== null) setTimeout(cb, after);
    }),
  };
  return t;
}

const settled = (p: Promise<void>) => {
  let done = false;
  void p.then(() => (done = true));
  return () => done;
};

describe('destroyTorrent', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves once WebTorrent calls back', async () => {
    vi.useFakeTimers();
    const t = fakeTorrent(100);
    const done = settled(destroyTorrent(t as unknown as Torrent, 1000));
    await vi.advanceTimersByTimeAsync(99);
    expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done()).toBe(true);
    expect(t.destroy).toHaveBeenCalledWith({ destroyStore: true }, expect.any(Function));
  });

  it('gives up waiting after the timeout when the callback never comes (a stuck store)', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const done = settled(destroyTorrent(fakeTorrent(null) as unknown as Torrent, 1000));
    await vi.advanceTimersByTimeAsync(999);
    expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done()).toBe(true);
  });

  it('destroys once: a second call returns the first destroy', async () => {
    vi.useFakeTimers();
    const t = fakeTorrent(10);
    const first = destroyTorrent(t as unknown as Torrent, 1000);
    expect(destroyTorrent(t as unknown as Torrent, 1000)).toBe(first);
    expect(t.destroy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    await expect(first).resolves.toBeUndefined();
  });

  it('resolves at once for a torrent WebTorrent destroyed already', async () => {
    const t = fakeTorrent(null);
    t.destroyed = true;
    await expect(destroyTorrent(t as unknown as Torrent, 60_000)).resolves.toBeUndefined();
    expect(t.destroy).not.toHaveBeenCalled();
  });
});

/** A torrent with 4-byte pieces 0–9 verified in its store, a selection over 6–7, and `done`. */
async function windowTorrent() {
  const bits = new Set<number>();
  const t = {
    destroyed: false,
    pieceLength: 4,
    done: true,
    bitfield: { get: (i: number) => bits.has(i) },
    _selections: [{ from: 6, to: 7, offset: 0 }],
    _critical: [] as boolean[],
    _markUnverified: vi.fn((i: number) => bits.delete(i)),
    _checkDone: vi.fn(() => (t.done = false)),
  };
  const store = new MemoryChunkStore(4, { length: 40, torrent: t });
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => store.put(i, new Uint8Array(4), resolve));
    bits.add(i);
    t._critical[i] = true;
  }
  return { t, store, torrent: t as unknown as Torrent };
}

describe('evictPieces', () => {
  it('drops the verified pieces outside the kept bytes and marks them missing', async () => {
    const { t, store, torrent } = await windowTorrent();
    expect(evictPieces(torrent, { start: 9, end: 17 })).toBe(5);
    expect(store.indices().sort((a, b) => a - b)).toEqual([2, 3, 4, 6, 7]);
    expect(t._markUnverified.mock.calls.map(([i]) => i)).toEqual([0, 1, 5, 8, 9]);
    expect(t.bitfield.get(0)).toBe(false);
    expect(t._critical[0]).toBe(false);
    expect(t._critical[2]).toBe(true);
    expect(storedBytes(torrent)).toBe(20);
    expect(t._checkDone).toHaveBeenCalledOnce();
    expect(t.done).toBe(false);
  });

  it('keeps everything without a range, and skips pieces still being verified', async () => {
    const { t, torrent } = await windowTorrent();
    expect(evictPieces(torrent, null)).toBe(0);
    t.bitfield.get = (i) => i !== 0 && i < 6;
    expect(evictPieces(torrent, { start: 8, end: 12 })).toBe(4);
    expect(t._markUnverified.mock.calls.map(([i]) => i)).toEqual([1, 3, 4, 5]);
  });

  it('does nothing for a torrent without our store', () => {
    expect(evictPieces({ bitfield: { get: () => true } } as unknown as Torrent, null)).toBe(0);
    expect(storedBytes({} as Torrent)).toBe(0);
  });
});
