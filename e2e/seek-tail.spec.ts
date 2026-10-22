import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';
import { selectAudio } from './support/player';

// Seeks into the tail where one track has already ended (CLAUDE.md "The end of the media"):
// e2e/fixtures/short-audio.mkv is 12 s of video whose two audio tracks ("English AAC", copied, and
// "Russian AC3", transcoded) end at 6 s. A seek past 6 s used to restart the audio pipeline past
// its track's end: the browser rejected its output and emptied the element (paused at 0, no error
// card). Now the video plays on to the end. Runs on Chromium and WebKit (playwright.config.ts).

const video = (page: Page) => page.getByTestId('video');
const prop = <K extends keyof HTMLVideoElement>(page: Page, k: K) =>
  video(page).evaluate((v: HTMLVideoElement, k) => v[k], k) as Promise<HTMLVideoElement[K]>;
const seekTo = (page: Page, t: number) =>
  video(page).evaluate((v: HTMLVideoElement, to) => {
    v.currentTime = to;
  }, t);

/**
 * Counts `emptied` (the element reset by a failed append) in `window.__emptied`, and with
 * `restart`, keeps the buffer ahead at 2 s, so a seek into the tail finds the audio not appended
 * through its end and restarts the pipelines there.
 */
async function open(page: Page, { restart = false } = {}) {
  await page.addInitScript((restart) => {
    if (restart) localStorage.setItem('webtor:buffer-ahead-s', '2');
    const w = window as unknown as { __emptied: number };
    w.__emptied = 0;
    document.addEventListener('emptied', () => (w.__emptied += 1), true);
  }, restart);
  const magnet = await fixtureMagnet('short-audio.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByTestId('status')).toContainText('short-audio.mkv');
  await expect.poll(() => prop(page, 'currentTime'), { timeout: 30_000 }).toBeGreaterThan(0.5);
}

const emptied = (page: Page) =>
  page.evaluate(() => (window as unknown as { __emptied: number }).__emptied);

/** Plays from the tail to `ended`: no error, no reset of the element on the way. */
async function expectEnded(page: Page) {
  await expect.poll(() => prop(page, 'ended'), { timeout: 15_000 }).toBe(true);
  expect(await prop(page, 'currentTime')).toBeGreaterThan(11.5);
  await expect(page.getByTestId('centre')).toHaveAttribute('data-state', 'replay');
  await expect(page.getByTestId('error')).toHaveCount(0);
  expect(await emptied(page)).toBe(0);
}

for (const restart of [false, true]) {
  const how = restart ? 'not appended yet' : 'appended';
  test(`a seek into the audio-less tail while playing plays the video to the end (${how})`, async ({
    page,
  }) => {
    await open(page, { restart });
    await seekTo(page, 9);
    // It plays on from the target rather than waiting or going back.
    await expect.poll(() => prop(page, 'currentTime'), { timeout: 10_000 }).toBeGreaterThan(9.5);
    await expectEnded(page);

    // Back from the end to where there is audio: plays with it again.
    await video(page).evaluate((v: HTMLVideoElement) => {
      v.currentTime = 1;
      void v.play();
    });
    await expect.poll(() => prop(page, 'currentTime'), { timeout: 10_000 }).toBeGreaterThan(2);
    await expect(page.getByTestId('error')).toHaveCount(0);
    expect(await emptied(page)).toBe(0);
  });

  test(`a seek into the audio-less tail while paused stays there, then plays to the end (${how})`, async ({
    page,
  }) => {
    await open(page, { restart });
    await video(page).evaluate((v: HTMLVideoElement) => v.pause());
    await seekTo(page, 10);
    await expect.poll(() => prop(page, 'seeking'), { timeout: 10_000 }).toBe(false);
    await page.waitForTimeout(1000);
    expect(await prop(page, 'paused')).toBe(true);
    expect(await prop(page, 'currentTime')).toBeCloseTo(10, 1);
    await expect(page.getByTestId('error')).toHaveCount(0);
    await video(page).evaluate((v: HTMLVideoElement) => void v.play());
    await expectEnded(page);
  });
}

test('a seek into the tail with the transcoded track plays the video to the end', async ({
  page,
}) => {
  await open(page, { restart: true });
  await selectAudio(page, { label: /Russian AC3/ });
  await expect(video(page)).toHaveAttribute('data-audio-codec', /opus|aac/);
  await seekTo(page, 8.5);
  await expectEnded(page);
});

test('resume into the audio-less tail plays the video to the end', async ({ page }) => {
  await open(page);
  await video(page).evaluate((v: HTMLVideoElement) => v.pause());
  // Saved on pause and seek (watch-state.ts); resumes from 10 s on, short of the last 5 %.
  await seekTo(page, 10.5);
  await expect.poll(() => prop(page, 'seeking'), { timeout: 10_000 }).toBe(false);
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByTestId('status')).toContainText('short-audio.mkv');
  await expect(page.getByTestId('resume-toast')).toBeAttached({ timeout: 30_000 });
  await video(page).evaluate((v: HTMLVideoElement) => {
    if (v.paused && !v.ended) void v.play();
  });
  await expectEnded(page);
});
