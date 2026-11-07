import { expect, test, type Browser, type Page } from '@playwright/test';
import { frameBytes, trueTimeAt } from './support/byte-truth';
import { expectEvicted, expectNoGap, heldLayer, layer, TOLERANCE_S } from './support/downloaded';
import { fixtureMagnet } from './support/fixtures';

// The seek bar's downloaded layer is drawn in time (ADR 0012 "Seek bar"): wherever the playhead
// goes, the layer covers it once the bytes there are held, and the ranges the piece window evicted
// disappear. Through the MKV Cues: e2e/fixtures/resume/movie.mkv (40 s) with the
// piece-window.spec.ts settings, so the small fixture is read in pieces and evicted behind the
// playhead. Through the MP4 sample table: vbr.mp4 (30 s, 93 % of the bytes in its first half).
// Without an index (points learned from the reads): offset.ts (MPEG-TS). Both with the default
// demuxer cache too, which reads the file at once.

const DURATION = 40;

const video = (page: Page) => page.getByTestId('video');
const prop = <K extends keyof HTMLVideoElement>(page: Page, k: K) =>
  video(page).evaluate((v: HTMLVideoElement, k) => v[k], k) as Promise<HTMLVideoElement[K]>;
const seekTo = (page: Page, t: number) =>
  video(page).evaluate((v: HTMLVideoElement, to) => {
    v.currentTime = to;
  }, t);

/**
 * Opens `fixture` and waits for it to play. `windowed`: the piece-window.spec.ts settings (small
 * demuxer cache, 4 s ahead); else the defaults.
 */
async function open(page: Page, fixture = 'resume', file = 'movie.mkv', windowed = true) {
  await page.addInitScript((windowed) => {
    if (windowed) {
      localStorage.setItem('webtor:buffer-ahead-s', '4');
      localStorage.setItem('webtor:read-slack-bytes', '0');
      localStorage.setItem('webtor:read-cache-bytes', String(64 * 1024));
    }
    localStorage.setItem('webtor:subtitle-language', 'off');
  }, windowed);
  const magnet = await fixtureMagnet(fixture);
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByTestId('status')).toContainText(file);
  await expect.poll(() => prop(page, 'currentTime'), { timeout: 30_000 }).toBeGreaterThan(0.5);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The page runs a script within `ms`: false once its web process hung. */
const answers = (page: Page, ms = 5000) =>
  Promise.race([page.evaluate(() => true).catch(() => true), sleep(ms).then(() => false)]);

/** Rejects once the page stops answering (checked every 2 s), else resolves once `done()`. */
async function hung(page: Page, done: () => boolean): Promise<void> {
  while (!done()) {
    await sleep(2000);
    if (!done() && !(await answers(page))) throw new Error('the page stopped answering');
  }
}

/**
 * Runs `steps` on `page`, and once more on a page of a new context if WebKit's web process hung
 * meanwhile: its main thread then sleeps on a lock for good (ADR 0003 "Web process hangs"), so no
 * script runs and no player can recover. Any other failure fails the test.
 */
async function onLivePage(page: Page, browser: Browser, steps: (page: Page) => Promise<void>) {
  let done = false;
  try {
    const run = steps(page);
    run.catch(() => {});
    await Promise.race([run, hung(page, () => done)]).finally(() => (done = true));
  } catch (err) {
    if (await answers(page)) throw err;
    test.info().annotations.push({ type: 'web process hung', description: String(err) });
    const { viewport, userAgent, deviceScaleFactor, hasTouch, isMobile } = test.info().project.use;
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      viewport,
      userAgent,
      deviceScaleFactor,
      hasTouch,
      isMobile,
    });
    try {
      await steps(await context.newPage());
    } finally {
      await context.close();
    }
  }
}

async function settle(page: Page) {
  await expect.poll(() => prop(page, 'seeking'), { timeout: 15_000 }).toBe(false);
}

