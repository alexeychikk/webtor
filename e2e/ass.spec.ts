import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

const video = (page: Page) => page.getByTestId('video');
const canvas = (page: Page) => page.getByTestId('ass-canvas');
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);

/** Pauses and seeks; JASSUB draws when the frame at the new position is shown. */
async function seekTo(page: Page, t: number) {
  await video(page).evaluate(
    (v: HTMLVideoElement, t) =>
      new Promise<void>((resolve) => {
        v.pause();
        v.addEventListener('seeked', () => resolve(), { once: true });
        v.currentTime = t;
      }),
    t,
  );
}

/** Non-transparent pixels on the overlay (its drawing comes from JASSUB's worker). */
const paintedPixels = (page: Page) =>
  canvas(page).evaluate((c: HTMLCanvasElement) => {
    const copy = document.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    if (!c.width || !c.height) return 0;
    const ctx = copy.getContext('2d')!;
    ctx.drawImage(c, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n++;
    return n;
  });

/** Text of the cues shown by native text tracks. */
const shownCues = (page: Page) =>
  video(page).evaluate((v: HTMLVideoElement) =>
    [...v.textTracks]
      .filter((t) => t.mode === 'showing')
      .flatMap((t) => [...(t.activeCues ?? [])].map((c) => (c as VTTCue).text)),
  );

async function playSample(page: Page) {
  const magnet = await fixtureMagnet('sample.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.3);
}

test('the Russian ASS track is drawn by JASSUB on the overlay canvas at 2–4 s, not as text', async ({
  page,
}) => {
  await playSample(page);
  await expect(canvas(page)).toHaveCount(0); // Nothing loaded before an ASS track is picked.
  await page.getByTestId('subtitles').selectOption({ label: 'Russian · ASS' });
  await expect(canvas(page)).toBeVisible({ timeout: 20_000 });
  await seekTo(page, 3);
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(100);
  expect(await shownCues(page)).toEqual([]);

  // No event at 5 s: the canvas is cleared.
  await seekTo(page, 5);
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBe(0);

  // Another track removes the overlay.
  await page.getByTestId('subtitles').selectOption({ label: 'English · SRT' });
  await expect(canvas(page)).toHaveCount(0);
  await expect(page.getByTestId('error')).toHaveCount(0);
  await expect(page.locator('[data-testid="notice"][data-code="subtitle-failed"]')).toHaveCount(0);
});

test('the subtitle delay moves the styled ASS overlay too', async ({ page }) => {
  await playSample(page);
  await page.getByTestId('subtitles').selectOption({ label: 'Russian · ASS' });
  await expect(canvas(page)).toBeVisible({ timeout: 20_000 });
  await seekTo(page, 3);
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(100);

  // +2 s: the 2–4 s event is drawn at 4–6 s (redrawn at once while paused).
  for (let i = 0; i < 4; i++) await page.getByTestId('subtitle-delay-plus').click();
  await expect(page.getByTestId('subtitle-delay')).toHaveAttribute('data-delay', '2');
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBe(0);
  await seekTo(page, 5);
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(100);
  expect(await shownCues(page)).toEqual([]);

  await page.getByTestId('subtitle-delay-reset').click();
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBe(0);
  await seekTo(page, 3);
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(100);
});

test('the fullscreen icon fullscreens the player container, and the overlay stays drawn', async ({
  page,
}) => {
  await playSample(page);
  await page.getByTestId('subtitles').selectOption({ label: 'Russian · ASS' });
  await expect(canvas(page)).toBeVisible({ timeout: 20_000 });
  await seekTo(page, 3);
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(100);

  // A native control would fullscreen the bare video (hiding the canvas): our control bar replaces it.
  await expect(video(page)).not.toHaveAttribute('controls');
  await page.getByTestId('screen').hover();
  await page.getByTestId('fullscreen').click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid')))
    .toBe('screen');
  await expect(page.getByTestId('fullscreen')).toHaveAttribute('aria-pressed', 'true');
  // The canvas sits inside the fullscreen element, over the (now larger) video.
  expect(await canvas(page).evaluate((c) => document.fullscreenElement?.contains(c) ?? false)).toBe(
    true,
  );
  await expect(canvas(page)).toBeVisible();
  await expect
    .poll(async () => {
      const [v, c] = await Promise.all([video(page), canvas(page)].map((l) => l.boundingBox()));
      return !!v && !!c && c.width >= v.width / 2 && c.width <= v.width + 1;
    })
    .toBe(true);
  await seekTo(page, 3.2);
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(100);
  expect(await shownCues(page)).toEqual([]);

  await page.getByTestId('fullscreen').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(canvas(page)).toBeVisible();

  // A double-click on the picture does the same (away from the centre play button).
  await video(page).dblclick({ position: { x: 80, y: 120 } });
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid')))
    .toBe('screen');
  await expect(canvas(page)).toBeVisible();
  await seekTo(page, 3);
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(100);
  // The control bar sits over the canvas, not under it.
  const z = (testId: string) =>
    page.getByTestId(testId).evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);
  expect(await z('controls')).toBeGreaterThan(await z('ass-canvas'));
  await page.keyboard.press('f');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
});

const UPLOADED_ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Top,Some Missing Font,36,&H0000FFFF,&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,2,0,8,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:05.00,Top,,0,0,0,,{\\pos(320,40)}Uploaded ASS
`;

test('an uploaded .ass file is drawn styled too', async ({ page }) => {
  await playSample(page);
  await page.getByTestId('subtitle-upload').setInputFiles({
    name: 'mine.ass',
    mimeType: 'text/x-ssa',
    buffer: Buffer.from(UPLOADED_ASS),
  });
  await expect(page.getByTestId('subtitles')).toHaveValue('upload:1');
  await expect(canvas(page)).toBeVisible({ timeout: 20_000 });
  await seekTo(page, 2);
  await expect.poll(() => paintedPixels(page), { timeout: 15_000 }).toBeGreaterThan(100);
  expect(await shownCues(page)).toEqual([]);
});

test('without container fullscreen (iOS), ASS is shown as plain text under our controls', async ({
  page,
}) => {
  // Like iPhone Safari: no element fullscreen, only the video's own (`webkitEnterFullscreen`).
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false });
    Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { get: () => false });
    if (!('webkitEnterFullscreen' in HTMLVideoElement.prototype)) {
      Object.defineProperty(HTMLVideoElement.prototype, 'webkitEnterFullscreen', {
        value() {},
      });
    }
  });
  await playSample(page);
  // Our controls there too; their fullscreen icon is the video's own fullscreen.
  await expect(video(page)).not.toHaveAttribute('controls');
  await expect(page.getByTestId('controls')).toHaveCount(1);
  await expect(page.getByTestId('fullscreen')).toHaveCount(1);
  // `f` enters the video's own fullscreen.
  await video(page).evaluate((v) => {
    Object.defineProperty(v, 'webkitEnterFullscreen', {
      value: () => v.setAttribute('data-entered', '1'),
    });
  });
  await page.locator('h1').click();
  await page.keyboard.press('f');
  await expect(video(page)).toHaveAttribute('data-entered', '1');
  await page.getByTestId('subtitles').selectOption({ label: 'Russian · ASS' });
  await seekTo(page, 3);
  await expect.poll(() => shownCues(page)).toEqual(['Привет из ASS']);
  await expect(canvas(page)).toHaveCount(0);
});
