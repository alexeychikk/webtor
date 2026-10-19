/**
 * Video converted by the user's relay (ADR 0007 §2): the relay streams fragmented H.264 MP4 for a
 * file the browser can't decode, while audio and subtitles stay local. Pure decisions only; the
 * stream glue is in `mse-player.ts`, the fetch in `torrent/relay-client.ts`.
 */
import { bufferedAhead, type Ranges } from './buffer';

/** Where the relay's video comes from; `MsePlayer` never sees the relay URL (the token). */
export interface RemoteVideo {
  /**
   * Fragmented MP4 of the file's video from element time `start` on, its timestamps starting at 0.
   * Aborting `signal` ends the relay's job. Rejects with a `PlaybackError`.
   */
  open(start: number, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

/**
 * SourceBuffer type for the relay's output: H.264 High (ffmpeg `-profile:v high`, 8-bit 4:2:0).
 * Level 4.0 covers up to 1080p30; the init segment's avcC carries the real level.
 */
export const REMOTE_VIDEO_MIME = 'video/mp4; codecs="avc1.640028"';

/** A (re)started conversion needs this long for its first fragments before a drained buffer counts as slow. */
export const REMOTE_WARMUP_MS = 5_000;
/** Below this much video ahead of the playhead the element is starving. */
const STARVED_S = 0.5;

/**
 * `relay-transcode-slow`: the element waits for video while the relay's conversion runs (not after a
 * seek or restart, which take a second or two, and not at the end of the video).
 */
export function transcodeSlow(s: {
  videoBuffered: Ranges;
  currentTime: number;
  seeking: boolean;
  /** The relay's stream ended: nothing more is coming. */
  done: boolean;
  /** Since the current conversion was requested. */
  sinceStartMs: number;
}): boolean {
  if (s.seeking || s.done || s.sinceStartMs < REMOTE_WARMUP_MS) return false;
  return bufferedAhead(s.videoBuffered, s.currentTime) < STARVED_S;
}

/** Stream cuts in a row (no data in between) after which the conversion counts as failed. */
export const MAX_REMOTE_RESUMES = 3;

/**
 * Element time to resume a conversion at after its stream broke off (the relay ended an idle job,
 * a network blip): the end of the media buffered at the playhead, else the playhead itself.
 */
export function remoteResumePoint(videoBuffered: Ranges, currentTime: number): number {
  return currentTime + bufferedAhead(videoBuffered, currentTime);
}
