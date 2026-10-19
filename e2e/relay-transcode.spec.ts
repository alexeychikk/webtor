import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_BASE, relayStack } from './support/fixtures';

// DivX/Xvid AVI through webtor-relay's video conversion (ADR 0007 §2): the relay streams H.264
// fragmented MP4 into the video SourceBuffer; the AVI's AC-3 audio is converted to Opus in the page.
// The AVI's only peer is a TCP seeder on loopback (e2e/support/relay-stack.mjs). The converting
// relay needs ffmpeg with libx264 (WEBTOR_RELAY_FFMPEG or PATH): without it that test is skipped.

const RELAY_TOKEN = 'e2e-relay-token';

const currentTime = (page: Page) =>
  page.getByTestId('video').evaluate((v: HTMLVideoElement) => v.currentTime);

/** Console lines of the page, to check that the relay URL (its token) never shows up there. */
function collectConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on('console', (m) => lines.push(m.text()));
  page.on('pageerror', (e) => lines.push(String(e)));
  return lines;
}

/** `start=` of every conversion the page asked the relay for. */
function transcodeStarts(page: Page): number[] {
  const starts: number[] = [];
  page.on('request', (r) => {
    const m = /\/transcode\/\d+\?start=([\d.]+)/.exec(r.url());
    if (m) starts.push(Number(m[1]));
  });
  return starts;
}

async function transcodeAvailable(relayUrl: string): Promise<boolean> {
  const info = (await (await fetch(`${relayUrl}/v1/info`)).json()) as {
    transcode?: { available?: boolean };
  };
  return info.transcode?.available === true;
}

async function useRelay(page: Page, relayUrl: string) {
  await page.addInitScript((url) => {
    localStorage.setItem('webtor:relay-url', url);
    // A few seconds ahead, so the seek to 8 s lands in unbuffered media and restarts both pipelines.
    localStorage.setItem('webtor:buffer-ahead-s', '3');
  }, relayUrl);
}

test('a DivX/Xvid AVI plays with relay-converted video and AC-3 → Opus audio, and seeks', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { aviMagnet, relayUrl } = await relayStack();
  test.skip(
    !(await transcodeAvailable(relayUrl)),
    'the relay found no ffmpeg (WEBTOR_RELAY_FFMPEG)',
  );

  const logs = collectConsole(page);
  const starts = transcodeStarts(page);
  await useRelay(page, relayUrl);
  await page.goto(`./#magnet=${encodeURIComponent(aviMagnet)}`);
  await expect(page.getByTestId('status')).toContainText('avi-xvid-ac3.avi');
  await expect.poll(() => currentTime(page), { timeout: 60_000 }).toBeGreaterThan(2);
  await expect(page.getByTestId('error')).toHaveCount(0);

  const video = page.getByTestId('video');
  await expect(video).toHaveAttribute('data-audio-codec', 'opus');
  // The relay's H.264 is decoded (the Xvid fixture is 320×180; the relay never scales up).
  expect(await video.evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight])).toEqual([
    320, 180,
  ]);
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

  await video.evaluate((v: HTMLVideoElement) => (v.currentTime = 8));
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(9.5);
  const frames = await video.evaluate(
    (v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames,
  );
  expect(frames).toBeGreaterThan(24);
  await expect(page.getByTestId('error')).toHaveCount(0);
  // The seek restarted the relay's conversion at ~8 s (the element's frame-snapped time; no
  // keyframe snapping on this path).
  expect(starts[0]).toBe(0);
  expect(starts.some((s) => s > 7.9 && s < 8.1)).toBe(true);

  // The relay URL is a password: never in the page's logs or text.
  expect(logs.filter((l) => l.includes(RELAY_TOKEN))).toEqual([]);
  expect(await page.locator('body').innerText()).not.toContain(RELAY_TOKEN);
});

test('a relay started with -no-transcode says it can’t convert video', async ({ page }) => {
  const { aviMagnet, noTranscodeRelayUrl } = await relayStack();
  const logs = collectConsole(page);
  await useRelay(page, noTranscodeRelayUrl);
  await page.goto(`./#magnet=${encodeURIComponent(aviMagnet)}`);
  const error = page.getByTestId('error');
  await expect(error).toHaveAttribute('data-code', 'relay-transcode-unavailable', {
    timeout: 60_000,
  });
  await expect(error).toContainText('Install ffmpeg');

  // The relay dialog's Test says so too.
  await error.getByRole('button', { name: 'Relay settings' }).click();
  const dialog = page.getByTestId('relay-dialog');
  await dialog.getByRole('button', { name: 'Test' }).click();
  await expect(dialog.getByTestId('relay-test')).toHaveAttribute('data-state', 'ok');
  const transcode = dialog.getByTestId('relay-transcode');
  await expect(transcode).toHaveAttribute('data-available', 'false');
  await expect(transcode).toContainText('Video conversion: off');

  expect(logs.filter((l) => l.includes(RELAY_TOKEN))).toEqual([]);
  expect(await page.locator('body').innerText()).not.toContain(RELAY_TOKEN);
});

test('an opened .torrent registers with the relay before its video is converted', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { relayUrl } = await relayStack();
  test.skip(
    !(await transcodeAvailable(relayUrl)),
    'the relay found no ffmpeg (WEBTOR_RELAY_FFMPEG)',
  );
  const res = await fetch(`${FIXTURE_BASE}/avi-xvid-ac3.avi.torrent`);
  const metainfo: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/metainfo')) metainfo.push(`${r.method()} ${new URL(r.url()).search}`);
  });
  const starts = transcodeStarts(page);
  await useRelay(page, relayUrl);
  await page.goto('./');
  await page.getByTestId('torrent-file').setInputFiles({
    name: 'avi-xvid-ac3.avi.torrent',
    mimeType: 'application/x-bittorrent',
    buffer: Buffer.from(await res.arrayBuffer()),
  });
  await expect.poll(() => currentTime(page), { timeout: 60_000 }).toBeGreaterThan(2);
  await expect(page.getByTestId('error')).toHaveCount(0);
  // The relay got the .torrent itself: its swarm can't supply the info dict (here: the browser and
  // the torrent's web seed only), the file's web seed then supplies the data.
  expect(metainfo).toEqual(['POST ']);
  expect(starts[0]).toBe(0);
});
