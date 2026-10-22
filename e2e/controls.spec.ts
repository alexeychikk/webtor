import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

const video = (page: Page) => page.getByTestId('video');
const prop = <K extends keyof HTMLVideoElement>(page: Page, k: K) =>
  video(page).evaluate((v: HTMLVideoElement, k) => v[k], k) as Promise<HTMLVideoElement[K]>;
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
/** Moves the pointer over the player, which shows the (auto-hiding) control layer (5 s; 1 s in fullscreen). */
async function wake(page: Page) {
  const box = (await page.getByTestId('screen').boundingBox())!;
  jitter = (jitter + 1) % 20;
  await page.mouse.move(box.x + box.width / 2 + jitter, box.y + box.height / 3);
}

/** A point on the picture away from the centre button, the title and the bar. */
const PICTURE = { x: 80, y: 120 };

async function playSample(page: Page) {
  const magnet = await fixtureMagnet('sample.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect.poll(() => prop(page, 'currentTime'), { timeout: 30_000 }).toBeGreaterThan(0.3);
}

/** Like iPhone Safari: no element fullscreen, only the video's own (`webkitEnterFullscreen`). */
async function emulateIphone(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false });
    Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { get: () => false });
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitEnterFullscreen', {
      configurable: true,
      value(this: HTMLVideoElement) {
        this.setAttribute('data-entered', '1');
      },
    });
  });
}

test('our control layer overlays the picture, with exactly one fullscreen control: an icon', async ({
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
  await expect(fullscreen).not.toHaveAttribute('title');
  await expect(fullscreen).toHaveText(''); // An icon, not a text label (no tooltip yet).
  await expect(fullscreen.locator('svg')).toBeVisible();
  // The bar overlays the bottom of the picture; the title strip its top.
  const [bar, pic] = await Promise.all(
    [page.getByTestId('controls'), video(page)].map((l) => l.boundingBox()),
  );
  expect(bar!.y + bar!.height).toBeCloseTo(pic!.y + pic!.height, 0);
  expect(bar!.y).toBeGreaterThan(pic!.y);
  expect(bar!.width).toBeCloseTo(pic!.width, 0);
  await expect(page.getByTestId('title')).toHaveText('sample.mkv');

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

test('double-clicking the picture toggles the same container fullscreen; a click plays/pauses', async ({
  page,
}) => {
  await playSample(page);
  await video(page).click({ position: PICTURE });
  await expect.poll(() => prop(page, 'paused')).toBe(true);
  await video(page).click({ position: PICTURE });
  await expect.poll(() => prop(page, 'paused')).toBe(false);

  await video(page).dblclick({ position: PICTURE });
  await expect.poll(() => fullscreenTestId(page)).toBe('screen');
  await expect(page.getByTestId('fullscreen')).toHaveAttribute('aria-pressed', 'true');
  // Two clicks: the play state is back where it was.
  await expect.poll(() => prop(page, 'paused')).toBe(false);
  await video(page).dblclick({ position: PICTURE });
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

test('play/pause, seek, mute and volume on the control bar; the centre play button', async ({
  page,
}) => {
  await playSample(page);
  const playPause = page.getByTestId('play-pause');
  const centre = page.getByTestId('centre');
  await wake(page);
  await expect(centre).toHaveAttribute('data-state', 'none');
  await expect(playPause).toHaveAttribute('aria-label', 'Pause video');
  await playPause.click();
  await expect.poll(() => prop(page, 'paused')).toBe(true);
  await expect(playPause).toHaveAttribute('aria-label', 'Play video');
  await expect(page.getByTestId('controls')).toHaveClass(/shown/);
  // Paused: a big play button in the centre of the picture.
  await expect(centre).toHaveAttribute('data-state', 'play');
  await centre.getByRole('button', { name: 'Play video' }).click();
  await expect.poll(() => prop(page, 'paused')).toBe(false);
  await expect(centre).toHaveAttribute('data-state', 'none');
  // The toggle flashes once. When the centre comes back to `none` later (a spinner, a pause that
  // didn't come from us), the flash doesn't replay.
  await expect(centre.locator('.flash')).toHaveCount(0);
  await video(page).evaluate((v: HTMLVideoElement) => v.pause());
  await expect(centre).toHaveAttribute('data-state', 'play');
  await video(page).evaluate((v: HTMLVideoElement) => v.play());
  await expect(centre).toHaveAttribute('data-state', 'none');
  await expect(centre.locator('.flash')).toHaveCount(0);
  await page.keyboard.press(' ');
  await expect.poll(() => prop(page, 'paused')).toBe(true);

  // The seek slider spans the whole file.
  const seek = page.getByTestId('seek');
  await expect.poll(() => seek.getAttribute('max').then(Number)).toBeCloseTo(12, 0);
  await setRange(page, 'seek', 6);
  await expect.poll(() => prop(page, 'currentTime')).toBeCloseTo(6, 0);
  await expect(page.getByTestId('time')).toHaveText(/^0:0[56] \/ 0:1[12]$/);

  // f/m still work with focus on a control-bar button (like native controls).
  await page.getByTestId('mute').focus();
  await page.keyboard.press('m');
  await expect.poll(() => prop(page, 'muted')).toBe(true);
  await page.getByTestId('mute').click();
  await expect.poll(() => prop(page, 'muted')).toBe(false);
  await setRange(page, 'volume', 0.5);
  await expect.poll(() => prop(page, 'volume')).toBeCloseTo(0.5, 2);
  // ↑/↓ change the volume by 0.1.
  await page.mouse.click(2, 2); // the page, outside the player
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => prop(page, 'volume')).toBeCloseTo(0.4, 2);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => prop(page, 'volume')).toBeCloseTo(0.6, 2);

  // Replay once it ended.
  await setRange(page, 'seek', 11.9);
  await video(page).evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => prop(page, 'ended'), { timeout: 10_000 }).toBe(true);
  await expect(centre).toHaveAttribute('data-state', 'replay');
  await expect(playPause).toHaveAttribute('aria-label', 'Replay');
});

test('the seek bar: downloaded and buffered layers, hover time, keys', async ({ page }) => {
  await playSample(page);
  await page.keyboard.press(' ');
  await expect.poll(() => prop(page, 'paused')).toBe(true);
  const width = (id: string) =>
    page
      .getByTestId(id)
      .evaluate((set) =>
        [...set.children].reduce((sum, el) => sum + el.getBoundingClientRect().width, 0),
      );
  // The small fixture downloads fully (pieces → seek bar), and MSE buffers part of it.
  await expect.poll(() => width('seek-downloaded'), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(() => width('seek-buffered')).toBeGreaterThan(0);

  const seek = page.getByTestId('seek');
  await seek.scrollIntoViewIfNeeded();
  const box = (await seek.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('seek-hover')).toHaveText(/^0:0[56]$/);

  await seek.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => prop(page, 'currentTime')).toBeLessThan(0.5);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => prop(page, 'currentTime')).toBeCloseTo(5, 0);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => prop(page, 'currentTime')).toBeLessThan(0.5);
});

