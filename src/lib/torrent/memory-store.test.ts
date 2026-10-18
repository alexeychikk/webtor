import { describe, expect, it } from 'vitest';
import { MemoryChunkStore } from './memory-store';

const call = <T>(fn: (cb: (err: Error | null, value?: T) => void) => void) =>
  new Promise<T | undefined>((resolve, reject) =>
    fn((err, value) => (err ? reject(err) : resolve(value))),
  );

describe('MemoryChunkStore', () => {
  it('stores chunks and reads them back whole or in part', async () => {
    const store = new MemoryChunkStore(4, { length: 10 });
    await call((cb) => store.put(0, new Uint8Array([1, 2, 3, 4]), cb));
    await call((cb) => store.put(2, new Uint8Array([9, 10]), cb)); // the last chunk is shorter
    expect(await call<Uint8Array>((cb) => store.get(0, cb))).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await call<Uint8Array>((cb) => store.get(0, { offset: 1, length: 2 }, cb))).toEqual(
      new Uint8Array([2, 3]),
    );
    expect(await call<Uint8Array>((cb) => store.get(2, null, cb))).toEqual(new Uint8Array([9, 10]));
  });

  it('rejects missing chunks, wrong lengths and use after close', async () => {
    const store = new MemoryChunkStore(4, { length: 10 });
    await expect(call((cb) => store.get(1, cb))).rejects.toMatchObject({ notFound: true });
    await expect(call((cb) => store.put(1, new Uint8Array(3), cb))).rejects.toThrow(/length/);
    await call((cb) => store.destroy(cb));
    await expect(call((cb) => store.put(0, new Uint8Array(4), cb))).rejects.toThrow(/closed/);
  });
});
