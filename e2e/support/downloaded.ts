import { expect, type Page } from '@playwright/test';

/** Seconds the layer may start after the playhead: a 1 s tick reads the playhead later. */
export const TOLERANCE_S = 0.5;

export interface Layer {
  /** Playhead, s. */
  at: number;
  /** The seek bar's downloaded ranges in s, in drawing order. */
  ranges: [number, number][];
}

/** The playhead and the seek bar's downloaded layer (ADR 0012 "Seek bar"), read together. */
export function layer(page: Page): Promise<Layer> {
  return page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('[data-testid="video"]')!;
    const duration = v.duration;
    const children = document.querySelectorAll<HTMLElement>('[data-testid="seek-downloaded"] > *');
    return {
      at: v.currentTime,
      ranges: [...children].map(
        (c) =>
          [Number(c.dataset.start) * duration, Number(c.dataset.end) * duration] as [
            number,
            number,
          ],
      ),
    };
  });
}

/** Some range starts at or before the playhead and runs past it. */
export const covers = ({ at, ranges }: Layer) =>
  ranges.some(([s, e]) => s <= at + TOLERANCE_S && e > at);

/** The layer covers the playhead (no gap) once the bytes there are held. */
export async function expectNoGap(page: Page, what: string) {
  await expect
    .poll(async () => covers(await layer(page)), { message: what, timeout: 15_000 })
    .toBe(true);
}

/** No drawn range overlaps `[from, to]` s: the window evicted those pieces. */
export async function expectEvicted(page: Page, from: number, to: number) {
  await expect
    .poll(async () => (await layer(page)).ranges.filter(([s, e]) => s < to && e > from), {
      message: `${from}–${to} s evicted`,
      timeout: 15_000,
    })
    .toEqual([]);
}

/** The layer with the held byte ranges of the file it was drawn from, at the same tick. */
export function heldLayer(page: Page): Promise<Layer & { held: { start: number; end: number }[] }> {
  return page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('[data-testid="video"]')!;
    const duration = v.duration;
    const children = document.querySelectorAll<HTMLElement>('[data-testid="seek-downloaded"] > *');
    return {
      at: v.currentTime,
      held: [...(window.__webtorHeldBytes ?? [])],
      ranges: [...children].map(
        (c) =>
          [Number(c.dataset.start) * duration, Number(c.dataset.end) * duration] as [
            number,
            number,
          ],
      ),
    };
  });
}