test('the layer covers the playhead across keys, seek-bar jumps and evictions', async ({
  page,
}) => {
  await open(page);
  await expectNoGap(page, 'start');
  const first = (await layer(page)).ranges[0]!;
  expect(first[0]).toBeLessThanOrEqual((await prop(page, 'currentTime')) + TOLERANCE_S);
  expect(await prop(page, 'paused')).toBe(false);

  // → once, then a streak of three; ← once, then held down (auto-repeat).
  await page.keyboard.press('ArrowRight');
  await settle(page);
  await expectNoGap(page, '→');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await settle(page);
  await expectNoGap(page, '→ streak');
  await page.keyboard.press('ArrowLeft');
  await settle(page);
  await expectNoGap(page, '←');
  await page.keyboard.down('ArrowLeft');
  await page.keyboard.down('ArrowLeft');
  await page.keyboard.up('ArrowLeft');
  await settle(page);
  await expectNoGap(page, '← auto-repeat');
  expect(await prop(page, 'currentTime')).toBeGreaterThan(4);

  // Far forward on the seek bar: the start is evicted, the layer is at 30 s.
  await page.getByTestId('seek').evaluate((el: HTMLInputElement) => {
    el.value = '30';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle(page);
  await expectNoGap(page, 'seek bar → 30 s');
  await expectEvicted(page, 2, 15);

  // Back into what is still held (the window keeps 10 s behind), by a click on the bar.
  const box = (await page.getByTestId('screen').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('controls')).toBeVisible();
  const bar = (await page.getByTestId('seek').boundingBox())!;
  const xAt = (t: number) => bar.x + (bar.width * t) / DURATION;
  const y = bar.y + bar.height / 2;
  await page.mouse.click(xAt(25), y);
  await settle(page);
  expect(await prop(page, 'currentTime')).toBeGreaterThan(23);
  await expectNoGap(page, 'click back into held');

  // A drag far back, into what was evicted: downloaded again.
  await page.mouse.move(xAt(25), y);
  await page.mouse.down();
  await page.mouse.move(xAt(15), y, { steps: 4 });
  await page.mouse.move(xAt(4), y, { steps: 4 });
  await page.mouse.up();
  await settle(page);
  expect(await prop(page, 'currentTime')).toBeLessThan(8);
  await expectNoGap(page, 'drag back to 4 s');

  // Near the start and near the end.
  await seekTo(page, 0.2);
  await settle(page);
  await expectNoGap(page, 'near the start');
  await seekTo(page, 37.5);
  await settle(page);
  await expectNoGap(page, 'near the end');
  await expectEvicted(page, 2, 20);
  await expect(page.getByTestId('error')).toHaveCount(0);
});

test('the layer covers the playhead after a resume start', async ({ page }) => {
  await open(page);
  await seekTo(page, 20);
  await expect.poll(() => prop(page, 'currentTime'), { timeout: 20_000 }).toBeGreaterThan(21);
  await page.reload();
  await expect(page.getByTestId('status')).toContainText('movie.mkv');
  await expect(page.getByTestId('resume-toast')).toBeAttached({ timeout: 30_000 });
  await expect.poll(() => prop(page, 'currentTime'), { timeout: 30_000 }).toBeGreaterThan(19);
  await expectNoGap(page, 'resume');
});

test.describe('touch', () => {
  test.use({ hasTouch: true });

  /** `count` quick taps on a side of the picture (outer third, above the centre). */
  async function tapSide(page: Page, side: 'back' | 'forward', count: number) {
    const box = (await page.getByTestId('screen').boundingBox())!;
    const x = box.x + box.width * (side === 'back' ? 0.12 : 0.88);
    const y = box.y + box.height * 0.3;
    for (let i = 0; i < count; i++) {
      await page.touchscreen.tap(x, y);
      await page.waitForTimeout(80);
    }
  }

  test('the layer covers the playhead after centre ±5 s and double-tap streaks', async ({
    page,
  }) => {
    await open(page);
    const bar = page.getByTestId('controls');
    await expect(bar).toBeHidden({ timeout: 6_000 });

    // Double-tap streak forward (+5 +10 = 15 s), then back (−5 s).
    await tapSide(page, 'forward', 3);
    await expect.poll(() => prop(page, 'currentTime')).toBeGreaterThan(14);
    await settle(page);
    await expectNoGap(page, 'double-tap streak forward');
    await expect(page.getByTestId('seek-streak')).toHaveCount(0);
    await tapSide(page, 'back', 2);
    await settle(page);
    await expectNoGap(page, 'double-tap back');
    await expect(page.getByTestId('seek-streak')).toHaveCount(0);

    // Centre ±5 s buttons.
    const box = (await video(page).boundingBox())!;
    await video(page).tap({ position: { x: box.width / 2, y: box.height * 0.3 } });
    await expect(bar).toBeVisible();
    let before = await prop(page, 'currentTime');
    await page.getByTestId('seek-forward').tap();
    await page.getByTestId('seek-forward').tap();
    await expect.poll(() => prop(page, 'currentTime')).toBeGreaterThan(before + 9);
    await settle(page);
    await expectNoGap(page, 'centre +5 s ×2');
    if (!(await bar.isVisible())) {
      await video(page).tap({ position: { x: box.width / 2, y: box.height * 0.3 } });
    }
    before = await prop(page, 'currentTime');
    await page.getByTestId('seek-back').tap();
    await expect.poll(() => prop(page, 'currentTime')).toBeLessThan(before - 3);
    await settle(page);
    await expectNoGap(page, 'centre −5 s');
    await expect(page.getByTestId('error')).toHaveCount(0);
  });
});

test.describe('without an index', () => {
  test('MPEG-TS read at once: the layer covers the playhead and fills at the end', async ({
    page,
  }) => {
    await open(page, 'offset.ts', 'offset.ts', false);
    await expectNoGap(page, 'playing');
    await expect.poll(() => prop(page, 'ended'), { timeout: 30_000 }).toBe(true);
    await expect
      .poll(async () => {
        const { ranges } = await layer(page);
        const duration = await prop(page, 'duration');
        return ranges.length === 1 && ranges[0]![0] < 0.5 && ranges[0]![1] > duration - 0.5;
      })
      .toBe(true);
  });
});

test.describe('through the MP4 sample table', () => {
  test('VBR MP4 read at once: the layer covers the playhead in the low-bitrate half', async ({
    page,
  }) => {
    await open(page, 'vbr.mp4', 'vbr.mp4', false);
    await expectNoGap(page, 'start');
    await seekTo(page, 18);
    await settle(page);
    await expect.poll(() => prop(page, 'currentTime'), { timeout: 15_000 }).toBeGreaterThan(19);
    await expectNoGap(page, 'after a seek to 18 s');
    await seekTo(page, 4);
    await settle(page);
    await expectNoGap(page, 'back to 4 s');
    await expect(page.getByTestId('error')).toHaveCount(0);
  });

  test('VBR MP4 read in pieces: the layer covers the playhead across seeks and evictions', async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    await onLivePage(page, browser, async (page) => {
      await open(page, 'vbr.mp4', 'vbr.mp4');
      await expectNoGap(page, 'start');
      await page.keyboard.press('ArrowRight');
      await settle(page);
      await expectNoGap(page, '→');
      await seekTo(page, 22);
      await settle(page);
      await expect.poll(() => prop(page, 'currentTime'), { timeout: 15_000 }).toBeGreaterThan(23);
      await expectNoGap(page, 'far forward into the low-bitrate half');
      await expectEvicted(page, 1, 10);
      await seekTo(page, 3);
      await settle(page);
      await expectNoGap(page, 'far back into what was evicted');
      await seekTo(page, 28.5);
      await settle(page);
      await expectNoGap(page, 'near the end');
      await expect(page.getByTestId('error')).toHaveCount(0);
    });
  });
});

// The held range behind the playhead starts where its first byte's media does (ADR 0012 "Seek
// bar"): through the MP4 sample table, and through the MPEG-TS packets' positions, not the read
// cursor, which runs seconds of media ahead of what was produced. The truth: every frame's offset
// (e2e/support/byte-truth.ts). Measured every 0.5 s while playing on from a seek into the
// uneven-bitrate fixtures, once the window evicted the start.
for (const file of ['vbr.ts', 'vbr.mp4'] as const) {
  test(`${file}: the held range behind the playhead starts at its time after a seek`, async ({
    page,
    browserName,
  }) => {
    // vbr.ts with the small read cache trips WebKit's start flake (piece-window.spec.ts); without
    // it the file is read whole and nothing behind the playhead is ever evicted.
    test.skip(file === 'vbr.ts' && browserName === 'webkit', 'nothing evicted without the cache');
    test.setTimeout(90_000);
    const frames = await frameBytes(`e2e/fixtures/${file}`);
    await open(page, file, file);
    await seekTo(page, 13);
    await settle(page);
    const duration = await prop(page, 'duration');
    const errors: { at: number; drawn: number; truth: number }[] = [];
    for (let i = 0; i < 60 && (await prop(page, 'currentTime')) < 26; i++) {
      await page.waitForTimeout(500);
      const { at, ranges, held } = await heldLayer(page);
      const range = held.find(
        (r) => r.start > 0 && trueTimeAt(frames, r.start, duration) <= at && r.end > at,
      );
      const drawn = ranges.find(([s, e]) => s <= at + TOLERANCE_S && e > at);
      if (!range || !drawn) continue;
      errors.push({ at, drawn: drawn[0], truth: trueTimeAt(frames, range.start, duration) });
    }
    expect(errors.length).toBeGreaterThan(3);
    const off = (e: (typeof errors)[number]) => Math.abs(e.drawn - e.truth);
    const worst = errors.reduce((a, b) => (off(b) > off(a) ? b : a));
    expect(off(worst), JSON.stringify(worst)).toBeLessThan(1);
    await expect(page.getByTestId('error')).toHaveCount(0);
  });
}
