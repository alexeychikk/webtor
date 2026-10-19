import { describe, expect, it } from 'vitest';
import { audioOptionText, audioTrackDetail, audioTrackTitle } from './audio-options';
import type { AudioTrackInfo } from './types';

const track = (over: Partial<AudioTrackInfo>): AudioTrackInfo => ({
  id: 2,
  codec: 'aac',
  codecString: 'mp4a.40.2',
  language: 'eng',
  label: 'English AAC',
  channels: 1,
  isDefault: true,
  playback: 'copy',
  outputCodec: 'aac',
  ...over,
});

describe('audio menu option text', () => {
  it('names a copied track with its codec and channels', () => {
    const t = track({});
    expect(audioTrackTitle(t)).toBe('English AAC · eng');
    expect(audioTrackDetail(t)).toBe('AAC mono');
    expect(audioOptionText(t)).toBe('English AAC · eng · AAC mono');
  });

  it('shows the conversion of a transcoded track', () => {
    const t = track({ codec: 'ac3', label: 'Russian AC3', language: 'rus', channels: 6 });
    const converted = { ...t, playback: 'transcode' as const, outputCodec: 'opus' };
    expect(audioTrackDetail(converted)).toBe('AC-3 5.1 → Opus');
    expect(audioOptionText(converted)).toBe('Russian AC3 · rus · AC-3 5.1 → Opus');
  });

  it('gives the reason of an unavailable track', () => {
    const t = track({ playback: 'unsupported', outputCodec: null, reason: 'codec not supported' });
    expect(audioTrackDetail(t)).toBe('Unavailable: codec not supported');
    expect(audioOptionText(t)).toBe(
      'English AAC · eng · AAC mono — unavailable: codec not supported',
    );
  });

  it('leaves out an unknown language', () => {
    expect(audioTrackTitle(track({ language: 'und' }))).toBe('English AAC');
  });
});
