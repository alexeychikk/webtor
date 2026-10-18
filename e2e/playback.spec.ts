import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

const currentTime = (page: Page) =>
  page.getByTestId('video').evaluate((v: HTMLVideoElement) => v.currentTime);

test('plays a magnet from the fixture web seed and keeps playing after a seek', async ({
  page,
}) => {
  const magnet = await fixtureMagnet('sample.mkv');
  await page.goto('./');
  await page.getByLabel('Magnet link or info hash').fill(magnet);
  await page.getByRole('button', { name: 'Play' }).click();

  await expect(page).toHaveURL(/#magnet=magnet%3A%3Fxt%3Durn%3Abtih%3A/);
  await expect(page.getByTestId('status')).toContainText('sample.mkv');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(2);
  await expect(page.getByTestId('status')).toHaveAttribute('data-phase', 'playing');
  await expect(page.getByTestId('error')).toHaveCount(0);
  // The default "English AAC" track is copied into its own SourceBuffer and decoded.
  const audioBytes = await page
    .getByTestId('video')
    .evaluate(
      (v) =>
        (v as HTMLVideoElement & { webkitAudioDecodedByteCount: number })
          .webkitAudioDecodedByteCount,
    );
  expect(audioBytes).toBeGreaterThan(0);

  await page.getByTestId('video').evaluate((v: HTMLVideoElement) => (v.currentTime = 8));
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(9);
  await expect(page.getByTestId('error')).toHaveCount(0);
});

test('back-pressure and a seek into unbuffered media restart at a keyframe', async ({ page }) => {
  // Keep only ~2 s appended ahead, so 8 s is not buffered when we seek there.
  await page.addInitScript(() => localStorage.setItem('webtor:buffer-ahead-s', '2'));
  const magnet = await fixtureMagnet('sample.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
  const bufferedEnd = () =>
    page.getByTestId('video').evaluate((v: HTMLVideoElement) => v.buffered.end(0));
  expect(await bufferedEnd()).toBeLessThan(7);

  await page.getByTestId('video').evaluate((v: HTMLVideoElement) => (v.currentTime = 8));
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(9);
  // The restart dropped everything before the keyframe it started from.
  const bufferedStart = await page
    .getByTestId('video')
    .evaluate((v: HTMLVideoElement) => v.buffered.start(0));
  expect(bufferedStart).toBeGreaterThan(3);
  await expect(page.getByTestId('error')).toHaveCount(0);
});

test('autoplays a #magnet= link on page load', async ({ page }) => {
  const magnet = await fixtureMagnet('sample.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByLabel('Magnet link or info hash')).toHaveValue(magnet);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
});

test('a torrent nobody seeds shows the no-peers message', async ({ page }) => {
  const randomHash = Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16));
  await page.goto('./');
  await page.getByLabel('Magnet link or info hash').fill(randomHash.join(''));
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-phase', 'connecting');
  await expect(page.locator('[data-testid="notice"][data-code="no-peers"]')).toContainText(
    'No browser-compatible peers found',
    { timeout: 25_000 },
  );
  // Not a dead end: it keeps searching.
  await expect(page.getByTestId('status')).toHaveAttribute('data-phase', 'connecting');
});
