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

/**
 * Whether an audio track can be copied into MSE as is. Tracks MSE refuses are `unsupported` for now;
 * in-browser transcoding (AC-3, DTS, …) will turn some of them into `transcode`.
 */
export function audioPlayback(
  codecString: string | null,
  isTypeSupported: IsTypeSupported,
): AudioTrackInfo['playback'] {
  return codecString && isTypeSupported(audioMime(codecString)) ? 'copy' : 'unsupported';
}

/**
 * The audio track to start with: the default-flagged playable track, else the first playable one.
 * `null` means no track is playable and the video plays muted.
 */
export function pickAudioTrack(tracks: readonly AudioTrackInfo[]): AudioTrackInfo | null {
  const playable = tracks.filter((t) => t.playback !== 'unsupported');
  return playable.find((t) => t.isDefault) ?? playable[0] ?? null;
}
