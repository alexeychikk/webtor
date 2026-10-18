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
  // A small window: after the switch the audio buffer only grows if the new pipeline appends. The
  // old track stays buffered (up to the window) while the new pipeline warms up; 4 s leaves room
  // for a slow AC-3 decoder/Opus encoder start on a loaded machine (production keeps 60 s).
  await page.addInitScript(() => localStorage.setItem('webtor:buffer-ahead-s', '4'));
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
  // Count stalls on missing media: `waiting` with the playhead at the end of what is buffered (or
  // in a hole). A `waiting` with seconds still buffered is the renderer starved of CPU on a busy
  // machine, which no player change can prevent.
  await video(page).evaluate((v: HTMLVideoElement) => {
    v.dataset.underruns = '0';
    v.addEventListener('waiting', () => {
      const t = v.currentTime;
      let ahead = 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= t && t < v.buffered.end(i)) ahead = v.buffered.end(i) - t;
      }
      if (ahead < 0.5) v.dataset.underruns = String(Number(v.dataset.underruns) + 1);
    });
  });
  await select.selectOption(russian);
  await expect(video(page)).toHaveAttribute('data-audio-codec', 'opus');
  await expect(video(page)).toHaveAttribute('data-audio-track', russian);

  // Video kept playing through the switch, and the (Opus) audio buffer grows past what the old
  // track left buffered (the 4 s window plus a 1 s fragment past where it stopped, ~1 s after
  // the switch point at most).
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(switchedAt + 3);
  await expect.poll(() => bufferedEnd(page), { timeout: 10_000 }).toBeGreaterThan(switchedAt + 6.5);
  expect(await decodedAudio(page)).toBeGreaterThan(before);
  // The old track stays buffered until the new one overwrites it, so playback never ran out of
  // audio during the new pipeline's warm-up (AC-3 decoder worker + Opus encoder start, first 1 s
  // fragment).
  await expect(video(page)).toHaveAttribute('data-underruns', '0');
  await expect(page.getByTestId('status')).toHaveAttribute('data-phase', 'playing');
  await expect(page.getByTestId('error')).toHaveCount(0);
  await expect(page.getByTestId('notice')).toHaveCount(0);

  // A seek past the buffered end restarts the transcoding pipeline too (the 12 s fixture's last
  // keyframe is at 10 s).
  const target = Math.min(11, (await bufferedEnd(page)) + 0.5);
  await video(page).evaluate((v: HTMLVideoElement, t) => (v.currentTime = t), target);
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(target + 0.5);
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

test('a converter that fails to load falls back to another track instead of failing', async ({
  page,
}) => {
  // The remembered language picks the AC-3 track, but its wasm decoder can't be downloaded (e.g.
  // the chunk hashes changed after a redeploy while the tab stayed open).
  await page.addInitScript(() => localStorage.setItem('webtor:audio-lang', 'rus'));
  await page.route(/mediabunny-ac3-.*\.js/, (route) => route.abort());
  const magnet = await fixtureMagnet('sample.mkv');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);

  const options = page.getByTestId('audio-track').locator('option');
  await expect(options).toHaveText([
    /English AAC · eng · AAC mono/,
    /Russian AC3.*unavailable: the AC-3 converter failed to load/,
  ]);
  await expect(options.nth(1)).toBeDisabled();
  await expect(page.getByTestId('audio-track')).toHaveValue(await optionValue(page, /English/));
  await expect(video(page)).toHaveAttribute('data-audio-codec', 'aac');
  await expect(
    page.locator('[data-testid="notice"][data-code="audio-convert-failed"]'),
  ).toBeVisible();
  await expect(page.getByTestId('error')).toHaveCount(0);
});
