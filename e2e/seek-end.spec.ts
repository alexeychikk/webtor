import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

// Seeks to and at the end of the media (CLAUDE.md "The end of the media"): a seek to exactly
// `duration` ends the video without restarting the pipelines, and seeks made in the last moment
// (before or after `ended`) never fail. WebKit's GStreamer backend failed both with fatal errors
// ("Failed to push buffer", "No valid frames decoded before end of stream"), and now and then
// replayed from 0 after playing into the end (`EOS_AHEAD_S` in src/lib/player/buffer.ts).
// Runs on Chromium and WebKit (playwright.config.ts). e2e/fixtures/resume/movie.mkv: 40 s.

const video = (page: Page) => page.getByTestId('video');
const prop = <K extends keyof HTMLVideoElement>(page: Page, k: K) =>
  video(page).evaluate((v: HTMLVideoElement, k) => v[k], k) as Promise<HTMLVideoElement[K]>;

/**
 * Opens the 40 s movie and lets it play a little. The jump comes early: on WebKit the tail is not
 * appended yet, and the append that the seek wakes reaches the end within the seek debounce.
 */
async function open(page: Page) {
  const magnet = await fixtureMagnet('resume');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByTestId('status')).toContainText('movie.mkv');
  await expect.poll(() => prop(page, 'currentTime'), { timeout: 30_000 }).toBeGreaterThan(0.5);
}

/** Ended (or, paused a frame before the end, ends once played), with no error on the way. */
async function expectEnded(page: Page) {
  await expect.poll(() => prop(page, 'currentTime')).toBeGreaterThan(39.9);
  // Settled at the end: no restart failing late.
  await page.waitForTimeout(2000);
  await expect(page.getByTestId('error')).toHaveCount(0);
  // WebKit may stop at the header duration, a few ms before the last frame's end (the duration
  // grows when the tail is appended): playing then ends it. `play()` on an ended video would restart.
  await video(page).evaluate((v: HTMLVideoElement) => {
    if (!v.ended) void v.play();
  });
  await expect.poll(() => prop(page, 'ended'), { timeout: 10_000 }).toBe(true);
  await expect(page.getByTestId('centre')).toHaveAttribute('data-state', 'replay');
  await expect(page.getByTestId('error')).toHaveCount(0);
}

for (const paused of [false, true]) {
  test(`currentTime = duration ${paused ? 'while paused' : 'while playing'} ends the video`, async ({
    page,
  }) => {
    await open(page);
    if (paused) await video(page).evaluate((v: HTMLVideoElement) => v.pause());
    await video(page).evaluate((v: HTMLVideoElement) => (v.currentTime = v.duration));
    await expectEnded(page);

    // Replay from the end still works.
    await video(page).evaluate((v: HTMLVideoElement) => {
      v.currentTime = 0;
      void v.play();
    });
    await expect.poll(() => prop(page, 'currentTime'), { timeout: 20_000 }).toBeGreaterThan(1);
    await expect(page.getByTestId('error')).toHaveCount(0);
  });
}

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('a long forward double-tap streak, clamped to the end, ends the video', async ({ page }) => {
    await open(page);
    const box = (await page.getByTestId('screen').boundingBox())!;
    const x = box.x + box.width * 0.88;
    const y = box.y + box.height * 0.3;
    // +5 +10 +20 +40 = 75 s from under 40 s in: clamped to the duration.
    for (let i = 0; i < 5; i++) {
      await page.touchscreen.tap(x, y);
      await page.waitForTimeout(80);
    }
    await expect(page.getByTestId('seek-streak')).toContainText('1 min 15 s');
    await expectEnded(page);
  });
});

/** Plays from 37 s and waits until the playhead is in the last 0.3 s, not ended yet. */
async function nearEnd(page: Page) {
  await video(page).evaluate((v: HTMLVideoElement) => (v.currentTime = 37));
  await video(page).evaluate(
    (v: HTMLVideoElement) =>
      new Promise<void>((resolve, reject) => {
        const tick = () => {
          if (v.ended) reject(new Error('ended before the last moment was seen'));
          else if (!v.seeking && v.currentTime > v.duration - 0.3) resolve();
          else requestAnimationFrame(tick);
        };
        tick();
      }),
  );
}

/** Plays a paused (not ended) video, then expects it to end. */
async function playToEnd(page: Page) {
  await video(page).evaluate((v: HTMLVideoElement) => {
    if (!v.ended) void v.play();
  });
  await expectEnded(page);
}

