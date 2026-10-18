import { describe, expect, it } from 'vitest';
import { watchdogNotice } from './watchdog';

const base = { elapsed: 0, hasMetadata: false, numPeers: 0, starvedFor: 0 };

describe('watchdogNotice', () => {
  it('shows no-peers after 20 s without metadata and peers', () => {
    expect(watchdogNotice({ ...base, elapsed: 19_000 })).toBeNull();
    expect(watchdogNotice({ ...base, elapsed: 20_000 })).toBe('no-peers');
    expect(watchdogNotice({ ...base, elapsed: 60_000, numPeers: 1 })).toBeNull();
  });
  it('clears no-peers once metadata arrives', () => {
    expect(watchdogNotice({ ...base, elapsed: 60_000, hasMetadata: true })).toBeNull();
  });
  it('shows stalled after 30 s starved of data', () => {
    const meta = { ...base, hasMetadata: true, numPeers: 2, elapsed: 90_000 };
    expect(watchdogNotice({ ...meta, starvedFor: 29_000 })).toBeNull();
    expect(watchdogNotice({ ...meta, starvedFor: 30_000 })).toBe('stalled');
  });
});
