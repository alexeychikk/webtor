import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

const video = (page: Page) => page.getByTestId('video');
const canvas = (page: Page) => page.getByTestId('ass-canvas');
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);

/** Pauses and seeks; JASSUB draws when the frame at the new position is shown. */
async function seekTo(page: Page, t: number) {
  await video(page).evaluate(
    (v: HTMLVideoElement, t) =>
      new Promise<void>((resolve) => {
        v.pause();
        v.addEventListener('seeked', () => resolve(), { once: true });
        v.currentTime = t;
      }),
    t,
  );
}

/** Non-transparent pixels on the overlay (its drawing comes from JASSUB's worker). */
const paintedPixels = (page: Page) =>
  canvas(page).evaluate((c: HTMLCanvasElement) => {
    const copy = document.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    if (!c.width || !c.height) return 0;
    const ctx = copy.getContext('2d')!;
    ctx.drawImage(c, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n++;
    return n;
  });

/** Text of the cues shown by native text tracks. */
const shownCues = (page: Page) =>
  video(page).evaluate((v: HTMLVideoElement) =>
    [...v.textTracks]
      .filter((t) => t.mode === 'showing')
      .flatMap((t) => [...(t.activeCues ?? [])].map((c) => (c as VTTCue).text)),
  );

async function playSample(page: Page) {
  const magnet = await fixtureMagnet('sample.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.3);
}

test('the Russian ASS track is drawn by JASSUB on the overlay canvas at 2–4 s, not as text', async ({
  page,
}) => {
  await playSample(page);
  await expect(canvas(page)).toHaveCount(0); // Nothing loaded before an ASS track is picked.
  await page.getByTestId('subtitles').selectOption({ label: 'Russian · ASS' });
  await expect(canvas(page)).toBeVisible({ timeout: 20_000 });
  await seekTo(page, 3);
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(100);
  expect(await shownCues(page)).toEqual([]);

  // No event at 5 s: the canvas is cleared.
  await seekTo(page, 5);
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBe(0);

  // Another track removes the overlay.
  await page.getByTestId('subtitles').selectOption({ label: 'English · SRT' });
  await expect(canvas(page)).toHaveCount(0);
  await expect(page.getByTestId('error')).toHaveCount(0);
  await expect(page.locator('[data-testid="notice"][data-code="subtitle-failed"]')).toHaveCount(0);
});

test('our fullscreen button fullscreens the player container, and the overlay stays drawn', async ({
  page,
}) => {
  await playSample(page);
  await page.getByTestId('subtitles').selectOption({ label: 'Russian · ASS' });
  await expect(canvas(page)).toBeVisible({ timeout: 20_000 });
  await seekTo(page, 3);
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(100);

  // The native control would fullscreen the bare video (hiding the canvas): ours replaces it.
  await expect(video(page)).toHaveAttribute('controlslist', 'nofullscreen');
  await page.getByTestId('screen').hover();
  await page.getByTestId('fullscreen').click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid')))
    .toBe('screen');
  await expect(page.getByTestId('fullscreen')).toHaveAttribute('aria-pressed', 'true');
  // The canvas sits inside the fullscreen element, over the (now larger) video.
  expect(await canvas(page).evaluate((c) => document.fullscreenElement?.contains(c) ?? false)).toBe(
    true,
  );
  await expect(canvas(page)).toBeVisible();
  await expect
    .poll(async () => {
      const [v, c] = await Promise.all([video(page), canvas(page)].map((l) => l.boundingBox()));
      return !!v && !!c && c.width >= v.width / 2 && c.width <= v.width + 1;
    })
    .toBe(true);
  await seekTo(page, 3.2);
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(100);
  expect(await shownCues(page)).toEqual([]);

  await page.getByTestId('fullscreen').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(canvas(page)).toBeVisible();
});
