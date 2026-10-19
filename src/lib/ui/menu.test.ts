import { describe, expect, it } from 'vitest';
import { MENU_PANEL_MIN_SCREEN_HEIGHT, menuKeyTarget, menuPresentation, panelRight } from './menu';

describe('menuPresentation', () => {
  it('is a panel in fullscreen, whatever the height', () => {
    expect(menuPresentation({ screenHeight: 200, fullscreen: true })).toBe('panel');
  });
  it('is a panel on a screen at least 352 px tall', () => {
    expect(
      menuPresentation({ screenHeight: MENU_PANEL_MIN_SCREEN_HEIGHT, fullscreen: false }),
    ).toBe('panel');
    expect(menuPresentation({ screenHeight: 720, fullscreen: false })).toBe('panel');
  });
  it('is a sheet on a short windowed screen (phone portrait)', () => {
    expect(menuPresentation({ screenHeight: 351, fullscreen: false })).toBe('sheet');
    expect(menuPresentation({ screenHeight: 202, fullscreen: false })).toBe('sheet');
  });
});

describe('panelRight', () => {
  it('right-aligns the panel with its trigger', () => {
    expect(panelRight(900, 320, 1000)).toBe(100);
  });
  it('keeps the margin at the right edge', () => {
    expect(panelRight(996, 320, 1000)).toBe(8);
  });
  it('keeps the panel inside on the left', () => {
    // Trigger at 200 px: right-aligned the panel would start at −120 px.
    expect(panelRight(200, 320, 1000)).toBe(672);
  });
  it('falls back to the margin when the panel is wider than the screen', () => {
    expect(panelRight(300, 400, 380)).toBe(8);
  });
});

describe('menuKeyTarget', () => {
  it('moves down and up, stopping at the ends', () => {
    expect(menuKeyTarget('ArrowDown', 0, 3)).toBe(1);
    expect(menuKeyTarget('ArrowDown', 2, 3)).toBe(2);
    expect(menuKeyTarget('ArrowUp', 1, 3)).toBe(0);
    expect(menuKeyTarget('ArrowUp', 0, 3)).toBe(0);
  });
  it('starts at the first (↓) or last (↑) item when none is focused', () => {
    expect(menuKeyTarget('ArrowDown', -1, 3)).toBe(0);
    expect(menuKeyTarget('ArrowUp', -1, 3)).toBe(2);
  });
  it('jumps with Home and End', () => {
    expect(menuKeyTarget('Home', 2, 3)).toBe(0);
    expect(menuKeyTarget('End', 0, 3)).toBe(2);
  });
  it('ignores other keys and empty lists', () => {
    expect(menuKeyTarget('Enter', 0, 3)).toBeNull();
    expect(menuKeyTarget('ArrowDown', -1, 0)).toBeNull();
  });
});
