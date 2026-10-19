import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

const video = (page: Page) => page.getByTestId('video');
const prop = <K extends keyof HTMLVideoElement>(page: Page, k: K) =>
  video(page).evaluate((v: HTMLVideoElement, k) => v[k as keyof HTMLVideoElement], k);
const fullscreenTestId = (page: Page) =>
  page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid') ?? null);

/** Drags a slider to `value` (what a user's drag ends in: input events, then change). */
async function setRange(page: Page, testId: string, value: number) {
  await page.getByTestId(testId).evaluate((el: HTMLInputElement, value) => {
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function playSample(page: Page) {
  const magnet = await fixtureMagnet('sample.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect.poll(() => prop(page, 'currentTime'), { timeout: 30_000 }).toBeGreaterThan(0.3);
}

test('our control bar replaces the native one, with exactly one fullscreen control: an icon', async ({
  page,
}) => {
  await playSample(page);
  // No native controls, so no disabled native fullscreen icon either.
  await expect(video(page)).not.toHaveAttribute('controls');
  await expect(video(page)).not.toHaveAttribute('controlslist');
  const fullscreen = page.getByRole('button', { name: /fullscreen/i });
  await expect(fullscreen).toHaveCount(1);
  await expect(fullscreen).toHaveAttribute('data-testid', 'fullscreen');
  await expect(fullscreen).toHaveAttribute('aria-label', 'Fullscreen');
  await expect(fullscreen).toHaveAttribute('title', 'Fullscreen (F)');
  await expect(fullscreen).toHaveText(''); // An icon, not a text label.
  await expect(fullscreen.locator('svg')).toBeVisible();
  // It sits in the control bar, right below the picture (so it never covers subtitles).
  const [bar, pic] = await Promise.all(
    [page.getByTestId('controls'), video(page)].map((l) => l.boundingBox()),
  );
  expect(bar!.y).toBeCloseTo(pic!.y + pic!.height, 0);
  expect(bar!.width).toBeCloseTo(pic!.width, 0);

  await page.getByTestId('screen').hover();
  await fullscreen.click();
  await expect.poll(() => fullscreenTestId(page)).toBe('screen');
  await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
  await expect(fullscreen).toHaveAttribute('aria-label', 'Exit fullscreen');
  // The bar is inside the fullscreen element, at the bottom of the screen.
  await expect
    .poll(async () => (await page.getByTestId('controls').boundingBox())?.width)
    .toBe(page.viewportSize()!.width);

  await fullscreen.click();
  await expect.poll(() => fullscreenTestId(page)).toBeNull();
  await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
  await expect(fullscreen).toHaveAttribute('aria-label', 'Fullscreen');
});

test('double-clicking the video toggles the same container fullscreen; a click plays/pauses', async ({
  page,
}) => {
  await playSample(page);
  await video(page).click();
  await expect.poll(() => prop(page, 'paused')).toBe(true);
  await video(page).click();
  await expect.poll(() => prop(page, 'paused')).toBe(false);

  await video(page).dblclick();
  await expect.poll(() => fullscreenTestId(page)).toBe('screen');
  await expect(page.getByTestId('fullscreen')).toHaveAttribute('aria-pressed', 'true');
  // Two clicks: the play state is back where it was.
  await expect.poll(() => prop(page, 'paused')).toBe(false);
  await video(page).dblclick();
  await expect.poll(() => fullscreenTestId(page)).toBeNull();
  await expect(page.getByTestId('fullscreen')).toHaveAttribute('aria-pressed', 'false');
});

test('leaving fullscreen another way (Esc, the browser) updates the icon', async ({ page }) => {
  await playSample(page);
  await page.keyboard.press('f');
  await expect.poll(() => fullscreenTestId(page)).toBe('screen');
  await expect(page.getByTestId('fullscreen')).toHaveAttribute('aria-pressed', 'true');
  // What Esc does: the browser leaves fullscreen and fires fullscreenchange.
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => fullscreenTestId(page)).toBeNull();
  await expect(page.getByTestId('fullscreen')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('fullscreen')).toHaveAttribute('aria-label', 'Fullscreen');
});

test('play/pause, seek, mute and volume on the control bar', async ({ page }) => {
  await playSample(page);
  const playPause = page.getByTestId('play-pause');
  await page.getByTestId('screen').hover();
  await expect(playPause).toHaveAttribute('aria-label', 'Pause video');
  await playPause.click();
  await expect.poll(() => prop(page, 'paused')).toBe(true);
  await expect(playPause).toHaveAttribute('aria-label', 'Play video');
  await expect(page.getByTestId('controls')).toHaveClass(/shown/);

  // The seek slider spans the whole file.
  const seek = page.getByTestId('seek');
  await expect.poll(() => seek.getAttribute('max').then(Number)).toBeCloseTo(12, 0);
  await setRange(page, 'seek', 6);
  await expect.poll(() => prop(page, 'currentTime')).toBeCloseTo(6, 0);
  await expect(page.getByTestId('time')).toHaveText(/^0:0[56] \/ 0:1[12]$/);

  // f/m still work with focus on a control-bar button (like native controls).
  await page.keyboard.press('m');
  await expect.poll(() => prop(page, 'muted')).toBe(true);
  await page.getByTestId('mute').click();
  await expect.poll(() => prop(page, 'muted')).toBe(false);
  await setRange(page, 'volume', 0.5);
  await expect.poll(() => prop(page, 'volume')).toBeCloseTo(0.5, 2);

  await playPause.click();
  await expect.poll(() => prop(page, 'paused')).toBe(false);
});

test('in fullscreen, the bar fades out while playing once the pointer rests, back on a move', async ({
  page,
}) => {
  await playSample(page);
  const bar = page.getByTestId('controls');
  // Below the picture outside fullscreen: always shown.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(3_000);
  await expect(bar).toHaveClass(/shown/);
  await page.keyboard.press('f');
  await expect.poll(() => fullscreenTestId(page)).toBe('screen');
  const box = (await page.getByTestId('screen').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await expect(bar).toHaveClass(/shown/);
  await expect(bar).not.toHaveClass(/shown/, { timeout: 6_000 });
  await expect(page.getByTestId('screen')).toHaveClass(/idle/);
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 3);
  await expect(bar).toHaveClass(/shown/);
});

test('without any fullscreen, the native controls stay and no fullscreen control is ours', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false });
    Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { get: () => false });
  });
  await playSample(page);
  await expect(video(page)).toHaveAttribute('controls');
  await expect(page.getByTestId('controls')).toHaveCount(0);
  await expect(page.getByTestId('fullscreen')).toHaveCount(0);
  await page.locator('h1').click();
  await page.keyboard.press('f');
  expect(await fullscreenTestId(page)).toBeNull();
});