test('every icon button has an aria-label and our tooltip (with its key), never a title', async ({
  page,
}) => {
  await playSample(page);
  await page.keyboard.press(' ');
  const screen = page.getByTestId('screen');
  const buttons = screen.getByRole('button');
  // The centre play button (the 4th) appears once the pause has landed.
  await expect(page.getByTestId('centre-button')).toBeVisible();
  expect(await buttons.count()).toBeGreaterThanOrEqual(4);
  for (const button of await buttons.all()) {
    await expect(button).toHaveAttribute('aria-label', /\S/);
    await expect(button).not.toHaveAttribute('title');
  }
  expect(await page.locator('[data-testid="screen"] [title]').count()).toBe(0);

  // Hover: after a short delay, label and shortcut chip; a press hides it.
  const playPause = page.getByTestId('play-pause');
  await playPause.hover();
  const tip = playPause.getByTestId('tooltip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Play video');
  await expect(tip.locator('kbd')).toHaveText('Space');
  await page.mouse.down();
  await expect(tip).toHaveCount(0);
  await page.mouse.up();

  // Keyboard focus shows it at once; Esc hides it.
  await page.mouse.click(2, 2); // the page, outside the player
  await page.getByTestId('mute').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const muteTip = page.getByTestId('mute').getByTestId('tooltip');
  await expect(muteTip).toContainText('Mute');
  await expect(muteTip.locator('kbd')).toHaveText('M');
  await page.keyboard.press('Escape');
  await expect(muteTip).toHaveCount(0);
});

