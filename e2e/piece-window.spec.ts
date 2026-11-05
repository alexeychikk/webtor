import { statSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

// e2e/fixtures/resume/movie.mkv: 40 s, the largest file of the `resume` torrent (ADR 0012).

const video = (page: Page) => page.getByTestId('video');
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);
const seekTo = (page: Page, t: number) =>
  video(page).evaluate((v: HTMLVideoElement, to) => {
    v.currentTime = to;
  }, t);
const storedBytes = (page: Page) => page.evaluate(() => window.__webtorStoredBytes ?? -1);
const longestStall = (page: Page) =>
  page.evaluate(() => (window as unknown as { __webtorStalls: number[] }).__webtorStalls);

/** Records how long the main thread was blocked: gaps between 20 ms timer ticks. */
function watchMainThread(page: Page) {
  return page.addInitScript(() => {
    const w = window as unknown as { __webtorStalls: number[] };
    w.__webtorStalls = [0];
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      w.__webtorStalls[0] = Math.max(w.__webtorStalls[0]!, now - last);
      last = now;
    }, 20);
  });
}

async function open(page: Page) {
  const magnet = await fixtureMagnet('resume');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByTestId('status')).toContainText('movie.mkv');
}

test('a seek far ahead after a resume plays on without blocking the page', async ({ page }) => {
  await watchMainThread(page);
  await open(page);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
  await seekTo(page, 12);
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(13);
  await page.reload();
  await expect(page.getByTestId('status')).toContainText('movie.mkv');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(13);
  await expect(page.getByTestId('resume-toast')).toBeAttached();

  const before = await longestStall(page);
  await seekTo(page, 34);
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(35);
  const after = await longestStall(page);
  expect(after[0], `main thread blocked for ${Math.round(after[0]!)} ms`).toBeLessThan(
    Math.max(1500, before[0]!),
  );
  await expect(page.getByTestId('error')).toHaveCount(0);
});

test('pieces behind the window are dropped and downloaded again on a seek back', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('webtor:buffer-ahead-s', '4');
    localStorage.setItem('webtor:read-slack-bytes', '0');
    localStorage.setItem('webtor:read-cache-bytes', String(64 * 1024));
  });
  await open(page);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
  const size = statSync('e2e/fixtures/resume/movie.mkv').size;
  await seekTo(page, 24);
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(30);
  // The first seconds and everything before the last ~10 s are gone from the store.
  await expect.poll(() => storedBytes(page), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(() => storedBytes(page), { timeout: 10_000 }).toBeLessThan(size * 0.6);

  await seekTo(page, 1);
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(3);
  await expect(page.getByTestId('error')).toHaveCount(0);
});
