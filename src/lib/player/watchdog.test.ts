import { describe, expect, it } from 'vitest';
import { nextStarvedFor, watchdogNotice } from './watchdog';

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

describe('nextStarvedFor', () => {
  const wait = { waiting: true, downloaded: 100, lastDownloaded: 100, dt: 1000 };
  it('grows while waiting and no bytes arrive', () => {
    expect(nextStarvedFor(5000, wait)).toBe(6000);
  });
  it('resets when bytes arrive', () => {
    expect(nextStarvedFor(5000, { ...wait, downloaded: 101 })).toBe(0);
  });
  it('resets when the player is not waiting (back-pressure, paused)', () => {
    expect(nextStarvedFor(5000, { ...wait, waiting: false })).toBe(0);
  });
  it('reaches stalled despite speed blips that deliver no bytes (failing web seed retries)', () => {
    let starved = 0;
    for (let i = 0; i < 30; i++) starved = nextStarvedFor(starved, wait);
    expect(watchdogNotice({ ...base, hasMetadata: true, starvedFor: starved })).toBe('stalled');
  });
});
