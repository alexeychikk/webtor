/**
 * Codec decisions for the MSE pipeline (docs/decisions/0003). Pure: the browser's
 * `MediaSource.isTypeSupported` is passed in, so these are unit-testable and never sniff the UA.
 */
import type { AudioTrackInfo } from './types';

export type IsTypeSupported = (mime: string) => boolean;

export const videoMime = (codecString: string) => `video/mp4; codecs="${codecString}"`;
export const audioMime = (codecString: string) => `audio/mp4; codecs="${codecString}"`;

export type VideoDecision =
  { ok: true; mime: string } | { ok: false; code: 'unsupported-video-codec'; detail: string };

/**
 * Video is never transcoded: it plays only if MSE accepts the copied stream in fragmented MP4.
 * This is what rejects HEVC and 10-bit H.264 on browsers without a decoder for them.
 */
export function decideVideo(
  codec: string | null,
  codecString: string | null,
  isTypeSupported: IsTypeSupported,
): VideoDecision {
  if (!codecString) {
    return { ok: false, code: 'unsupported-video-codec', detail: codec ?? 'unknown codec' };
  }
  const mime = videoMime(codecString);
  if (isTypeSupported(mime)) return { ok: true, mime };
  return { ok: false, code: 'unsupported-video-codec', detail: codecString };
}

/** Output of an audio transcode: the first codec this browser can both encode and play in MP4. */
export interface TranscodeTarget {
  codec: 'opus' | 'aac';
  /** RFC 6381 string of the encoded output, for `SourceBuffer` MIME types. */
  codecString: 'opus' | 'mp4a.40.2';
  /** No native (WebCodecs) AAC encoder: load `@mediabunny/aac-encoder` (wasm). */
  wasmEncoder: boolean;
}

/**
 * Opus first (smaller, and Chromium/Firefox encode it natively), then native AAC (Safari), then AAC
 * from the wasm encoder. `null`: MSE plays neither in MP4, so nothing can be transcoded.
 */
export function pickTranscodeTarget(
  can: { encodeOpus: boolean; encodeAac: boolean },
  isTypeSupported: IsTypeSupported,
): TranscodeTarget | null {
  if (can.encodeOpus && isTypeSupported(audioMime('opus'))) {
    return { codec: 'opus', codecString: 'opus', wasmEncoder: false };
  }
  if (!isTypeSupported(audioMime('mp4a.40.2'))) return null;
  return { codec: 'aac', codecString: 'mp4a.40.2', wasmEncoder: !can.encodeAac };
}

/** Decoders we lazy-load as wasm extensions: `@mediabunny/ac3` (AC-3, E-AC-3), `@mediabunny/dts`. */
export type WasmDecoder = 'ac3' | 'dts';

const WASM_DECODERS: Partial<Record<string, WasmDecoder>> = { ac3: 'ac3', eac3: 'ac3', dts: 'dts' };

export type AudioDecision =
  | { playback: 'copy'; mime: string; outputCodec: string }
  | {
      playback: 'transcode';
      mime: string;
      outputCodec: TranscodeTarget['codec'];
      /** Extension to load first; `null` when WebCodecs decodes the source (e.g. Vorbis, PCM). */
      decoder: WasmDecoder | null;
      target: TranscodeTarget;
    }
  | { playback: 'unsupported'; reason: string };

export interface AudioSource {
  /** Mediabunny codec name (`aac`, `ac3`, …); `null` when Mediabunny doesn't know it (e.g. TrueHD). */
  codec: string | null;
  codecString: string | null;
  /** WebCodecs (or an already registered decoder) can decode it: `InputAudioTrack.canDecode()`. */
  decodable: boolean;
}

/**
 * Copy when MSE accepts the stream in MP4; else decode (wasm for AC-3/E-AC-3/DTS, WebCodecs for the
 * rest) and re-encode to stereo `target`; else unsupported, with a reason for the track list.
 */
export function decideAudio(
  track: AudioSource,
  isTypeSupported: IsTypeSupported,
  target: TranscodeTarget | null,
): AudioDecision {
  if (track.codecString && isTypeSupported(audioMime(track.codecString))) {
    return {
      playback: 'copy',
      mime: audioMime(track.codecString),
      outputCodec: track.codec ?? track.codecString,
    };
  }
  if (!track.codec) return { playback: 'unsupported', reason: 'codec not supported' };
  const decoder = WASM_DECODERS[track.codec] ?? null;
  if (!decoder && !track.decodable) {
    return {
      playback: 'unsupported',
      reason: `this browser can't decode ${codecLabel(track.codec)}`,
    };
  }
  if (!target) {
    return { playback: 'unsupported', reason: "this browser can't convert audio" };
  }
  return {
    playback: 'transcode',
    mime: audioMime(target.codecString),
    outputCodec: target.codec,
    decoder,
    target,
  };
}

/** Encoder settings for a transcode (docs/decisions/0003): stereo, 48 kHz, 128 kbit/s. */
export const TRANSCODE_AUDIO = {
  numberOfChannels: 2,
  sampleRate: 48_000,
  bitrate: 128_000,
} as const;

const CODEC_LABELS: Record<string, string> = {
  aac: 'AAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  dts: 'DTS',
};

/** Display name of a Mediabunny codec, e.g. `eac3` → `E-AC-3`, `pcm-s16` → `PCM`. */
export function codecLabel(codec: string | null): string {
  if (!codec) return 'unknown codec';
  if (/^(pcm-|ulaw|alaw)/.test(codec)) return 'PCM';
  return CODEC_LABELS[codec] ?? codec;
}

/** `2` → `stereo`, `6` → `5.1`, … */
export function channelsLabel(channels: number): string {
  const known: Record<number, string> = { 1: 'mono', 2: 'stereo', 3: '2.1', 6: '5.1', 8: '7.1' };
  return known[channels] ?? (channels > 0 ? `${channels} ch` : '');
}

/**
 * The audio track to start with: a playable track in the user's last chosen language, else the
 * default-flagged playable track, else the first playable one. `null` means nothing is playable and
 * the video plays muted.
 */
export function pickAudioTrack(
  tracks: readonly AudioTrackInfo[],
  preferredLanguage?: string | null,
): AudioTrackInfo | null {
  const playable = tracks.filter((t) => t.playback !== 'unsupported');
  const inLanguage = preferredLanguage
    ? playable.filter((t) => t.language === preferredLanguage)
    : [];
  return (
    inLanguage.find((t) => t.isDefault) ??
    inLanguage[0] ??
    playable.find((t) => t.isDefault) ??
    playable[0] ??
    null
  );
}
