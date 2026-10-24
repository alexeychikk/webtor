import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

// Dolby Vision (ADR 0010). The fixtures are H.264 MKVs with a DV configuration record in the video
// TrackEntry (scripts/make-dv-fixtures.mjs): what the player reads to decide, not a DV picture.

const currentTime = (page: Page) =>
  page.getByTestId('video').evaluate((v: HTMLVideoElement) => v.currentTime);

test('Dolby Vision profile 5 is refused with its own error card, no Retry', async ({ page }) => {
  const magnet = await fixtureMagnet('dolby-vision-p5.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  const error = page.getByTestId('error');
  await expect(error).toHaveAttribute('data-code', 'dolby-vision-unsupported', { timeout: 30_000 });
  await expect(error).toContainText('Dolby Vision not supported');
  await expect(error).toContainText('without an HDR10 or SDR fallback');
  await expect(error).toContainText('profile 5');
  await expect(error.getByTestId('retry')).toHaveCount(0);
  await expect(page.getByTestId('status')).toContainText('dolby-vision-p5.mkv');
});

test('Dolby Vision profile 8.1 plays its base layer and says so in a toast', async ({ page }) => {
  const magnet = await fixtureMagnet('dolby-vision-p8.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  const notice = page.locator('[data-testid="notice"][data-code="dolby-vision-base-layer"]');
  await expect(notice).toBeAttached({ timeout: 30_000 });
  await expect(notice).toContainText('Dolby Vision plays as HDR10/HLG');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(page.getByTestId('error')).toHaveCount(0);
});

test('a file without Dolby Vision gets no Dolby Vision toast', async ({ page }) => {
  const magnet = await fixtureMagnet('sample.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(page.locator('[data-testid="notice"][data-code^="dolby-vision"]')).toHaveCount(0);
});
