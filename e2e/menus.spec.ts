import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';
import { closeMenu, openMenu, wakeControls } from './support/player';

// In-player menus (docs/decisions/0008 §4): panels inside the player, a bottom sheet on short
// screens, keyboard-operable as listboxes.

const video = (page: Page) => page.getByTestId('video');
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);

async function playFixture(page: Page, name: string) {
  const magnet = await fixtureMagnet(name);
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
}

/** Paused: the controls stay shown, so keyboard steps don't race their auto-hide. */
const pause = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.pause());

test('the subtitles menu works by keyboard alone', async ({ page }) => {
  await playFixture(page, 'sample.mkv');
  await pause(page);
  const trigger = page.getByTestId('subtitles');
  await expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.focus();

  // Enter opens it with the focus on the selected option (Off).
  await page.keyboard.press('Enter');
  const menu = page.getByTestId('subtitles-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('data-presentation', 'panel');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const options = menu.getByTestId('subtitle-option');
  await expect(options.first()).toBeFocused();
  await expect(options.first()).toHaveAttribute('data-value', '');

  // ↓ moves the focus without selecting; Enter selects and closes.
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toBeFocused();
  await expect(trigger).toHaveAttribute('data-value', '');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAttribute('data-value', 'embedded:4');
  await expect(trigger).toBeFocused();

  // ↓ on the trigger opens it too, on the new selection; End and Home jump; Esc closes and
  // gives the focus back to the trigger.
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toBeFocused();
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(options.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(options.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('data-value', 'embedded:4');
  // Esc closed the menu only: the page is not left fullscreen or otherwise changed.
  await expect(page.getByTestId('status')).toHaveAttribute('data-phase', /playing|paused/);
});

test('one menu at a time; a press outside closes it; the controls stay up while open', async ({
  page,
}) => {
  await playFixture(page, 'sample.mkv');
  await openMenu(page, 'subtitles');
  // An open menu pins the control layer, even while playing and the pointer is still.
  await page.waitForTimeout(1_500);
  await expect(page.getByTestId('controls')).toHaveClass(/shown/);
  await page.getByTestId('audio-track').click();
  await expect(page.getByTestId('audio-menu')).toBeVisible();
  await expect(page.getByTestId('subtitles-menu')).toHaveCount(0);
  await expect(page.locator('[data-player-menu]')).toHaveCount(1);

  const paused = await video(page).evaluate((v: HTMLVideoElement) => v.paused);
  await page.locator('h1').click();
  await expect(page.locator('[data-player-menu]')).toHaveCount(0);
  // Closing by a press outside doesn't count as a click on the picture.
  expect(await video(page).evaluate((v: HTMLVideoElement) => v.paused)).toBe(paused);
});

test('the stats chip opens the stats panel', async ({ page }) => {
  await playFixture(page, 'sample.mkv');
  const panel = await openMenu(page, 'stats-button');
  await expect(panel.getByTestId('stats-peers')).toHaveText(/^\d+/);
  await expect(panel.getByTestId('stats-progress')).toHaveText(/%$/);
  await closeMenu(page);
  await expect(page.getByTestId('stats-button')).toBeFocused();
});

test('when the clipboard refuses, the share panel shows the link to copy by hand', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      get: () => ({
        writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
      }),
    });
  });
  await playFixture(page, 'sample.mkv');
  await wakeControls(page);
  await page.getByTestId('share-link').click();
  await expect(page.getByTestId('share-link')).toHaveAttribute('data-state', 'failed');
  const panel = page.getByTestId('share-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('share-url')).toHaveValue(page.url());
});

test('on a phone, menus are bottom sheets and More holds audio, files, stats and share', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await playFixture(page, 'multi-file');
  await expect(page.getByTestId('audio-track')).toHaveCount(0);

  // The subtitles menu: a modal sheet; a tap on the backdrop closes it.
  await openMenu(page, 'subtitles');
  const sheet = page.locator('dialog[data-player-menu]');
  await expect(sheet).toHaveAttribute('data-presentation', 'sheet');
  await page.mouse.click(180, 20);
  await expect(page.locator('[data-player-menu]')).toHaveCount(0);

  // More › Audio, Back to More, Close.
  const more = await openMenu(page, 'more-button');
  await expect(more.getByTestId('more-sound')).toHaveAttribute('role', 'switch');
  await expect(more.getByTestId('more-audio')).toHaveAccessibleName(/^Audio: English AAC/);
  await more.getByTestId('more-audio').click();
  const audio = page.getByTestId('audio-menu');
  await expect(audio).toBeVisible();
  await expect(audio.getByTestId('audio-option')).toHaveCount(2);
  await audio.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('more-menu')).toBeVisible();
  await page.getByTestId('more-menu').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('[data-player-menu]')).toHaveCount(0);
  await expect(page.getByTestId('more-button')).toBeFocused();

  // The Sound switch mutes, like M.
  await openMenu(page, 'more-button');
  await page.getByTestId('more-sound').click();
  expect(await video(page).evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
});
