import { describe, expect, it } from 'vitest';
import { playbackErrorMessage } from './errors';
import {
  MAX_REOPENS,
  RELAY_FLOW_MIN,
  nextReopen,
  nextStarvedFor,
  stalledNotice,
  watchdogNotice,
} from './watchdog';

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

describe('nextReopen', () => {
  it('counts reopens in a row, then fails', () => {
    expect(nextReopen(0, false)).toBe(1);
    expect(nextReopen(1, false)).toBe(2);
    expect(nextReopen(MAX_REOPENS - 1, false)).toBe(MAX_REOPENS);
    expect(nextReopen(MAX_REOPENS, false)).toBeNull();
  });
  it('starts a new row once the reopened player recovered', () => {
    expect(nextReopen(MAX_REOPENS, true)).toBe(1);
    expect(nextReopen(2, true)).toBe(1);
  });
});

describe('stalledNotice', () => {
  const flow = { activePeers: 5, download: 0, served: 0 };
  it('is the plain stalled notice without a relay (or its rates)', () => {
    expect(stalledNotice(null)).toEqual({ code: 'stalled' });
  });
  it('blames the swarm when the relay gets nothing from its peers', () => {
    expect(stalledNotice(flow)).toEqual({ code: 'relay-swarm-stalled', detail: '5' });
    expect(stalledNotice({ ...flow, download: RELAY_FLOW_MIN - 1 }).code).toBe(
      'relay-swarm-stalled',
    );
  });
  it('blames the relay when it downloads but sends the browser nothing', () => {
    expect(stalledNotice({ ...flow, download: 2_500_000 })).toEqual({
      code: 'relay-not-serving',
      detail: '2.5 MB/s',
    });
  });
  it('calls the swarm too slow when data reaches the browser but no piece completes', () => {
    expect(stalledNotice({ ...flow, download: 500_000, served: 480_000 })).toEqual({
      code: 'relay-swarm-slow',
      detail: '500 kB/s',
    });
  });
  it('says it in plain words, with the number', () => {
    expect(playbackErrorMessage('relay-swarm-stalled', '5')).toMatch(
      /^The relay is connected to 5 peers, but they aren’t sending it any data\. The torrent’s swarm is stuck/,
    );
    expect(playbackErrorMessage('relay-swarm-stalled', '1')).toContain('connected to 1 peer,');
    expect(playbackErrorMessage('relay-swarm-stalled', '0')).toMatch(/^The relay has no peers/);
    expect(playbackErrorMessage('relay-not-serving', '2.5 MB/s')).toMatch(
      /^The relay is downloading \(2\.5 MB\/s\) but sends nothing to this browser\. The relay is stuck/,
    );
    expect(playbackErrorMessage('relay-swarm-slow', '500 kB/s')).toContain(
      'its peers send only 500 kB/s',
    );
  });
});
