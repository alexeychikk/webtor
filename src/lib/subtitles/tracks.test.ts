import { describe, expect, it } from 'vitest';
import type { SubtitleTrackInfo } from '../player/types';
import {
  defaultSubtitleKey,
  groupSubtitleTracks,
  nextSubtitleKey,
  subtitleTrackText,
} from './tracks';

const track = (key: string, extra: Partial<SubtitleTrackInfo> = {}): SubtitleTrackInfo => ({
  key,
  kind: key.split(':')[0] as SubtitleTrackInfo['kind'],
  renderer: 'text',
  language: '',
  label: key,
  ...extra,
});

describe('defaultSubtitleKey', () => {
  const sidecarEn = track('sidecar:1', { language: 'en' });
  const embeddedRu = track('embedded:2', { language: 'ru', isDefault: true });
  const embeddedForced = track('embedded:3', { language: 'en', forced: true });

  it('is Off without flags or a preference', () => {
    expect(defaultSubtitleKey([sidecarEn], null)).toBeNull();
    expect(defaultSubtitleKey([], 'en')).toBeNull();
  });
  it('follows the last chosen language first', () => {
    expect(defaultSubtitleKey([embeddedRu, sidecarEn], 'en')).toBe('sidecar:1');
    expect(defaultSubtitleKey([sidecarEn, embeddedForced], 'en')).toBe('sidecar:1');
  });
  it('then an embedded forced track, then an embedded default one', () => {
    expect(defaultSubtitleKey([embeddedRu, embeddedForced], null)).toBe('embedded:3');
    expect(defaultSubtitleKey([sidecarEn, embeddedRu], 'fr')).toBe('embedded:2');
  });
  it('honours a last choice of Off for default-flagged, not for forced tracks', () => {
    expect(defaultSubtitleKey([embeddedRu], 'off')).toBeNull();
    expect(defaultSubtitleKey([embeddedRu, embeddedForced], 'off')).toBe('embedded:3');
  });
  it('never picks unsupported tracks', () => {
    const pgs = track('embedded:4', { language: 'en', isDefault: true, unsupported: true });
    expect(defaultSubtitleKey([pgs], 'en')).toBeNull();
  });
  it('ignores flags on non-embedded tracks', () => {
    expect(defaultSubtitleKey([track('sidecar:5', { forced: true })], null)).toBeNull();
  });
});

describe('groupSubtitleTracks', () => {
  it('orders Embedded, In torrent, Uploaded and leaves out empty groups', () => {
    const groups = groupSubtitleTracks([track('upload:1'), track('sidecar:2'), track('sidecar:3')]);
    expect(groups.map((g) => [g.label, g.tracks.map((t) => t.key)])).toEqual([
      ['In torrent', ['sidecar:2', 'sidecar:3']],
      ['Uploaded', ['upload:1']],
    ]);
  });
});

describe('subtitleTrackText', () => {
  it('shows language and label', () => {
    expect(subtitleTrackText(track('sidecar:1', { language: 'en', label: 'a.en.srt' }))).toBe(
      'English · a.en.srt',
    );
    expect(subtitleTrackText(track('sidecar:1', { label: 'a.srt', forced: true }))).toBe(
      'a.srt (forced)',
    );
    expect(subtitleTrackText(track('embedded:1', { label: '' }))).toBe('Untitled');
  });
});

describe('nextSubtitleKey', () => {
  // Out of display order on purpose: the selector shows embedded, then in-torrent, then uploads.
  const tracks = [
    track('upload:1'),
    track('sidecar:4'),
    track('embedded:2', { unsupported: true }),
    track('embedded:3'),
  ];

  it('cycles in selector order through Off, skipping unsupported tracks', () => {
    expect(nextSubtitleKey(tracks, null)).toBe('embedded:3');
    expect(nextSubtitleKey(tracks, 'embedded:3')).toBe('sidecar:4');
    expect(nextSubtitleKey(tracks, 'sidecar:4')).toBe('upload:1');
    expect(nextSubtitleKey(tracks, 'upload:1')).toBeNull();
  });
  it('is Off without tracks and starts over from an unknown key', () => {
    expect(nextSubtitleKey([], null)).toBeNull();
    expect(nextSubtitleKey(tracks, 'sidecar:99')).toBe('embedded:3');
  });
});
