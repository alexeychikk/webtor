import { describe, expect, it } from 'vitest';
import { outsideRect } from './page-dialog';

describe('outsideRect', () => {
  const r = { left: 10, top: 20, right: 110, bottom: 220 } as DOMRectReadOnly;

  it('is false inside the box, edges included on the top/left', () => {
    expect(outsideRect(r, 10, 20)).toBe(false);
    expect(outsideRect(r, 60, 100)).toBe(false);
  });

  it('is true on every side outside it', () => {
    expect(outsideRect(r, 9, 100)).toBe(true);
    expect(outsideRect(r, 110, 100)).toBe(true);
    expect(outsideRect(r, 60, 19)).toBe(true);
    expect(outsideRect(r, 60, 220)).toBe(true);
  });
});
