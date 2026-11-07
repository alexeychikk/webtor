import { readFileSync } from 'node:fs';
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { trueTimeAt, tsVideoPes } from '../../../e2e/support/byte-truth';
import { downloadedTimes, learnedPoints, type ByteTimePoint } from './byte-time';
import { PacketPoints, tapPacketPositions } from './packet-points';

describe('PacketPoints', () => {
  it('keeps one point per spacing slot, in time order, whatever order they come in', () => {
    const points = new PacketPoints(0.5);
    for (let i = 0; i < 30; i++) points.note(1000 + i * 100, i / 10);
    points.note(500, -1);
    expect(points.points().map((p) => p.time)).toEqual([-1, 0, 0.5, 1, 1.5, 2, 2.5]);
    expect(points.points()[1]).toEqual({ byte: 1000, time: 0 });
  });

  it('always keeps a keyframe, once per time', () => {
    const points = new PacketPoints(0.5);
    points.note(1000, 0);
    points.note(1100, 0.2, true);
    points.note(1100, 0.2, true);
    points.note(1150, 0.3);
    expect(points.points()).toEqual([
      { byte: 1000, time: 0 },
      { byte: 1100, time: 0.2 },
    ]);
  });

  it('ignores packets without a finite position or time', () => {
    const points = new PacketPoints();
    points.note(NaN, 1);
    points.note(-1, 1);
    points.note(Infinity, 1);
    points.note(100, NaN);
    expect(points.points()).toEqual([]);
  });
});

/*
 * A 30 s MPEG-TS at 30 fps whose first 15 s hold 90 % of the bytes (like vbr.ts), and the read
 * cursor at each fragment (one per second) running 8 s of media ahead of it, as Mediabunny's
 * packet queue reads after a seek. Held: from the piece at 20 s to the end, the playhead at 28 s.
 */
describe('a held range behind the playhead, with the read cursor running ahead', () => {
  const DURATION = 30;
  const byteAt = (t: number) => (t <= 15 ? 9_000 * t : 135_000 + 1_000 * (t - 15));
  const frames: ByteTimePoint[] = Array.from({ length: DURATION * 30 }, (_, i) => ({
    byte: byteAt(i / 30),
    time: i / 30,
  }));
  const LENGTH = byteAt(DURATION);
  const held = [{ start: byteAt(20), end: LENGTH }];
  const drawnStart = (points: readonly ByteTimePoint[]) =>
    downloadedTimes(held, { points, whole: false }, LENGTH, DURATION)[0]![0] * DURATION;

  it('starts ~8 s early through the cursor samples', () => {
    const samples = Array.from({ length: DURATION }, (_, t) => ({
      byte: byteAt(Math.min(DURATION, t + 8)),
      time: t,
      run: 1,
    }));
    expect(drawnStart(learnedPoints(samples))).toBeLessThan(13);
  });

  it('starts at its time through the packet positions', () => {
    const points = new PacketPoints();
    for (const f of frames) points.note(f.byte, f.time, f.time % 2 === 0);
    expect(drawnStart(points.points())).toBeCloseTo(20, 1);
  });
});

describe('tapPacketPositions on vbr.ts', () => {
  const bytes = readFileSync(new URL('../../../e2e/fixtures/vbr.ts', import.meta.url));
  const pes = tsVideoPes(bytes);

  it('records every packet the demuxer hands out at the offset of its PES', async () => {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
    const track = (await input.getPrimaryVideoTrack())!;
    const seen: { byte: number; time: number; key: boolean }[] = [];
    expect(tapPacketPositions(track, (byte, time, key) => seen.push({ byte, time, key }))).toBe(
      true,
    );
    const sink = new EncodedPacketSink(track);
    const keyAt20 = await sink.getKeyPacket(20, { metadataOnly: true });
    let n = 0;
    for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
      expect(packet.sequenceNumber).toBeGreaterThanOrEqual(0);
      n++;
    }
    expect(seen.length).toBeGreaterThan(n);
    expect(seen.some((s) => s.key && s.time === keyAt20!.timestamp)).toBe(true);
    const pesAt = new Map(pes.map((p) => [p.byte, p.time]));
    for (const s of seen) {
      expect(bytes[s.byte]).toBe(0x47);
      expect(pesAt.get(s.byte)).toBeCloseTo(s.time, 3);
    }
  });

  it('draws a held range from its true time, within a second', async () => {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
    const track = (await input.getPrimaryVideoTrack())!;
    const points = new PacketPoints();
    tapPacketPositions(track, (byte, time, key) => points.note(byte, time, key));
    const start = await track.getFirstTimestamp();
    const sink = new EncodedPacketSink(track);
    for (let p = await sink.getFirstPacket(); p; p = await sink.getNextPacket(p));
    const duration = (await input.computeDuration()) - start;
    const index = {
      points: points.points().map((p) => ({ byte: p.byte, time: p.time - start })),
      whole: false,
    };
    const frames = pes.map((p) => ({ byte: p.byte, time: p.time - start }));
    for (const from of [0.2, 0.5, 0.7, 0.9, 0.95]) {
      const byte = Math.floor((from * bytes.length) / 188) * 188;
      const [range] = downloadedTimes(
        [{ start: byte, end: bytes.length }],
        index,
        bytes.length,
        duration,
      );
      expect(Math.abs(range![0] * duration - trueTimeAt(frames, byte, duration))).toBeLessThan(1);
    }
  });
});
