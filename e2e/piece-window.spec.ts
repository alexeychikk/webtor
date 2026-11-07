import { statSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { covers, expectEvicted, expectNoGap, layer } from './support/downloaded';
import { fixtureMagnet } from './support/fixtures';

// e2e/fixtures/resume/movie.mkv: 40 s, the largest file of the `resume` torrent (ADR 0012).
// vbr.mp4 / vbr.ts: 30 s, 93 % of the bytes in the first 15 s; vbr.ts has no index (seeks probe).

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

/**
 * The piece-window settings: a small demuxer cache, 4 s ahead and no slack around the reads.
 * `smallCache: false` keeps Mediabunny's own cache, which reads a small file whole.
 */
function windowed(page: Page, smallCache = true) {
  return page.addInitScript((small) => {
    localStorage.setItem('webtor:buffer-ahead-s', '4');
    localStorage.setItem('webtor:read-slack-bytes', '0');
    if (small) localStorage.setItem('webtor:read-cache-bytes', String(64 * 1024));
    localStorage.setItem('webtor:subtitle-language', 'off');
  }, smallCache);
}

/**
 * 3 s more play, and the layer covers the playhead at every check (`layer`). The end of the media
 * ends the checks.
 */
async function expectPlaysOn(page: Page, what: string, checkLayer: boolean) {
  if (checkLayer) await expectNoGap(page, what);
  const until = (await currentTime(page)) + 3;
  await expect
    .poll(
      async () => {
        const [now, ended] = await Promise.all([
          layer(page),
          video(page).evaluate((v: HTMLVideoElement) => v.ended),
        ]);
        if (checkLayer && !ended) {
          expect(
            covers(now),
            `${what}: gap at ${now.at.toFixed(2)} s in ${JSON.stringify(now.ranges)}`,
          ).toBe(true);
        }
        return ended || now.at >= until;
      },
      { message: `${what}: plays on`, timeout: 20_000, intervals: [400] },
    )
    .toBe(true);
}

// `far`: the seek target (s); `ahead`: media past what plays after the seek back, held before.
// After a seek Mediabunny's packet queue holds what was taken in the last second of the burst, so
// the reads run ~10 s past the appends; vbr.mp4's sparse tail is ~2.6 s per 16 KiB piece.
for (const [fixture, file, far, ahead] of [
  ['resume', 'movie.mkv', 30, [31, 34]],
  ['vbr.mp4', 'vbr.mp4', 13, [27, 30]],
  ['vbr.ts', 'vbr.ts', 13, [20, 25]],
] as const) {
  test(`${file}: far seeks complete, play on and keep the bytes at the playhead`, async ({
    page,
    browserName,
  }) => {
    // WebKit's GStreamer start (CLAUDE.md "The start") with vbr.ts, 4 s ahead and the small cache
    // blocks the page or never completes the gap jump in 1 open in 4 (on main too; each setting
    // alone starts 8 of 8). There it plays with Mediabunny's cache, which reads the file whole:
    // the seeks are checked, the window's evictions and the layer on the other fixtures.
    const tsOnWebKit = file === 'vbr.ts' && browserName === 'webkit';
    const checkLayer = !tsOnWebKit;
    test.setTimeout(90_000);
    await windowed(page, !tsOnWebKit);
    const magnet = await fixtureMagnet(fixture);
    await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
    await expect(page.getByTestId('status')).toContainText(file);
    await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);

    await seekTo(page, far);
    await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(far + 1);
    await expectPlaysOn(page, `far forward to ${far} s`, checkLayer);
    // The MPEG-TS demuxer reads the small file whole at the start, and the window then keeps
    // its seek's probes, from the start of the file, for KEEP_BEHIND_S.
    if (file !== 'vbr.ts') await expectEvicted(page, 1, 8);

    await seekTo(page, 2);
    await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(3);
    await expectPlaysOn(page, 'far back to 2 s', checkLayer);
    await video(page).evaluate((v: HTMLVideoElement) => v.pause());
    if (!tsOnWebKit) await expectEvicted(page, ahead[0], ahead[1]);
    await expect(page.getByTestId('error')).toHaveCount(0);
  });
}

test('a resume keeps the window around the resume point from its first tick', async ({ page }) => {
  await windowed(page);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __keeps: { t: number; seeking: boolean; keep: { start: number; end: number } | null }[];
    };
    w.__keeps = [];
    Object.defineProperty(window, '__webtorKeepRange', {
      configurable: true,
      set(keep) {
        const v = document.querySelector<HTMLVideoElement>('[data-testid="video"]');
        if (v) w.__keeps.push({ t: v.currentTime, seeking: v.seeking, keep });
      },
      get: () => w.__keeps.at(-1)?.keep,
    });
  });
  await open(page);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
  await seekTo(page, 24);
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(25);
  await page.reload();
  await expect(page.getByTestId('status')).toContainText('movie.mkv');
  await expect(page.getByTestId('resume-toast')).toBeAttached({ timeout: 30_000 });
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(24);

  const size = statSync('e2e/fixtures/resume/movie.mkv').size;
  const ticks = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __keeps: { t: number; seeking: boolean; keep: { start: number; end: number } | null }[];
          }
        ).__keeps,
    );
  await expect.poll(async () => (await ticks()).some((k) => k.t > 22 && !k.seeking)).toBe(true);
  const keeps = await ticks();
  const first = keeps.find((k) => k.t > 22 && !k.seeking);
  // From the resume point's bytes: none before it were read since the start.
  expect(first!.keep, JSON.stringify(keeps)).not.toBeNull();
  expect(first!.keep!.start, JSON.stringify(keeps)).toBeGreaterThan(size * 0.4);
  await expectNoGap(page, 'resume');
});
