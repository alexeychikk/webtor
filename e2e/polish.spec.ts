import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';
import { openMenu, selectSubtitle, wakeControls } from './support/player';

const video = (page: Page) => page.getByTestId('video');
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);

const shownCues = (page: Page) =>
  video(page).evaluate((v: HTMLVideoElement) =>
    [...v.textTracks]
      .filter((t) => t.mode === 'showing')
      .flatMap((t) => [...(t.activeCues ?? [])].map((c) => (c as VTTCue).text)),
  );

async function seekTo(page: Page, t: number) {
  await video(page).evaluate(
    (v: HTMLVideoElement, t) =>
      new Promise<void>((resolve) => {
        v.pause();
        v.addEventListener('seeked', () => resolve(), { once: true });
        v.currentTime = t;
      }),
    t,
  );
}

async function playFixture(page: Page, name: string) {
  const magnet = await fixtureMagnet(name);
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.3);
}

test('"Why won\'t my torrent play?" explains WebRTC-only peers and leads to the relay setup', async ({
  page,
}) => {
  await page.goto('./');
  await page.getByTestId('why-button').click();
  const dialog = page.getByTestId('why-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('WebRTC');
  await expect(dialog).toContainText('qBittorrent');
  await expect(dialog).toContainText('webtorrent-cli');
  await expect(dialog.getByRole('link', { name: 'WebTorrent Desktop' }).first()).toHaveAttribute(
    'href',
    'https://webtorrent.io/desktop/',
  );
  await dialog.getByTestId('why-relay').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('relay-dialog')).toBeVisible();
});

test('the no-peers card links to the help and the relay, also from fullscreen', async ({
  page,
}) => {
  // Nobody has this torrent: the watchdog posts `no-peers` after 20 s.
  await page.goto(`./#magnet=${'0'.repeat(39)}1`);
  const notice = page.locator('[data-testid="notice"][data-code="no-peers"]');
  await expect(notice).toBeVisible({ timeout: 40_000 });
  await expect(notice).toContainText('No browser peers yet');
  const fullscreenId = () =>
    page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid') ?? null);

  // Windowed: help.
  await notice.getByTestId('why-link').click();
  const help = page.getByTestId('why-dialog');
  await expect(help).toBeVisible();
  await expect(help).toContainText('cannot serve browsers');
  await help.getByRole('button', { name: 'Close' }).click();
  await expect(help).toBeHidden();

  // Fullscreen: "Connect a relay" leaves fullscreen first, then opens the relay dialog.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('f');
  await expect.poll(fullscreenId).toBe('screen');
  await notice.getByRole('button', { name: 'Connect a relay' }).click();
  await expect(page.getByTestId('relay-dialog')).toBeVisible();
  await expect.poll(fullscreenId).toBeNull();
  // Still searching under the card.
  await expect(page.getByTestId('status')).toHaveAttribute('data-phase', 'connecting');
});

test('the empty page shows only the wordmark, tagline, input, relay and help', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('webtor');
  await expect(page.getByText('Stream torrents right in your browser.')).toBeVisible();
  await expect(page.getByTestId('relay-button')).toHaveAttribute('aria-label', 'Connect a relay');
  await expect(page.getByTestId('why-button')).toBeVisible();
  await expect(page.getByTestId('screen')).toBeHidden();
  await expect(page.getByLabel('Open .torrent file')).toBeAttached();

  // An invalid value: danger border and helper, nothing starts.
  const field = page.getByLabel('Magnet link or info hash');
  await field.fill('not a magnet');
  await field.press('Enter');
  await expect(page.getByText('Not a magnet link or info hash')).toBeVisible();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('screen')).toBeHidden();
  await field.fill('');
  await expect(page.getByText('Not a magnet link or info hash')).toHaveCount(0);

  // Pasting a magnet into the empty field plays it at once.
  const magnet = await fixtureMagnet('sample.mkv');
  await field.evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, magnet);
  await expect(page.getByTestId('status')).toContainText('sample.mkv');
  await expect(page).toHaveURL(/#magnet=/);
  await expect(field).toHaveValue(magnet);

  // The header wordmark goes back to the empty page.
  await page.getByRole('link', { name: 'webtor' }).click();
  await expect(page.getByTestId('screen')).toBeHidden();
  await expect(page.getByText('Stream torrents right in your browser.')).toBeVisible();
  expect(page.url()).not.toContain('#magnet');
});

