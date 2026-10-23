/**
 * Silent AAC-LC frames, for the silence after an audio track that ends before the video
 * (`MsePlayer.fillSilence`). Muxed under the track's own decoder config (AudioSpecificConfig), the
 * SourceBuffer gets the same init segment as before: no `changeType`, and WebKit (GStreamer) sees
 * no caps change, which hangs a paused seek into the silence there.
 *
 * Raw frames (no ADTS header) as ffmpeg's AAC encoder writes digital silence: `max_sfb` 0, so the
 * same bytes fit every sample rate. Keyed by the ASC's channel configuration (1–7).
 */
const SILENT_AAC_FRAMES: Record<number, string> = {
  1: '01182007',
  2: '211004608c1c',
  3: '011820010880230460e0',
  4: '01182001088023046003182007',
  5: '011820010880230460231004608c1c',
  6: '011820010880230460231004608c0c230000e0',
  7: '011820010880230460231004608c04a2008c11818460001c',
};

/** Samples per AAC-LC frame. */
export const AAC_FRAME_SAMPLES = 1024;

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * The silent frame for an AAC track with AudioSpecificConfig `asc`, or null when it isn't plain
 * AAC-LC (object type 2, no SBR/PS signalled up front) with a standard channel configuration.
 */
export function silentAacFrame(asc: Uint8Array | null | undefined): Uint8Array | null {
  if (!asc || asc.length < 2) return null;
  const bits = (asc[0]! << 24) | (asc[1]! << 16) | ((asc[2] ?? 0) << 8) | (asc[3] ?? 0);
  const objectType = bits >>> 27;
  if (objectType !== 2) return null;
  const freqIndex = (bits >>> 23) & 0xf;
  // An explicit sampling frequency (index 15) takes 24 bits before the channel configuration.
  if (freqIndex === 15) return null;
  const channelConfig = (bits >>> 19) & 0xf;
  const hex = SILENT_AAC_FRAMES[channelConfig];
  return hex ? hexBytes(hex) : null;
}
