import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';
import { closeMenu, openMenu } from './support/player';

// HDR video (docs/decisions/0010): hdr10-av1.mkv is AV1 10-bit tagged BT.2020/PQ, which Chromium
// plays without HEVC. Headless Chromium reports an SDR display.

const toast = (page: Page) => page.locator('[data-testid="notice"][data-code="hdr-sdr-display"]');

async function open(page: Page, name: string) {
  const magnet = await fixtureMagnet(name);
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByTestId('status')).toContainText(name);
  const video = page.getByTestId('video');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(0.5);
  await expect(page.getByTestId('error')).toHaveCount(0);
  await video.evaluate((v: HTMLVideoElement) => v.pause());
}

test('an HDR10 video on an SDR display: chip and tone-mapped toast', async ({ page }) => {
  await open(page, 'hdr10-av1.mkv');
  expect(await page.evaluate(() => matchMedia('(dynamic-range: high)').matches)).toBe(false);
  await expect(toast(page)).toBeVisible();
  await expect(toast(page)).toContainText('HDR video on an SDR display');
  await expect(toast(page)).toContainText('turn on HDR in your OS display settings');

  const stats = await openMenu(page, 'stats-button');
  await expect(stats.getByTestId('stats-hdr')).toHaveText('HDR10');
  await expect(stats.getByTestId('stats-hdr')).toHaveAttribute('data-format', 'hdr10');
  await expect(stats.getByTestId('stats-hdr-tone-mapped')).toBeVisible();
  await closeMenu(page);

  // The toast's help link opens the help dialog at its HDR section.
  await toast(page).getByTestId('hdr-help-link').click();
  await expect(page.getByTestId('why-dialog')).toBeVisible();
  await expect(page.getByTestId('hdr-help')).toBeInViewport();
  await expect(page.getByTestId('hdr-help')).toContainText('Use HDR');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('why-dialog')).toBeHidden();

  // Dismissable.
  await toast(page).getByTestId('notice-dismiss').click();
  await expect(toast(page)).toHaveCount(0);
});

test('the toast goes once the display turns HDR', async ({ page }) => {
  // Headless Chromium can't switch its display: a stand-in `(dynamic-range: high)` query.
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    const query = new EventTarget() as MediaQueryList & { matches: boolean };
    Object.assign(query, { matches: false, media: '(dynamic-range: high)' });
    (window as unknown as { __setHdrDisplay: (on: boolean) => void }).__setHdrDisplay = (on) => {
      query.matches = on;
      query.dispatchEvent(new Event('change'));
    };
    window.matchMedia = (q: string) => (q === '(dynamic-range: high)' ? query : real(q));
  });
  await open(page, 'hdr10-av1.mkv');
  await expect(toast(page)).toBeVisible();
  const setDisplay = (on: boolean) =>
    page.evaluate(
      (v) => (window as unknown as { __setHdrDisplay: (on: boolean) => void }).__setHdrDisplay(v),
      on,
    );

  await setDisplay(true);
  await expect(toast(page)).toHaveCount(0);
  const stats = await openMenu(page, 'stats-button');
  await expect(stats.getByTestId('stats-hdr')).toHaveText('HDR10');
  await expect(stats.getByTestId('stats-hdr-tone-mapped')).toHaveCount(0);
  await closeMenu(page);

  await setDisplay(false);
  await expect(toast(page)).toBeAttached();
});

test('an SDR video gets neither chip nor toast', async ({ page }) => {
  await open(page, 'sample.mkv');
  const stats = await openMenu(page, 'stats-button');
  await expect(stats.getByTestId('stats-peers')).toBeVisible();
  await expect(stats.getByTestId('stats-hdr')).toHaveCount(0);
  await closeMenu(page);
  await expect(toast(page)).toHaveCount(0);
});
