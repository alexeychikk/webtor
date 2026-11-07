import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

// Quick seek streaks (←/→ pressed and held) on e2e/fixtures/resume/movie.mkv (40 s) with the
// piece-window.spec.ts settings, so every streak restarts the pipelines over evicted pieces. WebKit's
// GStreamer backend sometimes failed one with a fatal "Failed to send data for decoding": WebKit
// sets its decoders' `max-errors` to 0, so one packet avdec_h264 rejects is a MediaError DECODE
// (ADR 0003 "Decode errors"). The player then opens the file again where it was. That error can't be
// provoked on purpose, so the recovery tests raise one on the element.

const video = (page: Page) => page.getByTestId('video');
const prop = <K extends keyof HTMLVideoElement>(page: Page, k: K) =>
  video(page).evaluate((v: HTMLVideoElement, k) => v[k], k) as Promise<HTMLVideoElement[K]>;

async function open(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('webtor:buffer-ahead-s', '4');
    localStorage.setItem('webtor:read-slack-bytes', '0');
    localStorage.setItem('webtor:read-cache-bytes', String(64 * 1024));
    localStorage.setItem('webtor:subtitle-language', 'off');
  });
  const magnet = await fixtureMagnet('resume');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByTestId('status')).toContainText('movie.mkv');
  await expect.poll(() => prop(page, 'currentTime'), { timeout: 30_000 }).toBeGreaterThan(0.5);
}

/** The seek completes and the playhead moves on from there, with no error. */
async function playsOn(page: Page, what: string) {
  await expect.poll(() => prop(page, 'seeking'), { message: what, timeout: 15_000 }).toBe(false);
  const at = await prop(page, 'currentTime');
  await expect
    .poll(() => prop(page, 'currentTime'), { message: what, timeout: 15_000 })
    .toBeGreaterThan(at + 0.5);
  await expect(page.getByTestId('error')).toHaveCount(0);
}

/** Raises the element's `error` event as WebKit does on a decode error; returns `src` and time then. */
function decodeError(page: Page): Promise<{ src: string; at: number }> {
  return video(page).evaluate((v: HTMLVideoElement) => {
    const before = { src: v.src, at: v.currentTime };
    Object.defineProperty(v, 'error', {
      configurable: true,
      get: () => ({ code: 3, message: 'Failed to send data for decoding' }),
    });
    v.dispatchEvent(new Event('error'));
    Reflect.deleteProperty(v, 'error');
    return before;
  });
}

test('quick seek streaks play on', async ({ page }) => {
  await open(page);
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await playsOn(page, `→ streak ${r}`);
    for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowLeft');
    await playsOn(page, `← streak ${r}`);
    await page.keyboard.down('ArrowLeft');
    await page.keyboard.down('ArrowLeft');
    await page.keyboard.up('ArrowLeft');
    await playsOn(page, `← auto-repeat ${r}`);
  }
});

test('a decode error during a streak opens the file again at the seek target', async ({ page }) => {
  await open(page);
  const before = await prop(page, 'currentTime');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  const { src, at } = await decodeError(page);
  expect(at).toBeGreaterThan(before + 5);
  await expect.poll(() => prop(page, 'src')).not.toBe(src);
  await playsOn(page, 'after the reopen');
  expect(await prop(page, 'currentTime')).toBeGreaterThan(at - 3);
  expect(await prop(page, 'paused')).toBe(false);

  // Recovered: a decode error elsewhere later reopens again.
  await page.keyboard.press('ArrowLeft');
  await playsOn(page, '←');
  await video(page).evaluate((v: HTMLVideoElement) => (v.currentTime = 34));
  await playsOn(page, 'far forward');
  const again = await decodeError(page);
  await expect.poll(() => prop(page, 'src')).not.toBe(again.src);
  await playsOn(page, 'after the second reopen');
});

test('decode errors again and again at one spot end in the error card', async ({ page }) => {
  await open(page);
  await video(page).evaluate((v: HTMLVideoElement) => (v.currentTime = 20));
  await playsOn(page, 'at 20 s');
  for (let i = 0; i < 3; i++) {
    const { src } = await decodeError(page);
    await expect.poll(() => prop(page, 'src'), { message: `reopen ${i + 1}` }).not.toBe(src);
    await playsOn(page, `after reopen ${i + 1}`);
  }
  await decodeError(page);
  await expect(page.getByTestId('error')).toBeVisible();
  await expect(page.getByTestId('error')).toContainText('Failed to send data for decoding');
});
