/**
 * AVI audio (ADR 0007 §1): `WAVEFORMATEX.wFormatTag` → Mediabunny codec, and frame parsers that
 * split an audio stream into codec frames. Chunk boundaries mean nothing in AVI (VBR, empty
 * interleave chunks, frames spanning chunks), so the demuxer treats a stream as one byte stream and
 * re-frames it with these. Pure.
 */
import type { WaveFormat } from './riff';

export interface AudioFrame {
  /** Bytes of the whole frame, header included. */
  size: number;
  /** PCM samples (per channel) it decodes to. */
  samples: number;
  /** Header bytes to drop from the packet (ADTS: the MP4 sample is the raw AAC frame). */
  skip?: number;
}

export interface Framer {
  /** Bytes `parse` needs to read a header. */
  readonly headerSize: number;
  /** The frame starting at `b[o]`, or null if no valid header starts there. */
  parse(b: Uint8Array, o: number): AudioFrame | null;
}

const MP3_BITRATES = {
  v1: [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // layer I
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], // layer II
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // layer III
  ],
  v2: [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
};
const MP3_RATES = [44100, 48000, 32000];

/** MPEG audio (layer III, also I/II) frame headers. */
export const mp3Framer: Framer = {
  headerSize: 4,
  parse(b, o) {
    if (o + 4 > b.length || b[o] !== 0xff || (b[o + 1]! & 0xe0) !== 0xe0) return null;
    const version = (b[o + 1]! >> 3) & 3; // 0: 2.5, 2: 2, 3: 1
    const layer = 4 - ((b[o + 1]! >> 1) & 3); // 1..3; 4 = reserved
    const brIndex = b[o + 2]! >> 4;
    const srIndex = (b[o + 2]! >> 2) & 3;
    const padding = (b[o + 2]! >> 1) & 1;
    if (version === 1 || layer === 4 || brIndex === 0 || brIndex === 15 || srIndex === 3)
      return null;
    const kbps = (version === 3 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[layer - 1]![brIndex]!;
    const sampleRate = MP3_RATES[srIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const br = kbps * 1000;
    if (layer === 1)
      return { size: (Math.floor((12 * br) / sampleRate) + padding) * 4, samples: 384 };
    const lowRateL3 = layer === 3 && version !== 3;
    const size = Math.floor(((lowRateL3 ? 72 : 144) * br) / sampleRate) + padding;
    return { size, samples: lowRateL3 ? 576 : 1152 };
  },
};

const AC3_KBPS = [
  32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640,
];

/** AC-3 (and E-AC-3) sync frames: sync word 0x0B77. */
export const ac3Framer: Framer = {
  headerSize: 6,
  parse(b, o) {
    if (o + 6 > b.length || b[o] !== 0x0b || b[o + 1] !== 0x77) return null;
    const bsid = b[o + 5]! >> 3;
    if (bsid > 10) {
      // E-AC-3: frmsiz in 16-bit words, numblkscod blocks of 256 samples.
      const words = (((b[o + 2]! & 7) << 8) | b[o + 3]!) + 1;
      const fscod = b[o + 4]! >> 6;
      const blocks = fscod === 3 ? 6 : [1, 2, 3, 6][(b[o + 4]! >> 4) & 3]!;
      return words > 2 ? { size: words * 2, samples: blocks * 256 } : null;
    }
    const fscod = b[o + 4]! >> 6;
    const code = b[o + 4]! & 0x3f;
    const kbps = AC3_KBPS[code >> 1];
    if (fscod === 3 || kbps === undefined) return null;
    const words =
      fscod === 0 ? kbps * 2 : fscod === 2 ? kbps * 3 : Math.floor((kbps * 320) / 147) + (code & 1);
    return { size: words * 2, samples: 1536 };
  },
};

/** DTS core frames (16-bit big-endian sync 0x7FFE8001). */
export const dtsFramer: Framer = {
  headerSize: 10,
  parse(b, o) {
    if (o + 10 > b.length) return null;
    if (b[o] !== 0x7f || b[o + 1] !== 0xfe || b[o + 2] !== 0x80 || b[o + 3] !== 0x01) return null;
    // After the sync: FTYPE(1) SHORT(5) CPF(1) NBLKS(7) FSIZE(14)
    const bits = (b[o + 4]! << 24) | (b[o + 5]! << 16) | (b[o + 6]! << 8) | b[o + 7]!;
    const nblks = (bits >>> 18) & 0x7f;
    const fsize = ((bits >>> 4) & 0x3fff) + 1;
    if (fsize < 96 || nblks < 5) return null;
    return { size: fsize, samples: (nblks + 1) * 32 };
  },
};

/** AAC in ADTS frames; the packet is the raw frame after the 7/9-byte header. */
export const adtsFramer: Framer = {
  headerSize: 7,
  parse(b, o) {
    if (o + 7 > b.length || b[o] !== 0xff || (b[o + 1]! & 0xf6) !== 0xf0) return null;
    const protectionAbsent = b[o + 1]! & 1;
    const size = ((b[o + 3]! & 3) << 11) | (b[o + 4]! << 3) | (b[o + 5]! >> 5);
    const header = protectionAbsent ? 7 : 9;
    if (size <= header) return null;
    return { size, samples: 1024 * ((b[o + 6]! & 3) + 1), skip: header };
  },
};

/** AudioSpecificConfig (2 bytes) from an ADTS header at `b[o]`. */
export function adtsAudioSpecificConfig(b: Uint8Array, o = 0): Uint8Array {
  const objectType = (b[o + 2]! >> 6) + 1;
  const srIndex = (b[o + 2]! >> 2) & 0xf;
  const channels = ((b[o + 2]! & 1) << 2) | (b[o + 3]! >> 6);
  return new Uint8Array([
    (objectType << 3) | (srIndex >> 1),
    ((srIndex & 1) << 7) | (channels << 3),
  ]);
}

/** Packets of 1024 PCM sample frames (`blockAlign` bytes each). */
export function pcmFramer(blockAlign: number): Framer {
  return { headerSize: 0, parse: () => ({ size: blockAlign * 1024, samples: 1024 }) };
}

/** AAC object type from an AudioSpecificConfig (5 bits, 31 = escape). */
export function aacObjectType(asc: Uint8Array): number {
  const t = (asc[0] ?? 0) >> 3;
  return t === 31 ? 32 + ((((asc[0] ?? 0) & 7) << 3) | ((asc[1] ?? 0) >> 5)) : t;
}

export type AudioCodec =
  | 'mp3'
  | 'ac3'
  | 'dts'
  | 'aac'
  | 'pcm-u8'
  | 'pcm-s16'
  | 'pcm-s24'
  | 'pcm-s32'
  | 'pcm-f32'
  | 'pcm-f64'
  | 'alaw'
  | 'ulaw';

export type AudioLayout =
  /** Byte stream split into codec frames. */
  | { kind: 'framed'; codec: AudioCodec; framer: Framer; aacFromAdts?: boolean }
  /** One packet per non-empty chunk (raw AAC with an AudioSpecificConfig in `strf`). */
  | { kind: 'chunks'; codec: 'aac'; description: Uint8Array; samplesPerChunk: number }
  | { kind: 'unsupported' };

const PCM_INT: Partial<Record<number, AudioCodec>> = {
  8: 'pcm-u8',
  16: 'pcm-s16',
  24: 'pcm-s24',
  32: 'pcm-s32',
};
const PCM_FLOAT: Partial<Record<number, AudioCodec>> = { 32: 'pcm-f32', 64: 'pcm-f64' };

/** How to read an audio stream, by `wFormatTag` (ADR 0007 codec map). */
export function audioLayout(wf: WaveFormat): AudioLayout {
  const blockAlign = wf.blockAlign || (wf.channels * wf.bitsPerSample) / 8;
  switch (wf.formatTag) {
    case 0x55:
      return { kind: 'framed', codec: 'mp3', framer: mp3Framer };
    case 0x2000:
      return { kind: 'framed', codec: 'ac3', framer: ac3Framer };
    case 0x2001:
      return { kind: 'framed', codec: 'dts', framer: dtsFramer };
    case 0x01:
    case 0x03:
    case 0x06:
    case 0x07: {
      const codec =
        wf.formatTag === 0x06
          ? 'alaw'
          : wf.formatTag === 0x07
            ? 'ulaw'
            : (wf.formatTag === 0x03 ? PCM_FLOAT : PCM_INT)[wf.bitsPerSample];
      if (!codec || !blockAlign) return { kind: 'unsupported' };
      return { kind: 'framed', codec, framer: pcmFramer(blockAlign) };
    }
    case 0xff:
    case 0x1600:
    case 0x1610:
    case 0x706d:
      if (wf.extra.length >= 2) {
        return { kind: 'chunks', codec: 'aac', description: wf.extra, samplesPerChunk: 1024 };
      }
      return { kind: 'framed', codec: 'aac', framer: adtsFramer, aacFromAdts: true };
    default:
      return { kind: 'unsupported' };
  }
}
