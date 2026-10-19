import { describe, expect, it } from 'vitest';
import {
  ac3Framer,
  aacObjectType,
  adtsAudioSpecificConfig,
  adtsFramer,
  audioLayout,
  mp3Framer,
} from './audio';
import { aviVideoFormatName, isH264FourCC } from './fourcc';
import { gopPocs, gopPresentationRanks, nalUnits, type SliceInfo } from './h264';
import type { WaveFormat } from './riff';

describe('fourcc', () => {
  it('names the formats a browser cannot play', () => {
    expect(aviVideoFormatName('XVID')).toBe('DivX/Xvid (MPEG-4 Part 2)');
    expect(aviVideoFormatName('dx50')).toBe('DivX/Xvid (MPEG-4 Part 2)');
    expect(aviVideoFormatName('DIV3')).toBe('DivX 3 / MS-MPEG4');
    expect(aviVideoFormatName('MJPG')).toBe('Motion JPEG');
    expect(aviVideoFormatName('ABCD')).toBe('ABCD video');
  });
  it('recognises H.264 FourCCs case-insensitively', () => {
    expect(isH264FourCC('H264')).toBe(true);
    expect(isH264FourCC('avc1')).toBe(true);
    expect(isH264FourCC('XVID')).toBe(false);
  });
});

describe('audio framers', () => {
  it('sizes MPEG-1 layer III frames, with padding', () => {
    // 128 kb/s, 44.1 kHz: 417 bytes, 418 padded.
    expect(mp3Framer.parse(Uint8Array.of(0xff, 0xfb, 0x90, 0x00), 0)).toEqual({
      size: 417,
      samples: 1152,
    });
    expect(mp3Framer.parse(Uint8Array.of(0xff, 0xfb, 0x92, 0x00), 0)).toEqual({
      size: 418,
      samples: 1152,
    });
    expect(mp3Framer.parse(Uint8Array.of(0xff, 0xfb, 0xf0, 0x00), 0)).toBeNull(); // bad bitrate
  });
  it('sizes AC-3 frames (48 kHz, 192 kb/s → 768 bytes)', () => {
    // sync 0B77, crc, fscod 0 + frmsizecod 0x14 (192 kb/s), bsid 8.
    const h = Uint8Array.of(0x0b, 0x77, 0, 0, 0x14, 0x40, 0, 0);
    expect(ac3Framer.parse(h, 0)).toEqual({ size: 768, samples: 1536 });
  });
  it('drops the ADTS header and builds the AudioSpecificConfig', () => {
    // AAC LC, 44.1 kHz (index 4), stereo, frame length 100, no CRC.
    const len = 100;
    const h = Uint8Array.of(
      0xff,
      0xf1,
      0x50,
      0x80 | (len >> 11),
      (len >> 3) & 0xff,
      ((len & 7) << 5) | 0x1f,
      0xfc,
    );
    expect(adtsFramer.parse(h, 0)).toEqual({ size: 100, samples: 1024, skip: 7 });
    const asc = adtsAudioSpecificConfig(h);
    expect([...asc]).toEqual([0x12, 0x10]);
    expect(aacObjectType(asc)).toBe(2);
  });
  it('maps wFormatTag to a codec', () => {
    const wf = (formatTag: number): WaveFormat => ({
      formatTag,
      channels: 2,
      sampleRate: 48000,
      avgBytesPerSec: 192000,
      blockAlign: 4,
      bitsPerSample: 16,
      extra: new Uint8Array(0),
    });
    expect(audioLayout(wf(0x55))).toMatchObject({ kind: 'framed', codec: 'mp3' });
    expect(audioLayout(wf(0x2000))).toMatchObject({ kind: 'framed', codec: 'ac3' });
    expect(audioLayout(wf(0x01))).toMatchObject({ kind: 'framed', codec: 'pcm-s16' });
    expect(audioLayout(wf(0x161))).toEqual({ kind: 'unsupported' }); // WMA
  });
});

describe('h264', () => {
  it('splits Annex B and length-prefixed NAL units', () => {
    const annexB = Uint8Array.of(0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3);
    expect(nalUnits(annexB).map((n) => n.type)).toEqual([7, 8]);
    const avcc = Uint8Array.of(0, 2, 0x65, 9, 0, 1, 0x41);
    expect(nalUnits(avcc, 2).map((n) => n.type)).toEqual([5, 1]);
  });
  it('orders an I P B B GOP by POC', () => {
    // Decode order I0 P6 B2 B4 (POC = 2 × frame): presentation I B B P.
    const s = (idr: boolean, refIdc: number, pocLsb: number): SliceInfo => ({
      idr,
      refIdc,
      pocLsb,
    });
    const pocs = gopPocs([s(true, 3, 0), s(false, 2, 6), s(false, 0, 2), s(false, 0, 4)], 8);
    expect(pocs).toEqual([0, 6, 2, 4]);
    expect(gopPresentationRanks(pocs)).toEqual([0, 3, 1, 2]);
  });
  it('tracks the POC MSB across an LSB wrap', () => {
    const s = (pocLsb: number): SliceInfo => ({ idr: false, refIdc: 1, pocLsb });
    expect(gopPocs([{ idr: true, refIdc: 3, pocLsb: 0 }, s(6), s(12), s(2), s(6)], 4)).toEqual([
      0, 6, 12, 18, 22,
    ]);
  });
  it('keeps the decode position of pictures without a POC', () => {
    expect(gopPresentationRanks([0, null, 4, 2])).toEqual([0, 1, 3, 2]);
  });
});
