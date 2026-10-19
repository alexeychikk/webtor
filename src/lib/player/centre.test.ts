import { describe, expect, it } from 'vitest';
import { centreState } from './centre';

const base = {
  phase: 'playing' as const,
  paused: false,
  ended: false,
  bufferingLong: false,
  touch: false,
  shown: false,
};

describe('centreState', () => {
  it('shows a spinner with a caption while connecting and opening the file', () => {
    expect(centreState({ ...base, phase: 'connecting', paused: true })).toBe('loading');
    expect(centreState({ ...base, phase: 'metadata', paused: true, touch: true })).toBe('loading');
  });

  it('shows the buffering spinner only after the delay', () => {
    expect(centreState({ ...base, phase: 'buffering' })).toBe('none');
    expect(centreState({ ...base, phase: 'buffering', bufferingLong: true })).toBe('buffering');
    // A paused file that is still loading doesn't offer play yet.
    expect(centreState({ ...base, phase: 'buffering', paused: true })).toBe('none');
  });

  it('shows the play circle while paused, Replay once ended, nothing while playing', () => {
    expect(centreState(base)).toBe('none');
    expect(centreState({ ...base, phase: 'paused', paused: true })).toBe('play');
    expect(centreState({ ...base, phase: 'paused', paused: true, ended: true })).toBe('replay');
  });

  it('on touch, shows the play/pause row with the controls only', () => {
    expect(centreState({ ...base, touch: true })).toBe('none');
    expect(centreState({ ...base, touch: true, shown: true })).toBe('pause');
    expect(centreState({ ...base, phase: 'paused', paused: true, touch: true, shown: true })).toBe(
      'play',
    );
  });

  it('shows nothing when idle or failed', () => {
    expect(centreState({ ...base, phase: 'idle', paused: true })).toBe('none');
    expect(centreState({ ...base, phase: 'error', paused: true, shown: true })).toBe('none');
  });
});
