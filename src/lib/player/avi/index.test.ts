import * as mb from 'mediabunny';
import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../types';
import { AviDemuxer, type AviAudioBacking, type AviVideoBacking } from './demuxer';
import { isH264KeyFrame, isMpeg4KeyFrame, nalUnits } from './h264';
import { ChunkTable, parseStdIndex, parseSuperIndex } from './riff';

/** Little-endian byte writer with back-patched chunk sizes. */
class Writer {
  private buf = new Uint8Array(1 << 16);
  n = 0;
  private room(k: number) {
    if (this.n + k <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    next.set(this.buf);
    this.buf = next;
  }
  private get dv() {
    return new DataView(this.buf.buffer);
  }
  u8(v: number) {
    this.room(1);
    this.buf[this.n++] = v;
  }
  u16(v: number) {
    this.room(2);
    this.dv.setUint16(this.n, v, true);
    this.n += 2;
  }
  u32(v: number) {
    this.room(4);
    this.dv.setUint32(this.n, v >>> 0, true);
    this.n += 4;
  }
  u64(v: number) {
    this.u32(v % 2 ** 32);
    this.u32(Math.floor(v / 2 ** 32));
  }
  str(s: string) {
    for (const c of s) this.u8(c.charCodeAt(0));
  }
  raw(b: Uint8Array) {
    this.room(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  zeros(k: number) {
    this.raw(new Uint8Array(k));
  }
  setU32(at: number, v: number) {
    this.dv.setUint32(at, v >>> 0, true);
  }
  setU64(at: number, v: number) {
    this.setU32(at, v % 2 ** 32);
    this.setU32(at + 4, Math.floor(v / 2 ** 32));
  }
  /** Starts a chunk (or `LIST`/`RIFF` with `type`); returns its header position. */
  begin(id: string, type?: string): number {
    const at = this.n;
    this.str(id);
    this.u32(0);
    if (type) this.str(type);
    return at;
  }
  end(at: number) {
    this.setU32(at + 4, this.n - at - 8);
    if (this.n & 1) this.u8(0);
  }
  chunk(id: string, data: Uint8Array): number {
    const at = this.begin(id);
    this.raw(data);
    this.end(at);
    return at;
  }
  bytes() {
    return this.buf.slice(0, this.n);
  }
}

const FPS = 25;
/** PCM 16-bit mono 8 kHz: 320 samples (640 bytes) per 40 ms video frame. */
const AUDIO_BYTES = 640;

/** H.264 frame `i` (Annex B): IDR every 5th frame, else a P slice; `pad` bytes of filler after. */
function frame(i: number, pad: number): Uint8Array {
  const head = i % 5 === 0 ? [0, 0, 0, 1, 0x65, 0x88, i] : [0, 0, 0, 1, 0x41, 0x9a, i];
  const b = new Uint8Array(head.length + pad);
  b.set(head);
  return b;
}

interface BuildOptions {
  frames?: number;
  /** Frames in the first RIFF; the rest go into a `RIFF AVIX` (OpenDML). */
  firstRiff?: number;
  idx1?: 'relative' | 'absolute' | 'none' | 'broken';
  /** `indx` super indexes + one `ix##` per stream per RIFF. */
  odml?: boolean;
  /** Filler bytes per video frame (to make the scan take several steps). */
  pad?: number;
  /** Group each frame's chunks in `LIST rec `. */
  rec?: boolean;
}

interface Entry {
  stream: number;
  header: number;
  size: number;
  key: boolean;
}

/** A synthetic AVI: stream 0 H.264 25 fps, stream 1 PCM, interleaved one chunk each per frame. */
function buildAvi(o: BuildOptions = {}) {
  const frames = o.frames ?? 20;
  const firstRiff = o.firstRiff ?? frames;
  const idx1 = o.idx1 ?? 'relative';
  const pad = o.pad ?? 0;
  const w = new Writer();
  const riff = w.begin('RIFF', 'AVI ');
  const hdrl = w.begin('LIST', 'hdrl');
  const avih = w.begin('avih');
  w.u32(1_000_000 / FPS);
  w.u32(0);
  w.u32(0);
  w.u32(idx1 === 'none' ? 0 : 0x10);
  w.u32(frames);
  w.u32(0);
  w.u32(2);
  w.u32(0);
  w.u32(64);
  w.u32(48);
  w.zeros(16);
  w.end(avih);
  const superFields: number[][] = [[], []];
  for (const s of [0, 1]) {
    const strl = w.begin('LIST', 'strl');
    const strh = w.begin('strh');
    w.str(s === 0 ? 'vids' : 'auds');
    w.str(s === 0 ? 'H264' : '\0\0\0\0');
    w.zeros(12); // flags, priority, language, initial frames
    w.u32(s === 0 ? 1 : 2); // scale
    w.u32(s === 0 ? FPS : 16_000); // rate
    w.u32(0); // start
    w.u32(s === 0 ? frames : (frames * AUDIO_BYTES) / 2); // length
    w.zeros(8); // buffer size, quality
    w.u32(s === 0 ? 0 : 2); // sample size
    w.zeros(8);
    w.end(strh);
    const strf = w.begin('strf');
    if (s === 0) {
      w.u32(40);
      w.u32(64);
      w.u32(48);
      w.u16(1);
      w.u16(24);
      w.str('H264');
      w.zeros(20);
    } else {
      w.u16(1);
      w.u16(1);
      w.u32(8000);
      w.u32(16_000);
      w.u16(2);
      w.u16(16);
      w.u16(0);
    }
    w.end(strf);
    if (o.odml) {
      const indx = w.begin('indx');
      w.u16(4);
      w.u8(0);
      w.u8(0);
      const riffs = firstRiff < frames ? 2 : 1;
      w.u32(riffs);
      w.str(s === 0 ? '00dc' : '01wb');
      w.zeros(12);
      for (let r = 0; r < riffs; r++) {
        superFields[s]!.push(w.n);
        w.zeros(16);
      }
      w.end(indx);
    }
    w.end(strl);
  }
  w.end(hdrl);

  const entries: Entry[] = [];
  /** Writes frames [from, to) into a `LIST movi`, plus its `ix##` chunks; returns the movi FourCC position. */
  const movi = (from: number, to: number, riffNo: number) => {
    const list = w.begin('LIST', 'movi');
    const base = list;
    const local: Entry[] = [];
    for (let i = from; i < to; i++) {
      const rec = o.rec ? w.begin('LIST', 'rec ') : -1;
      const v = frame(i, pad);
      local.push({ stream: 0, header: w.chunk('00dc', v), size: v.length, key: i % 5 === 0 });
      const a = new Uint8Array(AUDIO_BYTES).fill(i);
      local.push({ stream: 1, header: w.chunk('01wb', a), size: a.length, key: true });
      if (rec >= 0) w.end(rec);
    }
    if (o.odml) {
      for (const s of [0, 1]) {
        const mine = local.filter((e) => e.stream === s);
        const ix = w.begin(s === 0 ? 'ix00' : 'ix01');
        w.u16(2);
        w.u8(0);
        w.u8(1);
        w.u32(mine.length);
        w.str(s === 0 ? '00dc' : '01wb');
        w.u64(base);
        w.u32(0);
        for (const e of mine) {
          w.u32(e.header + 8 - base);
          w.u32(e.size | (e.key ? 0 : 0x80000000));
        }
        w.end(ix);
        const field = superFields[s]![riffNo]!;
        w.setU64(field, ix);
        w.setU32(field + 8, w.n - ix);
        w.setU32(field + 12, s === 0 ? mine.length : (mine.length * AUDIO_BYTES) / 2);
      }
    }
    w.end(list);
    entries.push(...local);
    return list + 8;
  };
  const moviPos = movi(0, firstRiff, 0);
  if (idx1 !== 'none') {
    const idx = w.begin('idx1');
    for (const e of entries) {
      w.str(e.stream === 0 ? '00dc' : '01wb');
      w.u32(e.key ? 0x10 : 0);
      const rel = e.header - moviPos;
      w.u32(idx1 === 'absolute' ? e.header : idx1 === 'broken' ? rel + 10_000_000 : rel);
      w.u32(e.size);
    }
    w.end(idx);
  }
  w.end(riff);
  if (firstRiff < frames) {
    const avix = w.begin('RIFF', 'AVIX');
    movi(firstRiff, frames, 1);
    w.end(avix);
  }
  return { bytes: w.bytes(), entries };
}

function memorySource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: (start, end) => Promise.resolve(bytes.slice(start, end)) };
}

async function open(bytes: Uint8Array) {
  const demuxer = new AviDemuxer(mb, memorySource(bytes));
  const backings = await demuxer.getTrackBackings();
  const video = backings.find((b) => b.getType() === 'video') as AviVideoBacking;
  const audio = backings.find((b) => b.getType() === 'audio') as AviAudioBacking;
  return { demuxer, video, audio };
}

async function videoPackets(video: AviVideoBacking) {
  const out: mb.EncodedPacket[] = [];
  for (let p = await video.getFirstPacket({}); p; p = await video.getNextPacket(p, {})) out.push(p);
  return out;
}

async function audioSamples(audio: AviAudioBacking) {
  let seconds = 0;
  let count = 0;
  for (let p = await audio.getFirstPacket({}); p; p = await audio.getNextPacket(p, {})) {
    expect(p.timestamp).toBeCloseTo(seconds, 6);
    seconds += p.duration;
    count += p.byteLength;
  }
  return { seconds, bytes: count };
}

/** Frame number written into each video chunk, in packet order. */
const frameNumbers = (packets: mb.EncodedPacket[]) => packets.map((p) => p.data[6]);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('AVI indexes on synthetic files', () => {
  it.each(['relative', 'absolute'] as const)('reads idx1 with %s offsets', async (idx1) => {
    const { bytes } = buildAvi({ idx1 });
    const { demuxer, video, audio } = await open(bytes);
    expect(demuxer.indexMode).toBe('idx1');
    expect(demuxer.seekLimit()).toBeNull();
    const packets = await videoPackets(video);
    expect(frameNumbers(packets)).toEqual(range(20));
    expect(packets.map((p) => p.type === 'key')).toEqual(range(20).map((i) => i % 5 === 0));
    expect(packets.map((p) => Math.round(p.timestamp * FPS * 1e6) / 1e6)).toEqual(range(20));
    expect((await video.getKeyPacket(0.5, {}))!.timestamp).toBeCloseTo(0.4, 6);
    expect(await audioSamples(audio)).toEqual({ seconds: 0.8, bytes: 20 * AUDIO_BYTES });
  });

  it('reads OpenDML with 2 RIFFs lazily: indx → ix## per RIFF', async () => {
    // idx1 covers the first RIFF only, as OpenDML writers leave it: the super index wins.
    const { bytes } = buildAvi({ odml: true, firstRiff: 12 });
    const reads: Array<[number, number]> = [];
    const source = memorySource(bytes);
    const demuxer = new AviDemuxer(mb, {
      size: source.size,
      read: (s, e) => (reads.push([s, e]), source.read(s, e)),
    });
    const backings = await demuxer.getTrackBackings();
    const video = backings[0] as AviVideoBacking;
    const audio = backings[1] as AviAudioBacking;
    expect(demuxer.indexMode).toBe('odml');
    // Opened on the first RIFF's ix## alone: the duration comes from the super index.
    expect(await video.getDurationFromMetadata()).toBeCloseTo(0.8, 6);
    expect(await audio.getDurationFromMetadata()).toBeCloseTo(0.8, 6);
    const text = new TextDecoder('latin1').decode(bytes);
    const secondIx00 = text.indexOf('ix00', text.indexOf('AVIX'));
    const readsIt = () => reads.some(([s]) => s === secondIx00);
    expect(readsIt()).toBe(false);

    // A seek into the second RIFF loads its ix##.
    const key = (await video.getKeyPacket(0.7, {}))!;
    expect(readsIt()).toBe(true);
    expect(key.timestamp).toBeCloseTo(0.6, 6);
    expect(key.data[6]).toBe(15);
    const packets = await videoPackets(video);
    expect(frameNumbers(packets)).toEqual(range(20));
    expect(packets.map((p) => p.type === 'key')).toEqual(range(20).map((i) => i % 5 === 0));
    expect(await audioSamples(audio)).toEqual({ seconds: 0.8, bytes: 20 * AUDIO_BYTES });
  });

  it('scans movi without an index, across LIST rec and into the AVIX RIFF', async () => {
    const { bytes } = buildAvi({ idx1: 'none', firstRiff: 8, rec: true });
    const { demuxer, video, audio } = await open(bytes);
    expect(demuxer.indexMode).toBe('scan');
    expect(await video.getDurationFromMetadata()).toBeCloseTo(0.8, 6);
    const packets = await videoPackets(video);
    expect(frameNumbers(packets)).toEqual(range(20));
    // Key frames found from the NAL units (IDR), not from index flags.
    expect(packets.map((p) => p.type === 'key')).toEqual(range(20).map((i) => i % 5 === 0));
    expect(await audioSamples(audio)).toEqual({ seconds: 0.8, bytes: 20 * AUDIO_BYTES });
    expect(demuxer.seekLimit()).toBeNull();
  });

  it('limits seeks to the scanned part until the scan reaches the end', async () => {
    // 64 KiB frames: the first 512 KiB scan step sees about 8 of 20.
    const { bytes } = buildAvi({ idx1: 'none', pad: 64 * 1024 });
    const { demuxer, video } = await open(bytes);
    const limit = demuxer.seekLimit()!;
    expect(limit).toBeGreaterThan(0.1);
    expect(limit).toBeLessThan(0.5);
    // A seek past it lands on the last scanned key frame, without scanning further.
    const key = (await video.getKeyPacket(0.7, {}))!;
    expect(key.timestamp).toBeLessThanOrEqual(limit);
    expect(demuxer.seekLimit()).toBe(limit);
    // Playing forward scans on.
    expect(frameNumbers(await videoPackets(video))).toEqual(range(20));
    expect(demuxer.seekLimit()).toBeNull();
  });

  it('plays a truncated file up to its last whole chunk, duration from avih', async () => {
    const { bytes, entries } = buildAvi({ idx1: 'relative' });
    // Cut in the middle of frame 13's video chunk: idx1 (at the end) is gone too.
    const cut = entries.find((e) => e.stream === 0 && e.header > 0 && frameAt(bytes, e) === 13)!;
    const { demuxer, video, audio } = await open(bytes.slice(0, cut.header + 8 + 3));
    expect(demuxer.indexMode).toBe('scan');
    expect(await video.getDurationFromMetadata()).toBeCloseTo(0.8, 6);
    expect(frameNumbers(await videoPackets(video))).toEqual(range(13));
    expect(await audioSamples(audio)).toEqual({ seconds: 13 * 0.04, bytes: 13 * AUDIO_BYTES });
  });

  it('falls back to the scan when idx1 points outside movi', async () => {
    const { bytes } = buildAvi({ idx1: 'broken' });
    const { demuxer, video } = await open(bytes);
    expect(demuxer.indexMode).toBe('scan');
    expect(frameNumbers(await videoPackets(video))).toEqual(range(20));
  });
});

function frameAt(bytes: Uint8Array, e: Entry): number {
  return bytes[e.header + 8 + 6]!;
}

describe('OpenDML index parsers', () => {
  it('reads super index entries and skips unused ones', () => {
    const w = new Writer();
    w.u16(4);
    w.u8(0);
    w.u8(0);
    w.u32(2);
    w.str('00dc');
    w.zeros(12);
    w.u64(2 ** 32 + 100);
    w.u32(4096);
    w.u32(250);
    w.zeros(16);
    expect(parseSuperIndex(w.bytes())).toEqual([
      { offset: 2 ** 32 + 100, size: 4096, duration: 250 },
    ]);
  });

  it('reads standard index entries: 64-bit base, key flag in bit 31', () => {
    const w = new Writer();
    w.u16(2);
    w.u8(0);
    w.u8(1);
    w.u32(2);
    w.str('00dc');
    w.u64(3 * 2 ** 32);
    w.u32(0);
    w.u32(16);
    w.u32(1000);
    w.u32(1200);
    w.u32(0x80000000 | 500);
    const t = new ChunkTable();
    expect(parseStdIndex(w.bytes(), t)).toBe(true);
    expect(t.length).toBe(2);
    expect([...t.offsets.subarray(0, 2)]).toEqual([3 * 2 ** 32 + 16, 3 * 2 ** 32 + 1200]);
    expect([...t.sizes.subarray(0, 2)]).toEqual([1000, 500]);
    expect([...t.keys.subarray(0, 2)]).toEqual([1, 0]);
  });
});

describe('key frame tests for the movi scan', () => {
  it('H.264: IDR and I slices are key, P slices are not', () => {
    expect(isH264KeyFrame(nalUnits(Uint8Array.of(0, 0, 1, 0x65, 0x88)))).toBe(true);
    // slice_type ue(7) = I (all-I), first_mb 0: bits 1 0001000
    expect(isH264KeyFrame(nalUnits(Uint8Array.of(0, 0, 1, 0x41, 0x88)))).toBe(true);
    expect(isH264KeyFrame(nalUnits(Uint8Array.of(0, 0, 1, 0x41, 0x9a)))).toBe(false);
    expect(isH264KeyFrame(nalUnits(Uint8Array.of(0, 0, 1, 0x06, 0x05)))).toBe(false);
  });
  it('MPEG-4 Part 2: I-VOP is key; null without a VOP', () => {
    expect(isMpeg4KeyFrame(Uint8Array.of(0, 0, 1, 0xb6, 0x10))).toBe(true);
    expect(isMpeg4KeyFrame(Uint8Array.of(0, 0, 1, 0xb6, 0x50))).toBe(false);
    expect(isMpeg4KeyFrame(Uint8Array.of(1, 2, 3, 4, 5))).toBeNull();
  });
});
