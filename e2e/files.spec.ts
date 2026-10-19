import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_BASE, fixtureMagnet } from './support/fixtures';
import { closeMenu, openMenu, selectSubtitle, subtitleGroup } from './support/player';

// e2e/fixtures/multi-file: episode-1.ts (offset.ts, 10 s, smaller), episode-2.mkv (sample.mkv,
// 12 s, largest), extras.wmv (unsupported container) and readme.txt (not a video).

const video = (page: Page) => page.getByTestId('video');
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);
const duration = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.duration);
const fileButton = (page: Page, name: string) => page.getByTestId('file').filter({ hasText: name });
const fileIndex = async (page: Page, name: string) => {
  await openFiles(page);
  return Number(await fileButton(page, name).getAttribute('data-index'));
};
/** Opens the files drawer (picking a file closes it). */
const openFiles = (page: Page) => openMenu(page, 'files-button');
/** Picks a file in the files drawer. */
async function pickFile(page: Page, name: string) {
  await openFiles(page);
  await fileButton(page, name).click();
  await expect(page.getByTestId('files-panel')).toHaveCount(0);
}

async function torrentBytes(name: string): Promise<Buffer> {
  const res = await fetch(`${FIXTURE_BASE}/${name}.torrent`);
  if (!res.ok) throw new Error(`no fixture torrent ${name}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

test('a multi-file torrent auto-picks the largest video and switches to another file', async ({
  page,
}) => {
  const magnet = await fixtureMagnet('multi-file');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);

  await expect(page.getByTestId('files-button')).toHaveAttribute('aria-label', 'Files (2 of 3)');
  await openFiles(page);
  const files = page.getByTestId('file');
  await expect(files).toHaveText([
    /episode-1\.ts\s*325 kB/,
    /episode-2\.mkv\s*708 kB/,
    /extras\.wmv/,
  ]);
  await expect(fileButton(page, 'extras.wmv')).toBeDisabled();
  await expect(fileButton(page, 'episode-2.mkv')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('status')).toContainText('episode-2.mkv');
  const second = await fileIndex(page, 'episode-2.mkv');
  await expect(page).toHaveURL(new RegExp(`#magnet=magnet%3A[^&]+&file=${second}$`));
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
  expect(await duration(page)).toBeGreaterThan(11.5);

  await pickFile(page, 'episode-1.ts');
  await openFiles(page);
  await expect(fileButton(page, 'episode-1.ts')).toHaveAttribute('aria-current', 'true');
  await closeMenu(page);
  await expect(page.getByTestId('status')).toContainText('episode-1.ts');
  const first = await fileIndex(page, 'episode-1.ts');
  await expect(page).toHaveURL(new RegExp(`&file=${first}$`));
  // A fresh session on the new file: its own duration, playing from the start.
  await expect.poll(() => duration(page), { timeout: 30_000 }).toBeLessThan(10.5);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(page.getByTestId('status')).toHaveAttribute('data-phase', 'playing');
  await expect(page.getByTestId('error')).toHaveCount(0);

  // And back again: the torrent stays, only the playback session is rebuilt.
  await pickFile(page, 'episode-2.mkv');
  await expect.poll(() => duration(page), { timeout: 30_000 }).toBeGreaterThan(11.5);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(page.getByTestId('error')).toHaveCount(0);
});

test('#file= in the hash selects that file on load', async ({ page }) => {
  const magnet = await fixtureMagnet('multi-file');
  // Torrent file order: episode-1.ts, episode-2.mkv, extras.wmv, readme.txt (sorted by path).
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}&file=0`);
  await expect(page.getByTestId('status')).toContainText('episode-1.ts');
  expect(await fileIndex(page, 'episode-1.ts')).toBe(0);
  await expect(fileButton(page, 'episode-1.ts')).toHaveAttribute('aria-current', 'true');
  await closeMenu(page);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
  expect(await duration(page)).toBeLessThan(10.5);
  await expect(page).toHaveURL(/&file=0$/);
});

test('#file= pointing at an unplayable file falls back to the largest video', async ({ page }) => {
  const magnet = await fixtureMagnet('multi-file');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}&file=2`);
  await expect(page.getByTestId('status')).toContainText('episode-2.mkv');
  await expect(page).toHaveURL(/&file=1$/);
});

