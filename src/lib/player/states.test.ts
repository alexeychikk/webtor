import { describe, expect, it } from 'vitest';
import { PLAYBACK_ERROR_MESSAGES, PLAYBACK_ERROR_TITLES, type PlaybackErrorCode } from './errors';
import { errorActions, playerStates } from './states';

const base = {
  phase: 'playing' as const,
  error: null,
  notices: [] as PlaybackErrorCode[],
  subtitleNotice: null,
  dismissed: new Set<PlaybackErrorCode>(),
};

describe('PLAYBACK_ERROR_TITLES', () => {
  it('has a short title for every code', () => {
    const codes = Object.keys(PLAYBACK_ERROR_MESSAGES) as PlaybackErrorCode[];
    for (const code of codes) {
      expect(PLAYBACK_ERROR_TITLES[code], code).toBeTruthy();
      expect(PLAYBACK_ERROR_TITLES[code].length, code).toBeLessThanOrEqual(32);
    }
    expect(Object.keys(PLAYBACK_ERROR_TITLES).sort()).toEqual(codes.sort());
  });
});

describe('playerStates', () => {
  it('shows nothing while idle', () => {
    expect(playerStates({ ...base, phase: 'idle', notices: ['no-peers'] })).toEqual({
      card: null,
      toasts: [],
    });
  });

  it('shows a fatal error as the only card, without toasts', () => {
    expect(
      playerStates({
        ...base,
        phase: 'error',
        error: 'torrent-failed',
        notices: ['stalled'],
        subtitleNotice: { code: 'subtitle-failed', detail: 'x.srt' },
      }),
    ).toEqual({ card: { code: 'torrent-failed', kind: 'error' }, toasts: [] });
  });

  it('turns no-peers into a searching card and the rest into toasts', () => {
    expect(
      playerStates({
        ...base,
        phase: 'connecting',
        notices: ['no-webrtc', 'no-peers'],
      }),
    ).toEqual({ card: { code: 'no-peers', kind: 'searching' }, toasts: [{ code: 'no-webrtc' }] });
  });

  it('adds the subtitle notice with its detail and drops dismissed codes', () => {
    const subtitleNotice = { code: 'subtitle-failed' as const, detail: 'x.srt' };
    expect(
      playerStates({ ...base, notices: ['stalled', 'no-playable-audio'], subtitleNotice }).toasts,
    ).toEqual([{ code: 'stalled' }, { code: 'no-playable-audio' }, subtitleNotice]);
    expect(
      playerStates({
        ...base,
        notices: ['stalled', 'no-playable-audio'],
        subtitleNotice,
        dismissed: new Set<PlaybackErrorCode>(['stalled', 'subtitle-failed']),
      }).toasts,
    ).toEqual([{ code: 'no-playable-audio' }]);
  });
});

describe('errorActions', () => {
  it('retries everything but a non-torrent', () => {
    expect(errorActions('invalid-input').retry).toBe(false);
    expect(errorActions('torrent-failed')).toEqual({ retry: true, relay: null });
  });

  it('leads relay errors to the settings and old video formats to the setup', () => {
    expect(errorActions('relay-unreachable').relay).toBe('settings');
    expect(errorActions('relay-transcode-failed').relay).toBe('settings');
    expect(errorActions('video-needs-relay').relay).toBe('setup');
  });
});
