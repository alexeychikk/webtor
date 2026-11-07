import { describe, expect, it } from 'vitest';
import type { RelayStats } from '../torrent/relay';
import { playbackErrorMessage } from './errors';
import {
  DECODE_SPOT_S,
  MAX_REOPENS,
  RELAY_FLOW_MIN,
  RELAY_STATS_MAX_MISSES,
  STALLED_AFTER_MS,
  nextRelaySamples,
  nextDecodeReopen,
  nextReopen,
  nextStarvedFor,
  relayFlowOf,
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

describe('nextDecodeReopen', () => {
  it('counts reopens in a row, then fails', () => {
    expect(nextDecodeReopen(0, false, 0, 12)).toBe(1);
    expect(nextDecodeReopen(1, false, 12, 12)).toBe(2);
    expect(nextDecodeReopen(MAX_REOPENS, false, 12, 30)).toBeNull();
  });
  it('starts a new row once the reopened player recovered and failed elsewhere', () => {
    expect(nextDecodeReopen(MAX_REOPENS, true, 12, 12 + DECODE_SPOT_S + 1)).toBe(1);
    expect(nextDecodeReopen(2, true, 20, 3)).toBe(1);
  });
  it('keeps the row when the reopened player fails again at the same spot', () => {
    expect(nextDecodeReopen(1, true, 12, 12)).toBe(2);
    expect(nextDecodeReopen(2, true, 12, 12 + DECODE_SPOT_S)).toBe(3);
    expect(nextDecodeReopen(MAX_REOPENS, true, 12, 14)).toBeNull();
    expect(nextDecodeReopen(1, true, 0, 0.5)).toBe(2);
  });
});

describe('relayFlowOf', () => {
  const stats: RelayStats = {
    activePeers: 5,
    seeders: 5,
    hasMetadata: true,
    rates: { download: 2_000_000, upload: 0, served: 1_900_000, uploadLimit: 0 },
  };
  it('is the last /stats rates while the relay answers', () => {
    expect(relayFlowOf(stats, 0)).toEqual({
      activePeers: 5,
      download: 2_000_000,
      served: 1_900_000,
    });
    expect(relayFlowOf(stats, RELAY_STATS_MAX_MISSES - 1)).toMatchObject({ served: 1_900_000 });
  });
  it('is null without rates (api < 3)', () => {
    expect(relayFlowOf(null, 0)).toBeNull();
    expect(relayFlowOf({ ...stats, rates: undefined }, 0)).toBeNull();
  });
  it('drops stale rates once the relay stops answering', () => {
    expect(relayFlowOf(stats, RELAY_STATS_MAX_MISSES)).toBe('unreachable');
    expect(relayFlowOf(null, RELAY_STATS_MAX_MISSES)).toBe('unreachable');
    expect(stalledNotice(relayFlowOf(stats, RELAY_STATS_MAX_MISSES))).toEqual({
      code: 'relay-not-answering',
    });
  });
});

describe('relay samples over the stalled window', () => {
  const stats: RelayStats = {
    activePeers: 5,
    seeders: 5,
    hasMetadata: true,
    rates: { download: 300_000, upload: 0, served: 0, uploadLimit: 0 },
  };
  const at = (s: number, read: number, served: number) => ({ at: s * 1000, read, served });

  it('keeps the last STALLED_AFTER_MS of samples, one older as the base', () => {
    let samples = [at(0, 0, 0)];
    for (let s = 2; s <= 40; s += 2) samples = nextRelaySamples(samples, at(s, s, s));
    expect(samples[0]?.at).toBe(40_000 - STALLED_AFTER_MS);
    expect(samples.at(-1)?.at).toBe(40_000);
  });
  it('starts over when a total goes back (the relay restarted)', () => {
    const samples = nextRelaySamples([at(0, 5_000, 5_000), at(2, 9_000, 9_000)], at(4, 100, 0));
    expect(samples).toEqual([at(4, 100, 0)]);
  });
  it('a web-seed response served in bursts is the swarm being slow, not the relay (QA repro)', () => {
    // 300 kB/s from the peers; servedRate reads 0 while the relay waits for the next in-order
    // chunk, but bytesServed grew over the stall (8.37 → 8.6 MB).
    let samples: ReturnType<typeof nextRelaySamples> = [];
    for (let s = 0; s <= 30; s += 2) {
      samples = nextRelaySamples(samples, at(s, s * 300_000, 8_370_000 + (s >= 20 ? 230_000 : 0)));
    }
    const flow = relayFlowOf(stats, 0, samples);
    expect(flow).toMatchObject({ download: 300_000 });
    expect(stalledNotice(flow).code).toBe('relay-swarm-slow');
  });
  it('blames the relay when its served total stands still over the window', () => {
    let samples: ReturnType<typeof nextRelaySamples> = [];
    for (let s = 0; s <= 30; s += 2)
      samples = nextRelaySamples(samples, at(s, s * 300_000, 8_370_000));
    expect(stalledNotice(relayFlowOf(stats, 0, samples))).toEqual({
      code: 'relay-not-serving',
      detail: '300 kB/s',
    });
  });
  it('uses the totals for the peers too: a burst between polls is not a dead swarm', () => {
    const idle = { ...stats, rates: { ...stats.rates!, download: 0 } };
    const samples = [at(0, 0, 0), at(30, 60_000, 0)];
    expect(stalledNotice(relayFlowOf(idle, 0, samples)).code).toBe('relay-not-serving');
    expect(stalledNotice(relayFlowOf(idle, 0, [at(0, 0, 0), at(30, 0, 0)])).code).toBe(
      'relay-swarm-stalled',
    );
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
