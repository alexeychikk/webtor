import { describe, expect, it, vi } from 'vitest';
import { closableSource, toFileRange } from './byte-source';
import type { ByteSource } from '../player/types';

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

/** A source whose streams deliver `chunks` and then wait for data forever. */
function pendingSource(chunks: Uint8Array[] = []) {
  const cancelled = vi.fn();
  const source: ByteSource = {
    size: 100,
    read: () => {
      const queue = [...chunks];
      return new ReadableStream<Uint8Array>({
        pull: (controller) => {
          const next = queue.shift();
          if (next) controller.enqueue(next);
          return next ? undefined : new Promise<void>(() => {});
        },
        cancel: cancelled,
      });
    },
  };
  return { source, cancelled };
}

describe('closableSource', () => {
  it('passes reads through while open', async () => {
    const { source } = pendingSource([new Uint8Array([1, 2])]);
    const reader = (closableSource(source).read(0, 2) as ReadableStream<Uint8Array>).getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
  });

  it('cancels the streams still waiting for data and fails their readers on close', async () => {
    const { source, cancelled } = pendingSource([new Uint8Array([1])]);
    const closable = closableSource(source);
    const reader = (closable.read(0, 10) as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    const waiting = reader.read();
    closable.close();
    await expect(waiting).rejects.toThrow('the file was closed');
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('fails reads after close', async () => {
    const closable = closableSource(pendingSource().source);
    closable.close();
    await expect(closable.read(0, 1)).rejects.toThrow('the file was closed');
  });

  it('forgets a stream its reader cancelled', async () => {
    const { source, cancelled } = pendingSource();
    const closable = closableSource(source);
    await (closable.read(0, 10) as ReadableStream<Uint8Array>).cancel();
    closable.close();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
