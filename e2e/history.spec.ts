import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_BASE, fixtureMagnet } from './support/fixtures';
import { openMenu } from './support/player';

// Watch history (docs/decisions/0010). e2e/fixtures/resume = movie.mkv (40 s, the largest, opens
// first) + extra.mkv (sample.mkv, 12 s): a multi-file torrent. sample.mkv alone is single-file.

const video = (page: Page) => page.getByTestId('video');
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);
const seekTo = (page: Page, t: number) =>
  video(page).evaluate((v: HTMLVideoElement, to) => {
    v.currentTime = to;
  }, t);
const dialog = (page: Page) => page.getByTestId('history-dialog');
const entries = (page: Page) => page.getByTestId('history-entry');

async function play(page: Page, magnet: string, file: string) {
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByTestId('status')).toContainText(file);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
}

/** Plays movie.mkv to 20 s and pauses there (the pause saves the position). */
async function watchMovieTo20(page: Page) {
  await play(page, await fixtureMagnet('resume'), 'movie.mkv');
  await seekTo(page, 20);
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(20.2);
  await video(page).evaluate((v: HTMLVideoElement) => v.pause());
}

async function openHistory(page: Page) {
  await page.getByTestId('history-button').click();
  await expect(dialog(page)).toBeVisible();
}

test('a watched video is listed after a reload and resumes where it stopped', async ({ page }) => {
  await watchMovieTo20(page);
  await page.reload();
  await expect(page.getByTestId('status')).toContainText('movie.mkv');
  // Home (the wordmark) stops it: the hero, then the history from the keyboard.
  await page.locator('.brand a').click();
  await expect(page.getByTestId('video')).toBeHidden();
  // `H` from the page (a focused link keeps its keys).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('h');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute('data-state', 'list');
  const entry = entries(page).first();
  await expect(entry).toHaveAttribute('data-state', 'progress');
  await expect(entry).toContainText('resume');
  // Multi-file: the file name is the second line.
  await expect(entry).toContainText('movie.mkv');
  await expect(entry).toContainText(/0:2\d \/ 0:40/);
  await expect(entry).toContainText(/Just now|min ago/);
  await expect(entry).toBeFocused();
  await expect(entry).toHaveAccessibleName(/^resume, movie\.mkv, stopped at 0:2\d of 0:40, /);

  await entry.click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByTestId('status')).toContainText('movie.mkv');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(19.5);
  await expect(page.getByTestId('resume-toast')).toContainText(/Resumed at 0:2\d/);
  await expect(page).toHaveURL(/&file=\d$/);

  // Open now: the row says so, and picking it changes nothing.
  await openHistory(page);
  await expect(entries(page).first()).toHaveAttribute('data-state', 'playing');
  await expect(entries(page).first()).toContainText('Now playing');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByTestId('history-button')).toBeFocused();
});

test('picking an entry while another video plays switches to it; a finished one shows watched', async ({
  page,
}) => {
  await watchMovieTo20(page);
  // Another file of the same torrent, played to its end.
  await openMenu(page, 'files-button');
  await page.getByTestId('file').filter({ hasText: 'extra.mkv' }).click();
  await expect(page.getByTestId('status')).toContainText('extra.mkv');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
  await seekTo(page, 10.5);
  await expect
    .poll(() => video(page).evaluate((v: HTMLVideoElement) => v.ended), {
      timeout: 30_000,
    })
    .toBe(true);

  // Another torrent plays now.
  await play(page, await fixtureMagnet('sample.mkv'), 'sample.mkv');
  await openHistory(page);
  await expect(entries(page)).toHaveCount(3);
  const [first, second, third] = [entries(page).nth(0), entries(page).nth(1), entries(page).nth(2)];
  await expect(first).toHaveAttribute('data-state', 'playing');
  // Single-file: the file name only, no second line.
  await expect(first.locator('.file')).toHaveCount(0);
  await expect(second).toHaveAttribute('data-state', 'watched');
  await expect(second).toContainText('extra.mkv');
  await expect(second).toContainText('Watched');
  await expect(third).toContainText('movie.mkv');

  await third.click();
  await expect(page.getByTestId('status')).toContainText('movie.mkv');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(19.5);

  // The same torrent's other file: a file switch; the watched one starts over.
  await openHistory(page);
  await entries(page).filter({ hasText: 'extra.mkv' }).click();
  await expect(page.getByTestId('status')).toContainText('extra.mkv');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.3);
  expect(await currentTime(page)).toBeLessThan(5);
  await expect(page.getByTestId('error')).toHaveCount(0);
});