test('the stats panel shows peers, speed and progress', async ({ page }) => {
  await playFixture(page, 'sample.mkv');
  // The chip in the control bar opens the panel.
  await expect(page.getByTestId('stats-button')).toHaveText(/\d+\s*[\d.]+ (B|kB|MB)\/s/);
  await openMenu(page, 'stats-button');
  const stats = page.getByTestId('stats');
  await expect(stats).toBeVisible();
  // The fixture web seed counts as a peer.
  await expect(page.getByTestId('stats-peers')).toHaveText(/^\d+/);
  await expect(page.getByTestId('stats-download')).toHaveText(/^[\d.]+ (B|kB|MB)\/s$/);
  await expect(page.getByTestId('stats-progress')).not.toHaveText('0%', { timeout: 15_000 });
  await expect(stats).toContainText(/of [\d.]+ (kB|MB)/);
});

test('"Copy share link" copies the #magnet=…&file=… URL', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await playFixture(page, 'multi-file');
  await expect(page).toHaveURL(/&file=1$/);
  await wakeControls(page);
  await page.getByTestId('share-link').click();
  await expect(page.getByTestId('share-link')).toHaveAttribute('data-state', 'copied');
  await expect(page.getByTestId('share-panel')).toHaveCount(0);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(page.url());
  expect(copied).toMatch(/#magnet=magnet%3A%3Fxt%3Durn%3Abtih%3A.+&file=1$/);
});

test('subtitle delay moves the cues in 0.5 s steps', async ({ page }) => {
  await playFixture(page, 'with-sidecar');
  await selectSubtitle(page, { label: 'English · sidecar.en.srt' });
  // The delay row lives in the subtitles menu; the buttons don't close it.
  await openMenu(page, 'subtitles');
  const delay = page.getByTestId('subtitle-delay');
  await expect(delay).toHaveText('0.0 s');
  // The cue is at 1–3 s; 1 s later it is at 2–4 s.
  await page.getByTestId('subtitle-delay-plus').click();
  await page.getByTestId('subtitle-delay-plus').click();
  await expect(delay).toHaveText('+1.0 s');
  await seekTo(page, 3.5);
  await expect.poll(() => shownCues(page)).toEqual(['Hello from English SRT']);
  await seekTo(page, 1.5);
  await expect.poll(() => shownCues(page)).toEqual([]);

  await page.getByTestId('subtitle-delay-reset').click();
  await page.getByTestId('subtitle-delay-minus').click();
  await expect(delay).toHaveText('−0.5 s');
  await seekTo(page, 0.75);
  await expect.poll(() => shownCues(page)).toEqual(['Hello from English SRT']);
});

test('subtitle delay also moves embedded MKV cues, including ones found after the change', async ({
  page,
}) => {
  // A short buffer window: the cluster scan finds the later cues only as playback gets there.
  await page.addInitScript(() => localStorage.setItem('webtor:buffer-ahead-s', '3'));
  await playFixture(page, 'sample.mkv');
  await selectSubtitle(page, { label: 'English · SRT' });
  await openMenu(page, 'subtitles');
  await page.getByTestId('subtitle-delay-plus').click();
  await page.getByTestId('subtitle-delay-plus').click();
  await expect(page.getByTestId('subtitle-delay')).toHaveText('+1.0 s');
  // Cues at 1–3 s and 5–8 s; 1 s later they are at 2–4 s and 6–9 s.
  await seekTo(page, 8.5);
  await expect.poll(() => shownCues(page), { timeout: 15_000 }).toEqual(['Second english cue']);
  await seekTo(page, 3.5);
  await expect.poll(() => shownCues(page)).toEqual(['Hello from English SRT']);
  await seekTo(page, 1.5);
  await expect.poll(() => shownCues(page)).toEqual([]);

  // Back to 0: every cue found so far is redrawn unshifted.
  await page.getByTestId('subtitle-delay-reset').click();
  await expect(page.getByTestId('subtitle-delay')).toHaveText('0.0 s');
  await seekTo(page, 8.5);
  await expect.poll(() => shownCues(page)).toEqual([]);
  await seekTo(page, 5.5);
  await expect.poll(() => shownCues(page)).toEqual(['Second english cue']);
});

