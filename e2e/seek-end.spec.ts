import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

// A seek to exactly `duration` (or past the last frame) ends the video (mse-player.ts
// `seekNeedsRestart`). It used to restart the pipelines at the last keyframe, which WebKit's
// GStreamer backend refused with a fatal "Failed to push buffer" (the tail was appended by then).
// Runs on Chromium and WebKit (playwright.config.ts). e2e/fixtures/resume/movie.mkv: 40 s.

const video = (page: Page) => page.getByTestId('video');
const prop = <K extends keyof HTMLVideoElement>(page: Page, k: K) =>
  video(page).evaluate((v: HTMLVideoElement, k) => v[k], k) as Promise<HTMLVideoElement[K]>;

/**
 * Opens the 40 s movie and lets it play a little. The jump comes early: on WebKit the tail is not
 * appended yet, and the append that the seek wakes reaches the end within the seek debounce.
 */
async function open(page: Page) {
  const magnet = await fixtureMagnet('resume');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByTestId('status')).toContainText('movie.mkv');
  await expect.poll(() => prop(page, 'currentTime'), { timeout: 30_000 }).toBeGreaterThan(0.5);
}

/** Ended (or, paused a frame before the end, ends once played), with no error on the way. */
async function expectEnded(page: Page) {
  await expect.poll(() => prop(page, 'currentTime')).toBeGreaterThan(39.9);
  // Settled at the end: no restart failing late.
  await page.waitForTimeout(2000);
  await expect(page.getByTestId('error')).toHaveCount(0);
  // WebKit may stop at the header duration, a few ms before the last frame's end (the duration
  // grows when the tail is appended): playing then ends it. `play()` on an ended video would restart.
  await video(page).evaluate((v: HTMLVideoElement) => {
    if (!v.ended) void v.play();
  });
  await expect.poll(() => prop(page, 'ended'), { timeout: 10_000 }).toBe(true);
  await expect(page.getByTestId('centre')).toHaveAttribute('data-state', 'replay');
  await expect(page.getByTestId('error')).toHaveCount(0);
}

for (const paused of [false, true]) {
  test(`currentTime = duration ${paused ? 'while paused' : 'while playing'} ends the video`, async ({
    page,
  }) => {
    await open(page);
    if (paused) await video(page).evaluate((v: HTMLVideoElement) => v.pause());
    await video(page).evaluate((v: HTMLVideoElement) => (v.currentTime = v.duration));
    await expectEnded(page);

    // Replay from the end still works.
    await video(page).evaluate((v: HTMLVideoElement) => {
      v.currentTime = 0;
      void v.play();
    });
    await expect.poll(() => prop(page, 'currentTime'), { timeout: 20_000 }).toBeGreaterThan(1);
    await expect(page.getByTestId('error')).toHaveCount(0);
  });
}

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('a long forward double-tap streak, clamped to the end, ends the video', async ({ page }) => {
    await open(page);
    const box = (await page.getByTestId('screen').boundingBox())!;
    const x = box.x + box.width * 0.88;
    const y = box.y + box.height * 0.3;
    // +5 +10 +20 +40 = 75 s from under 40 s in: clamped to the duration.
    for (let i = 0; i < 5; i++) {
      await page.touchscreen.tap(x, y);
      await page.waitForTimeout(80);
    }
    await expect(page.getByTestId('seek-streak')).toContainText('1 min 15 s');
    await expectEnded(page);
  });
});