test('an opened .torrent file plays and its magnet goes into the hash', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('torrent-file').setInputFiles({
    name: 'sample.mkv.torrent',
    mimeType: 'application/x-bittorrent',
    buffer: await torrentBytes('sample.mkv'),
  });
  await expect(page.getByTestId('status')).toContainText('sample.mkv');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(page.getByTestId('error')).toHaveCount(0);
  // A single-file torrent: nothing to choose, so no files button.
  await expect(page.getByTestId('files-button')).toHaveCount(0);
  await expect(page).toHaveURL(/#magnet=magnet%3A%3Fxt%3Durn%3Abtih%3A[0-9a-f]{40}.*&file=0$/);
});

test('a .torrent file dropped on the page plays', async ({ page }) => {
  await page.goto('./');
  const bytes = [...(await torrentBytes('multi-file'))];
  const drag = (types: string[]) =>
    page.getByRole('heading', { name: 'webtor' }).evaluate(
      (el, { bytes, types }) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], 'multi-file.torrent'));
        for (const type of types) {
          el.dispatchEvent(
            new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }),
          );
        }
      },
      { bytes, types },
    );
  // Anywhere on the page (here the empty page's wordmark): the page drop overlay.
  await drag(['dragenter', 'dragover']);
  await expect(page.getByTestId('page-drop')).toBeVisible();
  await expect(page.getByTestId('page-drop')).toContainText('Drop a .torrent to play');
  await drag(['drop']);
  await expect(page.getByTestId('page-drop')).toHaveCount(0);
  await expect(page.getByTestId('status')).toContainText('episode-2.mkv');
  await openFiles(page);
  await expect(page.getByTestId('file')).toHaveCount(3);
  await closeMenu(page);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
});

test('a file that is not a torrent shows a clear error', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('torrent-file').setInputFiles({
    name: 'broken.torrent',
    mimeType: 'application/x-bittorrent',
    buffer: Buffer.from('this is not bencoded'),
  });
  const error = page.getByTestId('error');
  await expect(error).toHaveAttribute('data-code', 'invalid-input');
  await expect(error).toContainText('Not a torrent');
  // Retrying the same bytes can't help.
  await expect(error.getByTestId('retry')).toHaveCount(0);
});

test('switching files drops the embedded subtitles of the previous file', async ({ page }) => {
  const shownCues = () =>
    video(page).evaluate((v: HTMLVideoElement) =>
      [...v.textTracks]
        .filter((t) => t.mode === 'showing')
        .flatMap((t) => [...(t.activeCues ?? [])].map((c) => (c as VTTCue).text)),
    );
  const allCues = () =>
    video(page).evaluate((v: HTMLVideoElement) =>
      [...v.textTracks].reduce((n, t) => n + (t.cues?.length ?? 0), 0),
    );
  const seekTo = (t: number) =>
    video(page).evaluate(
      (v: HTMLVideoElement, t) =>
        new Promise<void>((resolve) => {
          v.pause();
          v.addEventListener('seeked', () => resolve(), { once: true });
          v.currentTime = t;
        }),
      t,
    );
  const embedded = () => subtitleGroup(page, 'Embedded');

  const magnet = await fixtureMagnet('multi-file');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByTestId('status')).toContainText('episode-2.mkv');
  await expect(await embedded()).toHaveCount(2);
  await selectSubtitle(page, { label: 'English · SRT' });
  await seekTo(2);
  await expect.poll(shownCues).toEqual(['Hello from English SRT']);

  // episode-1.ts has no subtitles: nothing listed, no cues left over from the MKV's scan.
  await pickFile(page, 'episode-1.ts');
  await expect.poll(() => duration(page), { timeout: 30_000 }).toBeLessThan(10.5);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(await embedded()).toHaveCount(0);
  await closeMenu(page);
  await expect(page.getByTestId('subtitles')).toHaveAttribute('data-value', '');
  await seekTo(2);
  expect(await allCues()).toBe(0);
  expect(await shownCues()).toEqual([]);

  // Back on the MKV: its tracks again, each cue once.
  await pickFile(page, 'episode-2.mkv');
  await expect.poll(() => duration(page), { timeout: 30_000 }).toBeGreaterThan(11.5);
  await expect(await embedded()).toHaveCount(2);
  await selectSubtitle(page, { label: 'English · SRT' });
  await seekTo(2);
  await expect.poll(shownCues).toEqual(['Hello from English SRT']);
  await expect(page.getByTestId('error')).toHaveCount(0);
});
