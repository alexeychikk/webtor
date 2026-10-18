import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

const video = (page: Page) => page.getByTestId('video');
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);
const bufferedEnd = (page: Page) =>
  video(page).evaluate((v: HTMLVideoElement) =>
    v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0,
  );
const decodedAudio = (page: Page) =>
  video(page).evaluate(
    (v) =>
      (v as HTMLVideoElement & { webkitAudioDecodedByteCount: number }).webkitAudioDecodedByteCount,
  );
const optionValue = (page: Page, label: RegExp) =>
  page
    .getByTestId('audio-track')
    .locator('option', { hasText: label })
    .evaluate((o: HTMLOptionElement) => o.value);

test('switching from English AAC to Russian AC3 transcodes to Opus and keeps playing', async ({
  page,
}) => {
  // A small window: after the switch the audio buffer only grows if the new pipeline appends.
  await page.addInitScript(() => localStorage.setItem('webtor:buffer-ahead-s', '2'));
  const magnet = await fixtureMagnet('sample.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);

  const select = page.getByTestId('audio-track');
  await expect(select.locator('option')).toHaveText([
    /English AAC · eng · AAC mono/,
    /Russian AC3 · rus · AC-3 .*→ Opus/,
  ]);
  const english = await optionValue(page, /English AAC/);
  const russian = await optionValue(page, /Russian AC3/);
  await expect(select).toHaveValue(english);
  await expect(video(page)).toHaveAttribute('data-audio-codec', 'aac');
  await expect(video(page)).toHaveAttribute('data-audio-track', english);

  const before = await decodedAudio(page);
  const switchedAt = await currentTime(page);
  await video(page).evaluate((v: HTMLVideoElement) => {
    v.dataset.waits = '0';
    v.addEventListener('waiting', () => (v.dataset.waits = String(Number(v.dataset.waits) + 1)));
  });
  await select.selectOption(russian);
  await expect(video(page)).toHaveAttribute('data-audio-codec', 'opus');
  await expect(video(page)).toHaveAttribute('data-audio-track', russian);

  // Video kept playing through the switch, and the (Opus) audio buffer grows past what the old
  // track left buffered (1 s past the switch point).
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(switchedAt + 3);
  expect(await bufferedEnd(page)).toBeGreaterThan(switchedAt + 3);
  expect(await decodedAudio(page)).toBeGreaterThan(before);
  // The old track stays buffered until the new one arrives, so playback never waited on audio.
  await expect(video(page)).toHaveAttribute('data-waits', '0');
  await expect(page.getByTestId('status')).toHaveAttribute('data-phase', 'playing');
  await expect(page.getByTestId('error')).toHaveCount(0);
  await expect(page.getByTestId('notice')).toHaveCount(0);

  // A seek restarts the transcoding pipeline too.
  await video(page).evaluate((v: HTMLVideoElement) => (v.currentTime = 8));
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(9);
  await expect(video(page)).toHaveAttribute('data-audio-codec', 'opus');
  await expect(page.getByTestId('error')).toHaveCount(0);

  // The chosen language is remembered: the next load starts on the Russian track, transcoded.
  await page.reload();
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(video(page)).toHaveAttribute('data-audio-codec', 'opus');
  await expect(select).toHaveValue(russian);
  expect(await decodedAudio(page)).toBeGreaterThan(0);
});

test('tracks the browser cannot play or convert are disabled, and the video plays muted', async ({
  page,
}) => {
  // Pretend MSE plays neither AAC nor Opus: nothing can be copied or transcoded.
  await page.addInitScript(() => {
    const orig = MediaSource.isTypeSupported.bind(MediaSource);
    MediaSource.isTypeSupported = (mime: string) => !/codecs="(mp4a|opus)/.test(mime) && orig(mime);
  });
  const magnet = await fixtureMagnet('sample.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);

  const options = page.getByTestId('audio-track').locator('option');
  await expect(options).toHaveText([
    'Muted',
    /English AAC.*unavailable/,
    /Russian AC3.*unavailable/,
  ]);
  await expect(options.nth(1)).toBeDisabled();
  await expect(options.nth(2)).toBeDisabled();
  await expect(video(page)).toHaveAttribute('data-audio-codec', '');
  await expect(page.locator('[data-testid="notice"][data-code="no-playable-audio"]')).toBeVisible();
  await expect(page.getByTestId('error')).toHaveCount(0);
});
