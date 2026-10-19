import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';
import { closeMenu, openMenu, selectAudio, selectSubtitle, wakeControls } from './support/player';

// e2e/fixtures/resume: movie.mkv (40 s; audio "English AAC" default + "Russian AC3"; subtitles
// embedded:4 "English", embedded:5 "English SDH", embedded:6 "Russian") and extra.mkv (sample.mkv,
// 12 s). movie.mkv is the largest, so it opens first.

const video = (page: Page) => page.getByTestId('video');
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);
const bufferedStart = (page: Page) =>
  video(page).evaluate((v: HTMLVideoElement) => (v.buffered.length ? v.buffered.start(0) : -1));
const seekTo = (page: Page, t: number) =>
  video(page).evaluate((v: HTMLVideoElement, to) => {
    v.currentTime = to;
  }, t);
const resumeToast = (page: Page) => page.getByTestId('resume-toast');

async function open(page: Page) {
  const magnet = await fixtureMagnet('resume');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByTestId('status')).toContainText('movie.mkv');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
}

async function pickFile(page: Page, name: string) {
  await openMenu(page, 'files-button');
  await page.getByTestId('file').filter({ hasText: name }).click();
  await expect(page.getByTestId('files-panel')).toHaveCount(0);
  await expect(page.getByTestId('status')).toContainText(name);
}

test('reload restores the audio track, the exact subtitle track and the position', async ({
  page,
}) => {
  await open(page);
  await expect(resumeToast(page)).toHaveCount(0);
  const audio = page.getByTestId('audio-track');
  const english = await audio.getAttribute('data-value');
  await openMenu(page, 'audio-track');
  const russian = await page
    .getByTestId('audio-option')
    .and(page.getByRole('option', { name: /Russian AC3/ }))
    .getAttribute('data-value');
  await closeMenu(page);
  expect(russian).not.toBe(english);
  await selectAudio(page, { value: russian! });
  await expect(video(page)).toHaveAttribute('data-audio-track', russian!);
  // The second of the two English tracks.
  await selectSubtitle(page, { value: 'embedded:5' });
  await expect(page.getByTestId('subtitles')).toHaveAttribute('data-value', 'embedded:5');

  await seekTo(page, 20);
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(21);
  await page.reload();

  await expect(page.getByTestId('status')).toContainText('movie.mkv');
  await expect(video(page)).toHaveAttribute('data-audio-track', russian!);
  await expect(video(page)).toHaveAttribute('data-audio-codec', 'opus');
  await expect(page.getByTestId('subtitles')).toHaveAttribute('data-value', 'embedded:5');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(21);
  // Started at the resume point: nothing was fetched or buffered from the start of the file.
  expect(await bufferedStart(page)).toBeGreaterThan(15);
  await expect(resumeToast(page)).toBeAttached();
  await expect(resumeToast(page)).toContainText(/Resumed at 0:2\d/);
  const showing = await video(page).evaluate((v: HTMLVideoElement) =>
    [...v.textTracks].filter((t) => t.mode === 'showing').map((t) => t.label),
  );
  expect(showing).toEqual([expect.stringMatching(/English SDH/)]);

  await wakeControls(page);
  await page.getByTestId('start-over').click();
  await expect(resumeToast(page)).toHaveCount(0);
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeLessThan(5);
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(0.5);
  await expect(page.getByTestId('error')).toHaveCount(0);
});

test('subtitles turned off stay off after a reload', async ({ page }) => {
  await open(page);
  await selectSubtitle(page, { value: 'embedded:4' });
  await selectSubtitle(page, { value: '' });
  await expect(page.getByTestId('subtitles')).toHaveAttribute('data-value', '');
  // Another video's choice changed the global language preference meanwhile.
  await page.evaluate(() => localStorage.setItem('webtor:subtitle-language', 'en'));
  await page.reload();
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
  const options = (await openMenu(page, 'subtitles')).getByTestId('subtitle-option');
  await expect(options.filter({ hasText: /English SDH/ })).toHaveCount(1);
  await closeMenu(page);
  await expect(page.getByTestId('subtitles')).toHaveAttribute('data-value', '');
  // A video never opened before still follows the language preference.
  await pickFile(page, 'extra.mkv');
  await expect(page.getByTestId('subtitles')).toHaveAttribute('data-value', 'embedded:4');
});

test('each video of a torrent resumes on its own; a finished one starts over', async ({ page }) => {
  await open(page);
  await seekTo(page, 20);
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(20.5);

  await pickFile(page, 'extra.mkv');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
  expect(await currentTime(page)).toBeLessThan(5);
  await expect(resumeToast(page)).toHaveCount(0);
  // The last 5 % of the 12 s video counts as watched.
  await seekTo(page, 11.6);
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(11.6);

  await pickFile(page, 'movie.mkv');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(20.5);
  await expect(resumeToast(page)).toContainText(/Resumed at 0:2\d/);

  await pickFile(page, 'extra.mkv');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
  expect(await currentTime(page)).toBeLessThan(5);
  await expect(resumeToast(page)).toHaveCount(0);
});
