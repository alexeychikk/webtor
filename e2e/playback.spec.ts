import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';
import { closeMenu, openMenu, selectAudio } from './support/player';

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
  const card = page.locator('[data-testid="notice"][data-code="no-peers"]');
  await expect(card).toContainText('No browser-compatible peers found', { timeout: 25_000 });
  await expect(card).toContainText('No browser peers yet');
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
  // A toast: it hides with the controls, so check it is there and says what happened.
  const stalled = page.locator('[data-testid="notice"][data-code="stalled"]');
  await expect(stalled).toBeAttached({ timeout: 40_000 });
  await expect(stalled).toContainText('Download stalled');
  await expect(stalled.getByTestId('why-link')).toBeAttached();
  await expect(page.getByTestId('error')).toHaveCount(0);
  // Still waiting for data: a spinner, never the play button.
  await expect(page.getByTestId('centre')).toHaveAttribute('data-state', /^(loading|buffering)$/);
});

/** Plays from `t` until the video ends (polls `ended`), with no failure on the way. */
async function playToEnd(page: Page, t?: number) {
  const video = page.getByTestId('video');
  await video.evaluate((v: HTMLVideoElement, t) => {
    if (t !== undefined) v.currentTime = t;
    void v.play();
  }, t);
  try {
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.ended), { timeout: 60_000 })
      .toBe(true);
  } catch (err) {
    // What the element was doing, for a failure that doesn't reproduce.
    const state = await video.evaluate((v: HTMLVideoElement) => {
      const b = v.buffered;
      const ranges = Array.from({ length: b.length }, (_, i) => `${b.start(i)}–${b.end(i)}`);
      return `t=${v.currentTime} paused=${v.paused} seeking=${v.seeking} readyState=${v.readyState} buffered=${ranges.join(',')} quotaHits=${v.dataset.quotaHits}`;
    });
    throw new Error(`${String(err)}\n${state}`);
  }
  await expect(page.getByTestId('error')).toHaveCount(0);
}

test('a small SourceBuffer quota (Safari/iPad) is back-pressure: plays, seeks, switches audio', async ({
  page,
}) => {
  test.setTimeout(150_000);
  // 250 KB per SourceBuffer is about 6 s of the fixture's video, and 12.5 KB before the init
  // segment (WebKit's 5 % audio share): less than Mediabunny's first write (moov + a 2 s GOP,
  // ~80 KB). The iPad failure: that write was refused every time, then "buffer too small".
  await page.addInitScript(() => localStorage.setItem('webtor:sb-quota-bytes', '250000'));
  const magnet = await fixtureMagnet('sample.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  const video = page.getByTestId('video');
  const quotaHits = async () => Number(await video.getAttribute('data-quota-hits'));
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
  await playToEnd(page);
  await expect.poll(quotaHits, { timeout: 10_000 }).toBeGreaterThan(0);

  // Back to the start (evicted under the quota), then forward again.
  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 0.5;
    void v.play();
  });
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(3);
  await video.evaluate((v: HTMLVideoElement) => (v.currentTime = 7));
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(8);

  // Switch to the Russian AC-3 track (transcoded to Opus) and play to the end.
  await video.evaluate((v: HTMLVideoElement) => v.pause());
  await video.evaluate((v: HTMLVideoElement) => (v.currentTime = 1));
  const audio = await openMenu(page, 'audio-track');
  const russian = (await audio
    .getByRole('option', { name: /Russian AC3/ })
    .getAttribute('data-value'))!;
  await closeMenu(page);
  await selectAudio(page, { value: russian });
  await expect(video).toHaveAttribute('data-audio-track', russian);
  await playToEnd(page);
  await expect(video).toHaveAttribute('data-audio-codec', 'opus');

  // The stats panel shows the window the quota left and the hits.
  const stats = await openMenu(page, 'stats-button');
  const buffer = stats.getByTestId('stats-buffer');
  await expect(buffer).toContainText('quota hits');
  expect(Number(await buffer.getAttribute('data-quota-hits'))).toBeGreaterThan(0);
  expect(Number(await buffer.getAttribute('data-target'))).toBeLessThan(60);
});

test('a SourceBuffer quota of about one fragment plays through and seeks back', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // 100 KB: 5 KB before the init segment, far less than one fragment (a 2 s GOP of the fixture's
  // video, ~75 KB), and room for about 1.3 of them after it: each fragment goes in as pieces while
  // the one before it plays, then that one is dropped. (A quota under one GOP can't play: MSE
  // removes whole GOPs and the decoder holds frames back, so that fails with the numbers after
  // 20 s, see append.test.ts.)
  await page.addInitScript(() => localStorage.setItem('webtor:sb-quota-bytes', '100000'));
  const magnet = await fixtureMagnet('sample.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
  await playToEnd(page);
  await playToEnd(page, 3);
  expect(Number(await page.getByTestId('video').getAttribute('data-quota-hits'))).toBeGreaterThan(
    0,
  );
});
