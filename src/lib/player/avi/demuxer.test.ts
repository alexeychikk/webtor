import { readFileSync } from 'node:fs';
import * as mb from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { PlaybackError } from '../errors';
import type { ByteSource } from '../types';
import { AVI_FORMAT_NAME, createAviFormat } from './demuxer';

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../../../e2e/fixtures/${name}`, import.meta.url)));
}

function memorySource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: (start, end) => Promise.resolve(bytes.slice(start, end)) };
}

/** The same wiring as `MsePlayer.open`: our format first, Mediabunny's after it. */
function openInput(bytes: Uint8Array) {
  const source = memorySource(bytes);
  return new mb.Input({
    formats: [createAviFormat(mb, source), ...mb.ALL_FORMATS],
    source: new mb.CustomSource({
      getSize: () => source.size,
      read: (start, end) => source.read(start, end),
    }),
  });
}

async function allPackets(track: mb.InputTrack) {
  const out: mb.EncodedPacket[] = [];
  for await (const p of new mb.EncodedPacketSink(track).packets()) out.push(p);
  return out;
}

/**
 * Guards the Mediabunny internals the AVI demuxer implements (`_canReadInput`, `_createDemuxer`,
 * track backings). If an upgrade renames or reshapes them, these fail: re-check `demuxer.ts`.
 */
describe('AVI demuxer through Mediabunny (internals guard)', () => {
  it('reads avi-h264-mp3.avi: H.264 video and MP3 audio', async () => {
    const input = openInput(fixture('avi-h264-mp3.avi'));
    expect((await input.getFormat()).name).toBe(AVI_FORMAT_NAME);
    expect(await input.getMimeType()).toBe('video/x-msvideo');
    const video = (await input.getPrimaryVideoTrack())!;
    expect(await video.getCodec()).toBe('avc');
    expect(await video.getCodecParameterString()).toBe('avc1.64001e');
    expect(await video.getCodedWidth()).toBe(640);
    expect(await video.getCodedHeight()).toBe(360);
    expect(await video.getFirstTimestamp()).toBe(0);
    expect(await input.getDurationFromMetadata()).toBeCloseTo(12, 1);
    const config = await video.getDecoderConfig();
    expect(config?.description).toBeUndefined();

    const audio = (await input.getPrimaryAudioTrack())!;
    expect(await audio.getCodec()).toBe('mp3');
    expect(await audio.getSampleRate()).toBe(44100);
    expect(await audio.getNumberOfChannels()).toBeGreaterThan(0);
    input.dispose();
  });

  it('gives monotonic DTS and B-frame PTS in presentation order', async () => {
    const input = openInput(fixture('avi-h264-mp3.avi'));
    const video = (await input.getPrimaryVideoTrack())!;
    const packets = await allPackets(video);
    expect(packets.length).toBe(288);
    expect(packets[0]!.type).toBe('key');
    const dur = 1 / 24;
    // Every timestamp is a distinct frame slot, and decode order differs from presentation order.
    const pts = packets.map((p) => Math.round(p.timestamp / dur));
    expect(new Set(pts).size).toBe(packets.length);
    expect([...pts].sort((a, b) => a - b)).toEqual(pts.map((_, i) => i));
    expect(pts).not.toEqual(pts.map((_, i) => i));
    // DTS (decode index) never runs ahead of PTS: no frame is shown before it is decoded.
    pts.forEach((p, i) => expect(p).toBeGreaterThanOrEqual(i - 3));
    for (const p of packets)
      if (p.type === 'key') expect(Math.round(p.timestamp / dur) % 1).toBe(0);
    input.dispose();
  });

  it('finds the 6 s keyframe for a seek to 7.3 s', async () => {
    const input = openInput(fixture('avi-h264-mp3.avi'));
    const sink = new mb.EncodedPacketSink((await input.getPrimaryVideoTrack())!);
    const key = (await sink.getKeyPacket(7.3, { verifyKeyPackets: true }))!;
    expect(key.type).toBe('key');
    expect(key.timestamp).toBeCloseTo(6, 5);
    const at = (await sink.getPacket(7.3))!;
    expect(at.timestamp).toBeLessThanOrEqual(7.3);
    expect(at.timestamp).toBeGreaterThan(7.3 - 1 / 24 - 1e-6);
    const next = (await sink.getNextKeyPacket(key))!;
    expect(next.timestamp).toBeGreaterThan(6);
    input.dispose();
  });

  it('re-frames VBR MP3: contiguous frames, seek lands on the frame holding t', async () => {
    const input = openInput(fixture('avi-h264-mp3.avi'));
    const audio = (await input.getPrimaryAudioTrack())!;
    const packets = await allPackets(audio);
    expect(packets.length).toBe(461);
    for (let i = 1; i < packets.length; i++) {
      const prev = packets[i - 1]!;
      expect(packets[i]!.timestamp).toBeCloseTo(prev.timestamp + prev.duration, 6);
    }
    const sink = new mb.EncodedPacketSink(audio);
    const p = (await sink.getPacket(5))!;
    expect(p.timestamp).toBeLessThanOrEqual(5);
    expect(p.timestamp + p.duration).toBeGreaterThan(5);
    input.dispose();
  });

  it.each(['avi-xvid-mp3.avi', 'avi-xvid-ac3.avi'])(
    '%s: null video codec with its FourCC',
    async (name) => {
      const input = openInput(fixture(name));
      const video = (await input.getPrimaryVideoTrack())!;
      expect(await video.getCodec()).toBeNull();
      expect((await video.getInternalCodecId())?.toString().toUpperCase()).toBe('XVID');
      expect(await video.getCodedWidth()).toBe(320);
      input.dispose();
    },
  );

  it('reads AC-3 audio from avi-xvid-ac3.avi', async () => {
    const input = openInput(fixture('avi-xvid-ac3.avi'));
    const audio = (await input.getPrimaryAudioTrack())!;
    expect(await audio.getCodec()).toBe('ac3');
    const packets = await allPackets(audio);
    expect(packets.length).toBe(345); // 1536 samples each at 44.1 kHz ≈ 12 s
    // 96 kb/s at 44.1 kHz: 209-word frames, some 208 (padding alternation).
    expect(new Set(packets.map((p) => p.byteLength))).toEqual(new Set([416, 418]));
    const last = packets.at(-1)!;
    expect(last.timestamp + last.duration).toBeCloseTo(12, 0);
    const sink = new mb.EncodedPacketSink(audio);
    const p = (await sink.getPacket(7.5))!;
    expect(p.timestamp).toBeLessThanOrEqual(7.5);
    expect(p.timestamp + p.duration).toBeGreaterThan(7.5);
    input.dispose();
  });

  it('plays avi-h264-noidx.avi (no idx1) from 0 by scanning movi: same packets as indexed', async () => {
    const source = memorySource(fixture('avi-h264-noidx.avi'));
    const format = createAviFormat(mb, source);
    const input = new mb.Input({
      formats: [format],
      source: new mb.CustomSource({ getSize: () => source.size, read: source.read }),
    });
    const video = (await input.getPrimaryVideoTrack())!;
    expect(format.demuxer?.indexMode).toBe('scan');
    expect(await input.getDurationFromMetadata()).toBeCloseTo(12, 1);
    expect(await video.getCodecParameterString()).toBe('avc1.64001e');
    const packets = await allPackets(video);
    const indexed = openInput(fixture('avi-h264-mp3.avi'));
    const expected = await allPackets((await indexed.getPrimaryVideoTrack())!);
    expect(packets.map((p) => [p.timestamp, p.type, p.byteLength])).toEqual(
      expected.map((p) => [p.timestamp, p.type, p.byteLength]),
    );
    const audio = await allPackets((await input.getPrimaryAudioTrack())!);
    const expectedAudio = await allPackets((await indexed.getPrimaryAudioTrack())!);
    expect(audio.map((p) => p.timestamp)).toEqual(expectedAudio.map((p) => p.timestamp));
    // Scanned to the end: seeking is no longer limited.
    expect(format.demuxer?.seekLimit()).toBeNull();
    input.dispose();
    indexed.dispose();
  });

  it('rejects a RIFF AVI without movie data with a PlaybackError', async () => {
    const bytes = fixture('avi-h264-mp3.avi').slice(0, 8192);
    const input = openInput(bytes);
    const err = await input.getPrimaryVideoTrack().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaybackError);
    expect((err as PlaybackError).code).toBe('unsupported-container');
  });

  it('leaves other files to the other formats', async () => {
    const input = openInput(fixture('sample.mkv'));
    expect((await input.getFormat()).name).not.toBe(AVI_FORMAT_NAME);
    expect(await (await input.getPrimaryVideoTrack())!.getCodec()).toBe('avc');
  });
});
