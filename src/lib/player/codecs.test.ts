import { describe, expect, it } from 'vitest';
import {
  channelsLabel,
  codecLabel,
  decideAudio,
  decideVideo,
  pickAudioTrack,
  pickLoadableAudioTrack,
  pickTranscodeTarget,
  type TranscodeTarget,
} from './codecs';
import type { AudioTrackInfo } from './types';
import { matchAudioTrack } from './watch-state';

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

const safari = (mime: string) => chromiumLinux(mime) || /codecs="(ac-3|ec-3|hvc1\..*)"/.test(mime);
const opus: TranscodeTarget = { codec: 'opus', codecString: 'opus', wasmEncoder: false };
const aacWasm: TranscodeTarget = { codec: 'aac', codecString: 'mp4a.40.2', wasmEncoder: true };

describe('pickTranscodeTarget', () => {
  it('prefers Opus when the browser encodes it and MSE plays it', () => {
    expect(pickTranscodeTarget({ encodeOpus: true, encodeAac: true }, chromiumLinux)).toEqual(opus);
  });
  it('falls back to native AAC (Safari without an Opus encoder)', () => {
    expect(pickTranscodeTarget({ encodeOpus: false, encodeAac: true }, safari)).toEqual({
      codec: 'aac',
      codecString: 'mp4a.40.2',
      wasmEncoder: false,
    });
  });
  it('uses the wasm AAC encoder when nothing encodes natively', () => {
    expect(pickTranscodeTarget({ encodeOpus: false, encodeAac: false }, chromiumLinux)).toEqual(
      aacWasm,
    );
  });
  it('skips Opus when MSE does not play Opus in MP4', () => {
    const noOpus = (m: string) => chromiumLinux(m) && !m.includes('opus');
    expect(pickTranscodeTarget({ encodeOpus: true, encodeAac: false }, noOpus)).toEqual(aacWasm);
  });
  it('returns null when MSE plays neither Opus nor AAC', () => {
    expect(pickTranscodeTarget({ encodeOpus: true, encodeAac: true }, () => false)).toBeNull();
  });
});

describe('decideAudio', () => {
  const src = (codec: string | null, codecString: string | null, decodable = false) => ({
    codec,
    codecString,
    decodable,
  });

  it.each([
    ['aac', 'mp4a.40.2'],
    ['opus', 'opus'],
    ['mp3', 'mp3'],
    ['flac', 'flac'],
  ])('copies %s that MSE accepts', (codec, codecString) => {
    expect(decideAudio(src(codec, codecString, true), chromiumLinux, opus)).toEqual({
      playback: 'copy',
      mime: `audio/mp4; codecs="${codecString}"`,
      outputCodec: codec,
    });
  });

  it('copies MP3 as mp4a.6b where MSE takes it, before any other path', () => {
    const with6b = (mime: string) => mime === 'audio/mp4; codecs="mp4a.6b"';
    expect(decideAudio(src('mp3', 'mp3', true), with6b, opus)).toEqual({
      playback: 'copy',
      mime: 'audio/mp4; codecs="mp4a.6b"',
      outputCodec: 'mp3',
    });
    const noMp3 = (mime: string) => chromiumLinux(mime) && !mime.includes('mp3');
    expect(decideAudio(src('mp3', 'mp3', true), noMp3, opus).playback).toBe('transcode');
  });

  it.each([
    ['ac3', 'ac-3', 'ac3'],
    ['eac3', 'ec-3', 'ac3'],
    ['dts', 'dts', 'dts'],
  ])('transcodes %s with the wasm decoder', (codec, codecString, decoder) => {
    expect(decideAudio(src(codec, codecString), chromiumLinux, opus)).toEqual({
      playback: 'transcode',
      mime: 'audio/mp4; codecs="opus"',
      outputCodec: 'opus',
      decoder,
      target: opus,
    });
  });

  it('copies AC-3 / E-AC-3 where MSE plays them (Safari)', () => {
    expect(decideAudio(src('ac3', 'ac-3'), safari, opus).playback).toBe('copy');
    expect(decideAudio(src('eac3', 'ec-3'), safari, opus).playback).toBe('copy');
  });

  it('transcodes to AAC when that is the target', () => {
    const d = decideAudio(src('dts', 'dts'), chromiumLinux, aacWasm);
    expect(d).toMatchObject({ playback: 'transcode', mime: 'audio/mp4; codecs="mp4a.40.2"' });
  });

  it('transcodes what WebCodecs decodes but MSE refuses in MP4 (Vorbis, PCM)', () => {
    expect(decideAudio(src('vorbis', 'vorbis', true), chromiumLinux, opus)).toMatchObject({
      playback: 'transcode',
      decoder: null,
    });
    expect(decideAudio(src('pcm-s16', 'pcm-s16', true), chromiumLinux, opus).playback).toBe(
      'transcode',
    );
  });

  it('marks undecodable and unknown codecs unsupported, with a reason', () => {
    expect(decideAudio(src('vorbis', 'vorbis', false), chromiumLinux, opus)).toEqual({
      playback: 'unsupported',
      reason: "this browser can't decode Vorbis",
    });
    // TrueHD: Mediabunny has no codec for it.
    expect(decideAudio(src(null, null), chromiumLinux, opus)).toEqual({
      playback: 'unsupported',
      reason: 'codec not supported',
    });
  });

  it('cannot transcode without a target, but still copies', () => {
    expect(decideAudio(src('ac3', 'ac-3'), chromiumLinux, null)).toEqual({
      playback: 'unsupported',
      reason: "this browser can't convert audio",
    });
    expect(decideAudio(src('aac', 'mp4a.40.2'), chromiumLinux, null).playback).toBe('copy');
  });
});