test('while playing, the controls and cursor hide 5 s after the pointer rests (1 s in fullscreen) or when it leaves', async ({
  page,
}) => {
  await playSample(page);
  // The 12 s sample would end (and show the controls) during the waits.
  await video(page).evaluate((v: HTMLVideoElement) => (v.loop = true));
  const bar = page.getByTestId('controls');
  const title = page.getByTestId('title');
  const screen = page.getByTestId('screen');
  const leaveWindow = () =>
    page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));

  // Windowed: shown on a move, hidden once the pointer rests, and right away when it leaves.
  await wake(page);
  await expect(bar).toBeVisible();
  await expect(title).toBeVisible();
  await page.waitForTimeout(3_500);
  await expect(bar).toBeVisible();
  await page.waitForTimeout(2_000);
  await expect(bar).toBeHidden();
  await expect(title).toBeHidden();
  await expect(screen).toHaveClass(/idle/);
  await expect(screen).toHaveCSS('cursor', 'none');
  await wake(page);
  await expect(bar).toBeVisible();
  await leaveWindow();
  await expect(bar).toBeHidden({ timeout: 1_500 }); // At once, plus the fade.
  // Leaving the player (not the window) hides them too.
  await wake(page);
  await expect(bar).toBeVisible();
  const box0 = (await screen.boundingBox())!;
  await page.mouse.move(box0.x + 10, box0.y - 40);
  await expect(bar).toBeHidden({ timeout: 1_000 });

  // Focus doesn't keep them: a focused control hides with the rest.
  await page.getByTestId('mute').focus();
  await wake(page);
  await page.waitForTimeout(5_500);
  await expect(bar).toBeHidden();

  // Fullscreen: the same, and nothing but the picture stays drawn.
  await page.keyboard.press('f');
  await expect.poll(() => fullscreenTestId(page)).toBe('screen');
  await wake(page);
  await expect(bar).toBeVisible();
  await page.waitForTimeout(1_200);
  await expect(bar).toBeHidden();
  await expect(title).toBeHidden();
  await expect(screen).toHaveClass(/idle/);
  await expect(screen).toHaveCSS('cursor', 'none');
  await expect(page.getByText(/exit fullscreen/i)).toHaveCount(0);
  await wake(page);
  await expect(bar).toBeVisible();
  await expect(screen).not.toHaveClass(/idle/);
  await leaveWindow();
  await expect(bar).toBeHidden({ timeout: 1_500 }); // At once, plus the fade.
  // A key press shows it again.
  await page.keyboard.press('Shift');
  await expect(bar).toBeVisible();
  // Leaving fullscreen (no input) gives the running timer the windowed delay.
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => fullscreenTestId(page)).toBeNull();
  await page.waitForTimeout(2_000);
  await expect(bar).toBeVisible();
  await page.keyboard.press('f');
  await expect.poll(() => fullscreenTestId(page)).toBe('screen');

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

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('a tap shows or hides the controls and never plays/pauses; ±5 s buttons', async ({
    page,
  }) => {
    await playSample(page);
    await video(page).evaluate((v: HTMLVideoElement) => (v.loop = true));
    const bar = page.getByTestId('controls');
    const centre = page.getByTestId('centre');
    await expect(bar).toBeHidden({ timeout: 6_000 });
    // The middle third, above the centre row (a tap on a side may be half of a double-tap).
    const box = (await video(page).boundingBox())!;
    const MIDDLE = { x: box.width / 2, y: box.height * 0.3 };

    await video(page).tap({ position: MIDDLE });
    await expect(bar).toBeVisible();
    // Touch: play/pause sits in the centre, between the ±5 s buttons, not in the bar.
    await expect(centre).toHaveAttribute('data-state', 'pause');
    await expect(page.getByTestId('seek-back')).toBeVisible();
    await expect(page.getByTestId('seek-forward')).toBeVisible();
    await expect(page.getByTestId('play-pause')).toHaveCount(0);
    expect(await prop(page, 'paused')).toBe(false);

    await page.waitForTimeout(600); // Not a double-tap (that is fullscreen in the middle).
    await video(page).tap({ position: MIDDLE });
    await expect(bar).toBeHidden();
    await expect(centre).toHaveAttribute('data-state', 'none');
    expect(await prop(page, 'paused')).toBe(false);

    // Forward and back 5 s, then they hide by themselves 5 s after the last touch (windowed).
    await page.waitForTimeout(600); // Not a double-tap (that is fullscreen in the middle).
    await video(page).tap({ position: MIDDLE });
    const before = await prop(page, 'currentTime');
    await page.getByTestId('seek-forward').tap();
    await expect.poll(() => prop(page, 'currentTime')).toBeGreaterThan(before + 4);
    const ahead = await prop(page, 'currentTime');
    await page.getByTestId('seek-back').tap();
    const tapped = Date.now();
    await expect.poll(() => prop(page, 'currentTime')).toBeLessThan(ahead - 3);
    await page.waitForTimeout(3_500 - (Date.now() - tapped));
    await expect(bar).toBeVisible();
    await expect(bar).toBeHidden({ timeout: 3_000 });
    expect(await prop(page, 'paused')).toBe(false);
    expect(await fullscreenTestId(page)).toBeNull();
  });
});

test('iPhone-like (video-only fullscreen): our controls, the icon fullscreens the bare video', async ({
  page,
}) => {
  await emulateIphone(page);
  await playSample(page);
  await expect(video(page)).not.toHaveAttribute('controls');
  await wake(page);
  await expect(page.getByTestId('controls')).toBeVisible();
  await page.getByTestId('fullscreen').click();
  await expect(video(page)).toHaveAttribute('data-entered', '1');
  await expect(page.getByTestId('fullscreen')).toHaveAttribute('aria-label', 'Fullscreen');
});

test('without any fullscreen, our controls stay and there is no fullscreen control', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false });
    Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { get: () => false });
  });
  await playSample(page);
  await expect(video(page)).not.toHaveAttribute('controls');
  await expect(page.getByTestId('controls')).toHaveCount(1);
  await expect(page.getByTestId('fullscreen')).toHaveCount(0);
  await page.mouse.click(2, 2); // the page, outside the player
  await page.keyboard.press('f');
  await video(page).dblclick({ position: PICTURE });
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
  await page.mouse.click(2, 2); // the page, outside the player
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
  // The centre play button (shown while paused).
  if (!(await prop(page, 'paused'))) await spaceToggles(page);
  await page.getByTestId('centre-button').focus();
  await spaceToggles(page);
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
