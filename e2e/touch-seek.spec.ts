import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

// Double-tap seeking on touch (src/lib/player/touch-seek.ts) on e2e/fixtures/resume/movie.mkv
// (40 s, the largest file of the torrent, so it opens first).

test.use({ hasTouch: true });

const video = (page: Page) => page.getByTestId('video');
const prop = <K extends keyof HTMLVideoElement>(page: Page, k: K) =>
  video(page).evaluate((v: HTMLVideoElement, k) => v[k], k) as Promise<HTMLVideoElement[K]>;
const streak = (page: Page) => page.getByTestId('seek-streak');

/** `count` quick taps on a side of the picture (well inside its outer third, above the centre). */
async function tapSide(page: Page, side: 'back' | 'forward', count: number) {
  const box = (await page.getByTestId('screen').boundingBox())!;
  const x = box.x + box.width * (side === 'back' ? 0.12 : 0.88);
  const y = box.y + box.height * 0.3;
  for (let i = 0; i < count; i++) {
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(80);
  }
}

async function open(page: Page) {
  const magnet = await fixtureMagnet('resume');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByTestId('status')).toContainText('movie.mkv');
  await expect.poll(() => prop(page, 'currentTime'), { timeout: 30_000 }).toBeGreaterThan(0.5);
}

test('a double-tap on the right seeks +5 s and a streak doubles the step; the left mirrors it', async ({
  page,
}) => {
  await open(page);
  const bar = page.getByTestId('controls');
  await expect(bar).toBeHidden({ timeout: 6_000 });

  // Double-tap: +5 s; the overlay says so on that side; nothing else changes.
  let before = await prop(page, 'currentTime');
  await tapSide(page, 'forward', 2);
  await expect(streak(page)).toHaveAttribute('data-side', 'forward');
  await expect(streak(page)).toContainText('5 s');
  await expect.poll(() => prop(page, 'currentTime')).toBeGreaterThan(before + 4.5);
  expect(await prop(page, 'currentTime')).toBeLessThan(before + 7);
  await expect(streak(page)).toHaveCount(0); // It fades out once the streak ends.
  await expect(bar).toBeHidden();
  expect(await prop(page, 'paused')).toBe(false);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();

  // Streak: 4 taps = +5 +10 +20 = 35 s, one seek at the end.
  await video(page).evaluate((v: HTMLVideoElement) => (v.currentTime = 1));
  await expect.poll(() => prop(page, 'seeking')).toBe(false);
  before = await prop(page, 'currentTime');
  await tapSide(page, 'forward', 4);
  await expect(streak(page)).toHaveAttribute('data-total', '35');
  await expect(streak(page)).toContainText('35 s');
  await expect.poll(() => prop(page, 'currentTime')).toBeGreaterThan(before + 34);
  expect(await prop(page, 'currentTime')).toBeLessThan(before + 37.5);
  await expect(streak(page)).toHaveCount(0);
  await expect(bar).toBeHidden();
  expect(await prop(page, 'paused')).toBe(false);

  // Left: back 5 + 10 + 20 = 35 s.
  await video(page).evaluate((v: HTMLVideoElement) => v.pause());
  await video(page).evaluate((v: HTMLVideoElement) => (v.currentTime = 37));
  await expect.poll(() => prop(page, 'seeking')).toBe(false);
  await tapSide(page, 'back', 4);
  await expect(streak(page)).toHaveAttribute('data-side', 'back');
  await expect(streak(page)).toContainText('35 s');
  await expect.poll(() => prop(page, 'currentTime')).toBeCloseTo(2, 1);
  expect(await prop(page, 'paused')).toBe(true);

  // Clamped at 0 and at the end.
  await expect(streak(page)).toHaveCount(0);
  await tapSide(page, 'back', 3);
  await expect.poll(() => prop(page, 'currentTime')).toBe(0);
  await expect(streak(page)).toHaveCount(0);
  await tapSide(page, 'forward', 5);
  await expect(streak(page)).toContainText('1 min 15 s');
  const duration = await prop(page, 'duration');
  await expect.poll(() => prop(page, 'currentTime')).toBeCloseTo(duration, 1);
});

test('a single tap on a side still shows and hides the controls (after the double-tap window)', async ({
  page,
}) => {
  await open(page);
  const bar = page.getByTestId('controls');
  await expect(bar).toBeHidden({ timeout: 6_000 });
  const before = await prop(page, 'currentTime');
  await tapSide(page, 'forward', 1);
  await expect(bar).toBeVisible();
  await page.waitForTimeout(500);
  await tapSide(page, 'back', 1);
  await expect(bar).toBeHidden();
  await expect(streak(page)).toHaveCount(0);
  expect(await prop(page, 'currentTime')).toBeLessThan(before + 3);
  expect(await prop(page, 'paused')).toBe(false);
});
