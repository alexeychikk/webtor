import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

// AVI (ADR 0007): our demuxer feeds Mediabunny. avi-h264-mp3.avi = 12 s H.264 High with B-frames
// + VBR MP3; the Xvid fixtures need the relay.

const currentTime = (page: Page) =>
  page.getByTestId('video').evaluate((v: HTMLVideoElement) => v.currentTime);

test('plays an H.264 + MP3 AVI and keeps playing after a seek into unbuffered media', async ({
  page,
}) => {
  // ~2 s ahead: the seek to 9.5 s restarts the pipeline at the AVI's 6 s keyframe.
  await page.addInitScript(() => localStorage.setItem('webtor:buffer-ahead-s', '2'));
  const magnet = await fixtureMagnet('avi-h264-mp3.avi');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByTestId('status')).toContainText('avi-h264-mp3.avi');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(page.getByTestId('error')).toHaveCount(0);
  const video = page.getByTestId('video');
  // MP3 is copied as mp4a.6b where MSE takes it, else converted.
  await expect(video).toHaveAttribute('data-audio-codec', /^(mp3|opus|aac)$/);
  const audioBytes = () =>
    video.evaluate(
      (v) =>
        (v as HTMLVideoElement & { webkitAudioDecodedByteCount: number })
          .webkitAudioDecodedByteCount,
    );
  await expect.poll(audioBytes, { timeout: 10_000 }).toBeGreaterThan(0);
  const duration = await video.evaluate((v: HTMLVideoElement) => v.duration);
  expect(duration).toBeGreaterThan(11.5);
  expect(duration).toBeLessThan(12.5);

  await video.evaluate((v: HTMLVideoElement) => (v.currentTime = 9.5));
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(10.3);
  const decoded = await video.evaluate(
    (v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames,
  );
  expect(decoded).toBeGreaterThan(24);
  await expect(page.getByTestId('error')).toHaveCount(0);
});

test('a DivX/Xvid AVI says it needs a relay and offers the relay settings', async ({ page }) => {
  const magnet = await fixtureMagnet('avi-xvid-ac3.avi');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  const error = page.getByTestId('error');
  await expect(error).toHaveAttribute('data-code', 'video-needs-relay', { timeout: 30_000 });
  await expect(error).toContainText('DivX/Xvid');
  await error.getByRole('button', { name: 'Set up a relay' }).click();
  await expect(page.getByTestId('relay-dialog')).toBeVisible();
});