describe('labels', () => {
  it('names codecs and channel layouts', () => {
    expect(codecLabel('eac3')).toBe('E-AC-3');
    expect(codecLabel('pcm-s24')).toBe('PCM');
    expect(codecLabel(null)).toBe('unknown codec');
    expect(channelsLabel(2)).toBe('stereo');
    expect(channelsLabel(6)).toBe('5.1');
    expect(channelsLabel(4)).toBe('4 ch');
  });
});

const track = (
  id: number,
  playback: AudioTrackInfo['playback'],
  { isDefault = false, language = 'und' } = {},
): AudioTrackInfo => ({
  id,
  codec: null,
  codecString: null,
  language,
  label: `t${id}`,
  channels: 2,
  isDefault,
  playback,
  outputCodec: playback === 'unsupported' ? null : 'aac',
});

describe('pickAudioTrack', () => {
  it('prefers the default-flagged playable track', () => {
    expect(pickAudioTrack([track(1, 'copy'), track(2, 'copy', { isDefault: true })])?.id).toBe(2);
  });
  it('skips an unplayable default track', () => {
    expect(
      pickAudioTrack([track(1, 'unsupported', { isDefault: true }), track(2, 'transcode')])?.id,
    ).toBe(2);
  });
  it('prefers the remembered language over the default flag, transcode or not', () => {
    const tracks = [
      track(1, 'copy', { isDefault: true, language: 'eng' }),
      track(2, 'transcode', { language: 'rus' }),
      track(3, 'copy', { language: 'rus', isDefault: false }),
    ];
    expect(pickAudioTrack(tracks, 'rus')?.id).toBe(2);
    expect(pickAudioTrack(tracks, 'fra')?.id).toBe(1);
    expect(pickAudioTrack(tracks, null)?.id).toBe(1);
  });
  it('ignores the remembered language when its track is unsupported', () => {
    const tracks = [
      track(1, 'unsupported', { language: 'rus' }),
      track(2, 'copy', { language: 'eng' }),
    ];
    expect(pickAudioTrack(tracks, 'rus')?.id).toBe(2);
  });
  it('returns null when nothing is playable (play muted)', () => {
    expect(pickAudioTrack([track(1, 'unsupported', { isDefault: true })])).toBeNull();
    expect(pickAudioTrack([])).toBeNull();
  });
});

describe('pickLoadableAudioTrack', () => {
  const tracks = [
    track(1, 'copy', { isDefault: true, language: 'eng' }),
    { ...track(2, 'transcode', { language: 'rus' }), codec: 'ac3' },
    { ...track(3, 'transcode', { language: 'rus' }), codec: 'eac3' },
  ];
  it('keeps the pick when its load succeeds', async () => {
    const r = await pickLoadableAudioTrack(tracks, 'rus', async () => {});
    expect(r.track?.id).toBe(2);
    expect(r.failed).toEqual([]);
    expect(r.tracks).toEqual(tracks);
  });
  it('marks tracks whose load fails unsupported and falls back to the next pick', async () => {
    const tried: number[] = [];
    const r = await pickLoadableAudioTrack(tracks, 'rus', async (t) => {
      tried.push(t.id);
      if (t.codec !== null) throw new Error('chunk 404');
    });
    expect(tried).toEqual([2, 3, 1]);
    expect(r.track?.id).toBe(1);
    expect(r.failed).toEqual([2, 3]);
    expect(r.tracks.map((t) => t.playback)).toEqual(['copy', 'unsupported', 'unsupported']);
    expect(r.tracks[1]).toMatchObject({
      outputCodec: null,
      reason: 'the AC-3 converter failed to load',
    });
  });
  it('prefers the restored track, and the language preference once it fails', async () => {
    const restore = (list: readonly AudioTrackInfo[]) =>
      matchAudioTrack(list, { id: 3, language: 'rus', label: 't3', codec: 'eac3' });
    const ok = await pickLoadableAudioTrack(tracks, 'eng', async () => {}, restore);
    expect(ok.track?.id).toBe(3);
    const r = await pickLoadableAudioTrack(
      tracks,
      'eng',
      async (t) => {
        if (t.id === 3) throw new Error('chunk 404');
      },
      restore,
    );
    expect(r.track?.id).toBe(1);
    expect(r.failed).toEqual([3]);
  });
  it('plays muted when every load fails', async () => {
    const r = await pickLoadableAudioTrack(tracks, null, () => Promise.reject(new Error('x')));
    expect(r.track).toBeNull();
    expect(r.failed).toEqual([1, 2, 3]);
    expect(r.tracks.every((t) => t.playback === 'unsupported')).toBe(true);
  });
});
