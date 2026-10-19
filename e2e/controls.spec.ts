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

let jitter = 0;
/** Moves the pointer over the player, which shows the (auto-hiding) control bar for 1 s. */
async function wake(page: Page) {
  const box = (await page.getByTestId('screen').boundingBox())!;
  jitter = (jitter + 1) % 20;
  await page.mouse.move(box.x + box.width / 2 + jitter, box.y + box.height / 3);
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
  await wake(page);
  // No native controls, so no disabled native fullscreen icon either.
  await expect(video(page)).not.toHaveAttribute('controls');
  await expect(video(page)).not.toHaveAttribute('controlslist');
  // Exactly one fullscreen control. The rest uses the test id: a role locator skips the bar while
  // it auto-hides (Firefox can take a while to leave fullscreen).
  await expect(page.getByRole('button', { name: /fullscreen/i })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /fullscreen/i })).toHaveAttribute(
    'data-testid',
    'fullscreen',
  );
  const fullscreen = page.getByTestId('fullscreen');
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

  await wake(page);
  await fullscreen.click();
  await expect.poll(() => fullscreenTestId(page)).toBe('screen');
  // Leaving is by the same icon (or Esc, f, double-click): no "Exit fullscreen" text over the video.
  await expect(page.getByText(/exit fullscreen/i)).toHaveCount(0);
  await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
  await expect(fullscreen).toHaveAttribute('aria-label', 'Exit fullscreen');
  // The bar is inside the fullscreen element, at the bottom of the screen.
  await expect
    .poll(() =>
      page.getByTestId('controls').evaluate((bar) => {
        const fs = document.fullscreenElement?.getBoundingClientRect();
        const b = bar.getBoundingClientRect();
        return !!fs && b.width === fs.width && Math.abs(b.bottom - fs.bottom) < 1;
      }),
    )
    .toBe(true);

  await wake(page);
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
  await wake(page);
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

test('while playing, the bar and cursor hide 1 s after the pointer rests or leaves, in fullscreen too', async ({
  page,
}) => {
  await playSample(page);
  const bar = page.getByTestId('controls');
  const screen = page.getByTestId('screen');
  const leaveWindow = () =>
    page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));

  // Windowed: shown on a move, hidden once the pointer rests, and right away when it leaves.
  await wake(page);
  await expect(bar).toBeVisible();
  await page.waitForTimeout(1_200);
  await expect(bar).toBeHidden();
  await expect(screen).toHaveClass(/idle/);
  await wake(page);
  await expect(bar).toBeVisible();
  await leaveWindow();
  await expect(bar).toBeHidden({ timeout: 1_500 }); // At once, plus the 0.25 s fade.

  // Fullscreen: the same, and nothing but the picture stays drawn.
  await page.keyboard.press('f');
  await expect.poll(() => fullscreenTestId(page)).toBe('screen');
  await wake(page);
  await expect(bar).toBeVisible();
  await page.waitForTimeout(1_200);
  await expect(bar).toBeHidden();
  await expect(screen).toHaveClass(/idle/);
  await expect(screen).toHaveCSS('cursor', 'none');
  await expect(page.getByText(/exit fullscreen/i)).toHaveCount(0);
  await wake(page);
  await expect(bar).toBeVisible();
  await expect(screen).not.toHaveClass(/idle/);
  await leaveWindow();
  await expect(bar).toBeHidden({ timeout: 1_500 }); // At once, plus the 0.25 s fade.
  // A key press shows it again.
  await page.keyboard.press('Shift');
  await expect(bar).toBeVisible();

  // Kept while the pointer is over the bar, and while paused.
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 5);
  await page.waitForTimeout(1_500);
  await expect(bar).toBeVisible();
  await page.keyboard.press(' ');
  await expect.poll(() => prop(page, 'paused')).toBe(true);
  await leaveWindow();
  await page.waitForTimeout(1_500);
  await expect(bar).toBeVisible();
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

/** Presses Space and checks the play state flipped once and stays so (no double toggle). */
async function spaceToggles(page: Page) {
  const before = await prop(page, 'paused');
  await page.keyboard.press(' ');
  await expect.poll(() => prop(page, 'paused')).toBe(!before);
  await page.waitForTimeout(500);
  expect(await prop(page, 'paused')).toBe(!before);
}

test('one Space press toggles play/pause exactly once, with focus on the page, video or a control', async ({
  page,
}) => {
  await playSample(page);
  await page.locator('h1').click();
  await spaceToggles(page);
  await spaceToggles(page);

  await video(page).focus();
  await spaceToggles(page);
  await spaceToggles(page);

  for (const id of ['play-pause', 'mute', 'fullscreen', 'seek']) {
    await page.getByTestId(id).focus();
    await spaceToggles(page);
    await spaceToggles(page);
  }
  expect(await prop(page, 'muted')).toBe(false);
  expect(await fullscreenTestId(page)).toBeNull();

  // Space still types in text fields.
  const magnet = page.getByLabel('Magnet link or info hash');
  await magnet.fill('');
  await magnet.press('a');
  await magnet.press(' ');
  await magnet.press('b');
  await expect(magnet).toHaveValue('a b');
});

test('one Space press toggles once on the native controls too (iOS-like, no container fullscreen)', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false });
    Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { get: () => false });
  });
  await playSample(page);
  await expect(video(page)).toHaveAttribute('controls');
  await video(page).focus();
  await spaceToggles(page);
  await spaceToggles(page);
  // A click on the video's own play button focuses it, then Space.
  await video(page).click({ position: { x: 20, y: 20 } });
  await page.waitForTimeout(300);
  await spaceToggles(page);
  await spaceToggles(page);
});
