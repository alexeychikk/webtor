import { describe, expect, it } from 'vitest';
import { audioPlayback, decideVideo, pickAudioTrack } from './codecs';
import type { AudioTrackInfo } from './types';

// What desktop Chromium on Linux typically reports: H.264 8-bit, VP9, AV1, AAC, Opus; no HEVC, no AC-3.
const chromiumLinux = (mime: string) =>
  /codecs="(avc1\.(42|4d|64)....|vp09\..*|av01\..*|mp4a\.40\.2|opus|mp3|flac)"/.test(mime);
const withHevc = (mime: string) => chromiumLinux(mime) || /codecs="(hvc1|hev1)\./.test(mime);

describe('decideVideo', () => {
  it('copies H.264 8-bit', () => {
    expect(decideVideo('avc', 'avc1.64001f', chromiumLinux)).toEqual({
      ok: true,
      mime: 'video/mp4; codecs="avc1.64001f"',
    });
  });
  it('rejects HEVC unless the browser decodes it', () => {
    expect(decideVideo('hevc', 'hvc1.1.6.L93.B0', chromiumLinux)).toEqual({
      ok: false,
      code: 'unsupported-video-codec',
      detail: 'hvc1.1.6.L93.B0',
    });
    expect(decideVideo('hevc', 'hvc1.1.6.L93.B0', withHevc).ok).toBe(true);
  });
  it('rejects 10-bit H.264 (High 10, profile 0x6e) where unsupported', () => {
    expect(decideVideo('avc', 'avc1.6e0028', chromiumLinux).ok).toBe(false);
  });
  it('rejects a track without a codec string', () => {
    expect(decideVideo(null, null, () => true)).toEqual({
      ok: false,
      code: 'unsupported-video-codec',
      detail: 'unknown codec',
    });
  });
});

const track = (id: number, codecString: string | null, isDefault = false): AudioTrackInfo => ({
  id,
  codec: null,
  codecString,
  language: 'und',
  label: `t${id}`,
  channels: 2,
  isDefault,
  playback: audioPlayback(codecString, chromiumLinux),
});

describe('audioPlayback', () => {
  it('copies what MSE accepts in MP4 and refuses the rest', () => {
    expect(audioPlayback('mp4a.40.2', chromiumLinux)).toBe('copy');
    expect(audioPlayback('opus', chromiumLinux)).toBe('copy');
    expect(audioPlayback('ac-3', chromiumLinux)).toBe('unsupported');
    expect(audioPlayback(null, chromiumLinux)).toBe('unsupported');
  });
});

describe('pickAudioTrack', () => {
  it('prefers the default-flagged playable track', () => {
    expect(pickAudioTrack([track(1, 'mp4a.40.2'), track(2, 'opus', true)])?.id).toBe(2);
  });
  it('skips an unplayable default track', () => {
    expect(pickAudioTrack([track(1, 'ac-3', true), track(2, 'mp4a.40.2')])?.id).toBe(2);
  });
  it('returns null when nothing is playable (play muted)', () => {
    expect(pickAudioTrack([track(1, 'ac-3', true)])).toBeNull();
    expect(pickAudioTrack([])).toBeNull();
  });
});
