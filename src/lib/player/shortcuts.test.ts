import { describe, expect, it } from 'vitest';
import { repeats, seekTarget, shortcutFor, volumeTarget } from './shortcuts';

describe('shortcutFor', () => {
  it('maps the player keys', () => {
    expect(shortcutFor({ key: ' ' })).toEqual({ type: 'toggle-play' });
    expect(shortcutFor({ key: 'ArrowLeft' })).toEqual({ type: 'seek', by: -5 });
    expect(shortcutFor({ key: 'ArrowRight' })).toEqual({ type: 'seek', by: 5 });
    expect(shortcutFor({ key: 'f' })).toEqual({ type: 'fullscreen' });
    expect(shortcutFor({ key: 'F' })).toEqual({ type: 'fullscreen' });
    expect(shortcutFor({ key: 'm' })).toEqual({ type: 'mute' });
    expect(shortcutFor({ key: 'c' })).toEqual({ type: 'cycle-subtitles' });
    expect(shortcutFor({ key: 'ArrowUp' })).toEqual({ type: 'volume', by: 0.1 });
    expect(shortcutFor({ key: 'ArrowDown' })).toEqual({ type: 'volume', by: -0.1 });
    expect(shortcutFor({ key: 'x' })).toBeNull();
  });

  it('works when the video or the page has focus', () => {
    expect(shortcutFor({ key: 'm', targetTag: 'VIDEO' })).toEqual({ type: 'mute' });
    expect(shortcutFor({ key: ' ', targetTag: 'BODY' })).toEqual({ type: 'toggle-play' });
  });

  it('leaves typing, form controls and browser shortcuts alone', () => {
    expect(shortcutFor({ key: 'f', targetTag: 'INPUT' })).toBeNull();
    expect(shortcutFor({ key: 'ArrowRight', targetTag: 'select' })).toBeNull();
    expect(shortcutFor({ key: ' ', targetTag: 'BUTTON' })).toBeNull();
    expect(shortcutFor({ key: 'c', targetEditable: true })).toBeNull();
    expect(shortcutFor({ key: 'f', ctrlKey: true })).toBeNull();
    expect(shortcutFor({ key: 'ArrowLeft', metaKey: true })).toBeNull();
    expect(shortcutFor({ key: 'm', altKey: true })).toBeNull();
  });

  it('works on the player control bar, except the arrows of its sliders', () => {
    const bar = { inPlayerControls: true };
    expect(shortcutFor({ key: 'f', targetTag: 'BUTTON', ...bar })).toEqual({ type: 'fullscreen' });
    expect(shortcutFor({ key: 'm', targetTag: 'INPUT', ...bar })).toEqual({ type: 'mute' });
    expect(shortcutFor({ key: ' ', targetTag: 'INPUT', ...bar })).toEqual({ type: 'toggle-play' });
    expect(shortcutFor({ key: 'ArrowRight', targetTag: 'BUTTON', ...bar })).toEqual({
      type: 'seek',
      by: 5,
    });
    expect(shortcutFor({ key: ' ', targetTag: 'BUTTON', ...bar })).toEqual({ type: 'toggle-play' });
    expect(shortcutFor({ key: 'ArrowLeft', targetTag: 'INPUT', ...bar })).toBeNull();
    expect(shortcutFor({ key: 'ArrowUp', targetTag: 'INPUT', ...bar })).toBeNull();
    expect(shortcutFor({ key: 'ArrowUp', targetTag: 'BUTTON', ...bar })).toEqual({
      type: 'volume',
      by: 0.1,
    });
    expect(shortcutFor({ key: 'f', ctrlKey: true, ...bar })).toBeNull();
  });
});

describe('repeats', () => {
  it('lets a held arrow keep seeking, but never re-toggles', () => {
    expect(repeats({ type: 'seek', by: 5 })).toBe(true);
    expect(repeats({ type: 'volume', by: 0.1 })).toBe(true);
    expect(repeats({ type: 'toggle-play' })).toBe(false);
    expect(repeats({ type: 'fullscreen' })).toBe(false);
    expect(repeats({ type: 'mute' })).toBe(false);
    expect(repeats({ type: 'cycle-subtitles' })).toBe(false);
  });
});

describe('seekTarget', () => {
  it('clamps to the media', () => {
    expect(seekTarget(10, 5, 60)).toBe(15);
    expect(seekTarget(2, -5, 60)).toBe(0);
    expect(seekTarget(58, 5, 60)).toBe(60);
    expect(seekTarget(58, 5, NaN)).toBe(63);
    expect(seekTarget(58, 5, Infinity)).toBe(63);
  });
});

describe('volumeTarget', () => {
  it('steps and clamps to [0, 1] without float noise', () => {
    expect(volumeTarget(0.2, 0.1)).toBe(0.3);
    expect(volumeTarget(0.95, 0.1)).toBe(1);
    expect(volumeTarget(0.05, -0.1)).toBe(0);
    expect(volumeTarget(0.7, -0.1)).toBe(0.6);
  });
});
