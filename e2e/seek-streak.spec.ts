import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

// The seek overlay for ←/→ and the centre ±5 s buttons (src/lib/player/seek-streak.ts) on
// e2e/fixtures/resume/movie.mkv (40 s, room for a few skips). Double-tap: touch-seek.spec.ts.

const video = (page: Page) => page.getByTestId('video');
const prop = <K extends keyof HTMLVideoElement>(page: Page, k: K) =>
  video(page).evaluate((v: HTMLVideoElement, k) => v[k], k) as Promise<HTMLVideoElement[K]>;
const streak = (page: Page) => page.getByTestId('seek-streak');

async function open(page: Page) {
  const magnet = await fixtureMagnet('resume');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByTestId('status')).toContainText('movie.mkv');
  await expect.poll(() => prop(page, 'currentTime'), { timeout: 30_000 }).toBeGreaterThan(0.5);
}

test('←/→ stack on their side while pressed quickly; the other way or a pause starts again', async ({
  page,
}) => {
  await open(page);
  await expect(page.getByTestId('controls')).toBeHidden({ timeout: 6_000 });
  const before = await prop(page, 'currentTime');

  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(streak(page)).toBeVisible();
  await expect(streak(page)).toHaveAttribute('data-side', 'forward');
  await expect(streak(page)).toHaveAttribute('data-total', '15');
  await expect(streak(page)).toContainText('+15 s');
  await expect(streak(page)).toHaveCount(1);
  await expect.poll(() => prop(page, 'currentTime')).toBeGreaterThan(before + 14);

  await page.keyboard.press('ArrowLeft');
  await expect(streak(page)).toHaveAttribute('data-side', 'back');
  await expect(streak(page)).toHaveAttribute('data-total', '5');
  await expect(streak(page)).toContainText('−5 s');

  await expect(streak(page)).toHaveCount(0); // It fades out after the window.
  await page.keyboard.press('ArrowLeft');
  await expect(streak(page)).toHaveAttribute('data-side', 'back');
  await expect(streak(page)).toHaveAttribute('data-total', '5');
  await expect(streak(page)).toHaveCount(0);
  expect(await prop(page, 'paused')).toBe(false);
});

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('two quick taps on the centre +5 s button show +10 s on the right', async ({ page }) => {
    await open(page);
    const bar = page.getByTestId('controls');
    await expect(bar).toBeHidden({ timeout: 6_000 });
    const box = (await video(page).boundingBox())!;
    await video(page).tap({ position: { x: box.width / 2, y: box.height * 0.3 } });
    await expect(bar).toBeVisible();

    const before = await prop(page, 'currentTime');
    await page.getByTestId('seek-forward').tap();
    await page.getByTestId('seek-forward').tap();
    await expect(streak(page)).toHaveAttribute('data-side', 'forward');
    await expect(streak(page)).toHaveAttribute('data-total', '10');
    await expect(streak(page)).toContainText('+10 s');
    await expect.poll(() => prop(page, 'currentTime')).toBeGreaterThan(before + 9);

    await page.getByTestId('seek-back').tap();
    await expect(streak(page)).toHaveAttribute('data-side', 'back');
    await expect(streak(page)).toHaveAttribute('data-total', '5');
    await expect(streak(page)).toHaveCount(0);
  });
});