test('keyboard shortcuts: space, arrows, m, c, f — and their help', async ({ page }) => {
  await playFixture(page, 'with-sidecar');
  await expect(page.getByTestId('status')).toHaveAttribute('data-phase', 'playing');
  const prop = <K extends keyof HTMLVideoElement>(k: K) =>
    video(page).evaluate((v: HTMLVideoElement, k) => v[k as keyof HTMLVideoElement], k);
  // Focus is on the page, not a form control.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await page.keyboard.press('m');
  expect(await prop('muted')).toBe(true);
  await page.keyboard.press('m');
  expect(await prop('muted')).toBe(false);

  await page.keyboard.press(' ');
  await expect.poll(() => prop('paused')).toBe(true);
  const before = await currentTime(page);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => currentTime(page)).toBeCloseTo(before + 5, 0);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => currentTime(page)).toBeCloseTo(before, 0);
  await page.keyboard.press(' ');
  await expect.poll(() => prop('paused')).toBe(false);

  const select = page.getByTestId('subtitles');
  await expect(select).toHaveAttribute('data-value', '');
  // Selector order: the embedded English SRT and Russian ASS, the sidecar, then Off.
  for (const value of ['embedded:4', 'embedded:5', /^sidecar:/, '']) {
    await page.keyboard.press('c');
    await expect(select).toHaveAttribute('data-value', value);
  }

  // Like the fullscreen button: the player container, so the ASS overlay stays over the video.
  await page.keyboard.press('f');
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid')))
    .toBe('screen');
  await page.keyboard.press('f');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();

  // Typing in the magnet field is not a shortcut.
  await page.getByLabel('Magnet link or info hash').press('m');
  expect(await prop('muted')).toBe(false);

  // `?` opens the help dialog scrolled to its keyboard shortcuts.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('?');
  const help = page.getByTestId('shortcuts-help');
  await expect(page.getByTestId('why-dialog')).toBeVisible();
  await expect(help).toBeInViewport();
  await expect(help.locator('kbd').first()).toHaveText('Space');
  await expect(help).toContainText('Space');
  await expect(help).toContainText('Fullscreen');
  await expect(help).toContainText('Next subtitle track');
});

test('fits a phone screen without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await playFixture(page, 'multi-file');
  await expect(page.getByTestId('more-button')).toBeAttached();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  // Polled: a sheet slides up from below the viewport.
  const inside = (id: string) =>
    expect
      .poll(
        async () => {
          const box = await page.getByTestId(id).boundingBox();
          return !!box && box.x >= 0 && box.x + box.width <= 360 && box.y + box.height <= 740.5;
        },
        { message: id },
      )
      .toBe(true);
  // Compact bar: audio, files, stats and share go into More, which opens as a bottom sheet.
  for (const id of ['video', 'subtitles', 'more-button']) await inside(id);
  for (const id of ['audio-track', 'files-button', 'share-link', 'stats-button']) {
    await expect(page.getByTestId(id), id).toHaveCount(0);
  }
  await openMenu(page, 'more-button');
  await expect(page.locator('[data-player-menu]')).toHaveAttribute('data-presentation', 'sheet');
  await inside('more-menu');
  await page.getByTestId('more-files').click();
  await expect(page.getByTestId('files-panel')).toBeVisible();
  await inside('file-list');
  await expect(page.getByLabel('Magnet link or info hash')).toBeVisible();
  for (const id of ['relay-button', 'why-button']) await inside(id);
});

test('the empty page fits a phone and `?` opens the shortcuts there too', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('./');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcuts-help')).toBeInViewport();
  await expect(page.getByTestId('shortcuts-help')).toContainText('Next subtitle track');
});