test('→ pressed repeatedly after a seek near the end ends the video', async ({ page }) => {
  await open(page);
  await video(page).evaluate((v: HTMLVideoElement) => (v.currentTime = 37));
  await page.waitForTimeout(500);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(100);
  }
  await expectEnded(page);
  // At the end, → again.
  await page.keyboard.press('ArrowRight');
  await playToEnd(page);
});

for (const back of [0, 0.05, 0.2]) {
  test(`a seek to duration − ${back} s from the last moment ends the video`, async ({ page }) => {
    await open(page);
    await nearEnd(page);
    await video(page).evaluate(
      (v: HTMLVideoElement, back) => (v.currentTime = v.duration - back),
      back,
    );
    await playToEnd(page);
    // Once ended, the same seek again.
    await video(page).evaluate((v: HTMLVideoElement) => (v.currentTime = v.duration));
    await page.waitForTimeout(300);
    await playToEnd(page);
  });
}

test('← from the last moment seeks back and plays on', async ({ page }) => {
  await open(page);
  await nearEnd(page);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => prop(page, 'currentTime')).toBeLessThan(36);
  await expect.poll(() => prop(page, 'currentTime'), { timeout: 10_000 }).toBeGreaterThan(36.5);
  await expectEnded(page);
});

test('plays through the end and stays ended (no replay from 0)', async ({ page }) => {
  await open(page);
  await video(page).evaluate((v: HTMLVideoElement) => {
    v.currentTime = 34;
    // Seeks back from there (the player's own keyframe seek after a restart stays at 34 s).
    const back: number[] = [];
    (window as unknown as { __back: number[] }).__back = back;
    v.addEventListener('seeking', () => {
      if (v.currentTime < 30) back.push(v.currentTime);
    });
  });
  await expect.poll(() => prop(page, 'ended'), { timeout: 20_000 }).toBe(true);
  // WebKit replayed from 0 a moment after the end when the MediaSource ended on the stall there.
  await page.waitForTimeout(1500);
  expect(await prop(page, 'ended')).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __back: number[] }).__back)).toEqual([]);
  await expect(page.getByTestId('centre')).toHaveAttribute('data-state', 'replay');
  await expect(page.getByTestId('error')).toHaveCount(0);
});

/**
 * Plays from 37 s and waits (rAF) for the player's `endOfStream()` call, a moment before the end,
 * with the element not ended yet. Needs `hookEndOfStream` first.
 */
async function afterEndOfStream(page: Page) {
  await video(page).evaluate((v: HTMLVideoElement) => (v.currentTime = 37));
  await video(page).evaluate(
    (v: HTMLVideoElement) =>
      new Promise<void>((resolve, reject) => {
        const w = window as unknown as { __eos: number };
        const tick = () => {
          if (v.ended) reject(new Error('ended before endOfStream() was seen'));
          else if (w.__eos > 0) resolve();
          else requestAnimationFrame(tick);
        };
        tick();
      }),
  );
}

/** Counts `MediaSource.endOfStream()` calls in `window.__eos`. */
async function hookEndOfStream(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __eos: number };
    w.__eos = 0;
    const end = MediaSource.prototype.endOfStream;
    MediaSource.prototype.endOfStream = function (this: MediaSource, ...args: []) {
      w.__eos++;
      return end.apply(this, args);
    };
  });
}

// WebKit's GStreamer backend could not seek between `endOfStream()` and `ended`: a fatal "No valid
// frames decoded before end of stream", or a seek that never completed. The player holds such a
// seek until the element ends, then runs it.
test.describe('a seek after endOfStream(), before ended', () => {
  test.beforeEach(async ({ page }) => {
    await hookEndOfStream(page);
    await open(page);
    await afterEndOfStream(page);
  });

  test('back to 30 s plays on from there', async ({ page }) => {
    // The same task as the poll: no time for the element to end in between.
    expect(
      await video(page).evaluate((v: HTMLVideoElement) => {
        const ended = v.ended;
        v.currentTime = 30;
        return ended;
      }),
    ).toBe(false);
    await expect.poll(() => prop(page, 'currentTime'), { timeout: 10_000 }).toBeLessThan(36);
    await expect.poll(() => prop(page, 'currentTime'), { timeout: 10_000 }).toBeGreaterThan(31);
    expect(await prop(page, 'paused')).toBe(false);
    await expect.poll(() => prop(page, 'ended'), { timeout: 20_000 }).toBe(true);
    await expectEnded(page);
  });

  test('to duration ends the video', async ({ page }) => {
    await video(page).evaluate((v: HTMLVideoElement) => (v.currentTime = v.duration));
    await expectEnded(page);
  });
});
