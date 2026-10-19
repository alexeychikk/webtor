import { describe, expect, it } from 'vitest';
import { seekTarget, shortcutFor } from './shortcuts';

describe('shortcutFor', () => {
  it('maps the player keys', () => {
    expect(shortcutFor({ key: ' ' })).toEqual({ type: 'toggle-play' });
    expect(shortcutFor({ key: 'ArrowLeft' })).toEqual({ type: 'seek', by: -5 });
    expect(shortcutFor({ key: 'ArrowRight' })).toEqual({ type: 'seek', by: 5 });
    expect(shortcutFor({ key: 'f' })).toEqual({ type: 'fullscreen' });
    expect(shortcutFor({ key: 'F' })).toEqual({ type: 'fullscreen' });
    expect(shortcutFor({ key: 'm' })).toEqual({ type: 'mute' });
    expect(shortcutFor({ key: 'c' })).toEqual({ type: 'cycle-subtitles' });
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

  it('works on the player control bar, except the keys its buttons and sliders use', () => {
    const bar = { inPlayerControls: true };
    expect(shortcutFor({ key: 'f', targetTag: 'BUTTON', ...bar })).toEqual({ type: 'fullscreen' });
    expect(shortcutFor({ key: 'm', targetTag: 'INPUT', ...bar })).toEqual({ type: 'mute' });
    expect(shortcutFor({ key: ' ', targetTag: 'INPUT', ...bar })).toEqual({ type: 'toggle-play' });
    expect(shortcutFor({ key: 'ArrowRight', targetTag: 'BUTTON', ...bar })).toEqual({
      type: 'seek',
      by: 5,
    });
    expect(shortcutFor({ key: ' ', targetTag: 'BUTTON', ...bar })).toBeNull();
    expect(shortcutFor({ key: 'ArrowLeft', targetTag: 'INPUT', ...bar })).toBeNull();
    expect(shortcutFor({ key: 'f', ctrlKey: true, ...bar })).toBeNull();
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