test('remove with undo, and clear with confirmation, keep the other settings', async ({ page }) => {
  await watchMovieTo20(page);
  await play(page, await fixtureMagnet('sample.mkv'), 'sample.mkv');
  await page.evaluate(() => {
    localStorage.setItem('webtor:relay-url', 'http://127.0.0.1:1/');
    localStorage.setItem('webtor:subtitle-language', 'en');
  });
  await page.locator('.brand a').click();
  await openHistory(page);
  await expect(entries(page)).toHaveCount(2);
  const movie = page.locator('li').filter({ hasText: 'movie.mkv' });

  // Remove → Undo → remove.
  await movie.getByTestId('history-remove').click();
  await expect(entries(page)).toHaveCount(1);
  await expect(entries(page).first()).toBeFocused();
  await expect(page.getByTestId('history-undo')).toBeVisible();
  await page.getByTestId('history-undo').click();
  await expect(entries(page)).toHaveCount(2);
  await expect(entries(page).filter({ hasText: 'movie.mkv' })).toContainText(/0:2\d \/ 0:40/);
  await movie.getByTestId('history-remove').click();
  await expect(entries(page)).toHaveCount(1);
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.filter((k) => k.startsWith('webtor:watch:'))).toHaveLength(1);

  // Clear → Cancel → Clear.
  await page.getByTestId('history-clear').click();
  await expect(page.getByTestId('history-clear-cancel')).toBeFocused();
  await expect(dialog(page)).toContainText('Forget all 1 video and where you stopped?');
  await page.getByTestId('history-clear-cancel').click();
  await expect(entries(page)).toHaveCount(1);
  await page.getByTestId('history-clear').click();
  await page.getByTestId('history-clear-confirm').click();
  await expect(dialog(page)).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId('history-empty')).toContainText('Nothing watched yet');
  await expect(page.getByTestId('history-close')).toBeFocused();
  const left = await page.evaluate(() => ({
    relay: localStorage.getItem('webtor:relay-url'),
    lang: localStorage.getItem('webtor:subtitle-language'),
    watch: Object.keys(localStorage).filter((k) => k.startsWith('webtor:watch')),
  }));
  expect(left).toEqual({ relay: 'http://127.0.0.1:1/', lang: 'en', watch: [] });

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByTestId('history-button')).toBeFocused();
  await page.reload();
  await openHistory(page);
  await expect(dialog(page)).toHaveAttribute('data-state', 'empty');
});

test('an opened .torrent reopens from history after a reload, from its stored bytes', async ({
  page,
}) => {
  const res = await fetch(`${FIXTURE_BASE}/sample.mkv.torrent`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await page.goto('./');
  await page.getByTestId('torrent-file').setInputFiles({
    name: 'sample.mkv.torrent',
    mimeType: 'application/x-bittorrent',
    buffer,
  });
  await expect(page.getByTestId('status')).toContainText('sample.mkv');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
  await video(page).evaluate((v: HTMLVideoElement) => v.pause());

  await page.goto('./');
  await openHistory(page);
  await entries(page).first().click();
  // Its magnet has no xs=: with zero peers only the stored .torrent gets the metadata.
  await expect(page.getByTestId('status')).toContainText('sample.mkv');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
  await expect(page.getByLabel('Magnet link or info hash')).toHaveValue('');
  await expect(page).toHaveURL(/#magnet=magnet%3A%3Fxt%3Durn%3Abtih%3A[0-9a-f]{40}.*&file=0$/);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('the history is a bottom sheet and the header fits 360 px', async ({ page }) => {
    await play(page, await fixtureMagnet('sample.mkv'), 'sample.mkv');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    await openHistory(page);
    const box = async () => (await dialog(page).boundingBox())!;
    // Once the sheet slid up: full width, on the bottom edge.
    await expect.poll(async () => Math.round((await box()).y + (await box()).height)).toBe(740);
    expect((await box()).x).toBe(0);
    expect((await box()).width).toBe(360);
    await page.getByTestId('history-close').click();
    await expect(dialog(page)).toBeHidden();
  });
});
