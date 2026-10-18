import { expect, test } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

test('accepts a magnet link', async ({ page }) => {
  await page.goto('./');
  const play = page.getByRole('button', { name: 'Play' });
  await expect(play).toBeDisabled();
  await page
    .getByLabel('Magnet link or info hash')
    .fill('magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10');
  await expect(play).toBeEnabled();
  await play.click();
  await expect(page.getByTestId('status')).toBeVisible();
});

// Runs on Chromium, Firefox and WebKit (playwright.config.ts): the whole pipeline in each engine.
test('magnet → play', async ({ page }) => {
  const magnet = await fixtureMagnet('sample.mkv');
  await page.goto('./');
  await page.getByLabel('Magnet link or info hash').fill(magnet);
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByTestId('status')).toContainText('sample.mkv');
  const video = page.getByTestId('video');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(1);
  await expect(page.getByTestId('status')).toHaveAttribute('data-phase', 'playing');
  await expect(page.getByTestId('error')).toHaveCount(0);
});
