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
  await page.getByRole('button', { name: 'Play', exact: true }).click();

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

test('a file whose first frame is not at 0 (MPEG-TS, ~1.4 s) plays from 0 and seeks', async ({
  page,
}) => {
  // Small window: back-pressure must engage, which it can't if the buffer starts past currentTime.
  await page.addInitScript(() => localStorage.setItem('webtor:buffer-ahead-s', '3'));
  const magnet = await fixtureMagnet('offset.ts');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
  const media = () =>
    page.getByTestId('video').evaluate((v: HTMLVideoElement) => ({
      start: v.buffered.length ? v.buffered.start(0) : NaN,
      end: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : NaN,
      duration: v.duration,
    }));
  const first = await media();
  expect(first.start).toBeLessThan(0.5);
  expect(first.end).toBeLessThan(7);
  expect(first.duration).toBeGreaterThan(9);
  expect(first.duration).toBeLessThan(10.5);

  await page.getByTestId('video').evaluate((v: HTMLVideoElement) => (v.currentTime = 7));
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(8);
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
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-phase', 'connecting');
  // The picture shows a spinner with what it waits for.
  await expect(page.getByTestId('centre')).toHaveAttribute('data-state', 'loading');
  await expect(page.getByTestId('centre')).toContainText('Looking for peers…');
  await expect(page.locator('[data-testid="notice"][data-code="no-peers"]')).toContainText(
    'No browser-compatible peers found',
    { timeout: 25_000 },
  );
  // Not a dead end: it keeps searching.
  await expect(page.getByTestId('status')).toHaveAttribute('data-phase', 'connecting');
});

test('a web seed that keeps failing shows the stalled message', async ({ page }) => {
  // WebTorrent retries a failing web seed every ~10 s; each retry blips the speed estimate above
  // 0 without delivering bytes, which must not reset the stall timer.
  await page.route(/127\.0\.0\.1:9000\/sample\.mkv$/, (route) => route.fulfill({ status: 503 }));
  const magnet = await fixtureMagnet('sample.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByTestId('status')).toContainText('sample.mkv');
  await expect(page.locator('[data-testid="notice"][data-code="stalled"]')).toBeVisible({
    timeout: 40_000,
  });
  await expect(page.getByTestId('error')).toHaveCount(0);
  // Still waiting for data: a spinner, never the play button.
  await expect(page.getByTestId('centre')).toHaveAttribute('data-state', /^(loading|buffering)$/);
});
