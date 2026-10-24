import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Torrent } from 'webtorrent/dist/webtorrent.min.js';
import { destroyTorrent } from './client';

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
