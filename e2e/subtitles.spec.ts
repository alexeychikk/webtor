import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';
import { selectSubtitle, subtitleGroup } from './support/player';

const video = (page: Page) => page.getByTestId('video');
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);

/** Text of the cues the browser is showing right now (active cues of `showing` tracks). */
const shownCues = (page: Page) =>
  video(page).evaluate((v: HTMLVideoElement) =>
    [...v.textTracks]
      .filter((t) => t.mode === 'showing')
      .flatMap((t) => [...(t.activeCues ?? [])].map((c) => (c as VTTCue).text)),
  );

/** Pauses and seeks; active cues are recomputed when the seek completes. */
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

test('a sidecar .srt in the torrent is listed, shows its cue at 1–3 s, and Off hides it', async ({
  page,
}) => {
  await playFixture(page, 'with-sidecar');
  await expect(page.getByTestId('status')).toContainText('sample.mkv');
  const select = page.getByTestId('subtitles');
  // Default is Off (no flags, no remembered language).
  await expect(select).toHaveAttribute('data-value', '');
  await expect(await subtitleGroup(page, 'In torrent')).toHaveText(['English · sidecar.en.srt']);
  // sample.mkv's own tracks are listed too, in their own group.
  await expect(await subtitleGroup(page, 'Embedded')).toHaveCount(2);

  await selectSubtitle(page, { label: 'English · sidecar.en.srt' });
  await seekTo(page, 2);
  await expect.poll(() => shownCues(page)).toEqual(['Hello from English SRT']);
  await seekTo(page, 4);
  await expect.poll(() => shownCues(page)).toEqual([]);
  await seekTo(page, 6);
  await expect.poll(() => shownCues(page)).toEqual(['Second english cue']);

  await selectSubtitle(page, { label: 'Off' });
  await seekTo(page, 2);
  await expect.poll(() => shownCues(page)).toEqual([]);
  const showing = await video(page).evaluate(
    (v: HTMLVideoElement) => [...v.textTracks].filter((t) => t.mode === 'showing').length,
  );
  expect(showing).toBe(0);
  await expect(page.getByTestId('error')).toHaveCount(0);
});

test('the last chosen subtitle language is selected by default', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('webtor:subtitle-language', 'en'));
  await playFixture(page, 'with-sidecar');
  await expect(page.getByTestId('subtitles')).toHaveAttribute('data-value', /^sidecar:/);
  await seekTo(page, 2);
  await expect.poll(() => shownCues(page)).toEqual(['Hello from English SRT']);
});

test('an uploaded SRT is selected and shown; Off hides it, re-selecting shows it again', async ({
  page,
}) => {
  await playFixture(page, 'sample.mkv');
  await page.getByTestId('subtitle-upload').setInputFiles({
    name: 'mine.srt',
    mimeType: 'application/x-subrip',
    buffer: Buffer.from('1\r\n00:00:01,000 --> 00:00:04,000\r\nUploaded <i>cue</i>\r\n'),
  });
  const select = page.getByTestId('subtitles');
  await expect(select).toHaveAttribute('data-value', 'upload:1');
  await expect(await subtitleGroup(page, 'Uploaded')).toHaveText(['mine.srt']);
  await seekTo(page, 2);
  await expect.poll(() => shownCues(page)).toEqual(['Uploaded <i>cue</i>']);

  await selectSubtitle(page, { label: 'Off' });
  await expect.poll(() => shownCues(page)).toEqual([]);
  await selectSubtitle(page, { label: 'mine.srt' });
  await expect.poll(() => shownCues(page)).toEqual(['Uploaded <i>cue</i>']);
});

test('a subtitle file dropped on the player is decoded (windows-1251) and shown', async ({
  page,
}) => {
  await playFixture(page, 'sample.mkv');
  const drop = (name: string, bytes: number[]) =>
    page.getByTestId('video').evaluate(
      (v, { name, bytes }) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], name));
        for (const type of ['dragenter', 'dragover', 'drop']) {
          v.dispatchEvent(
            new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }),
          );
        }
      },
      { name, bytes },
    );
  // Dragging files over the player shows its own overlay, not the page's.
  await page.getByTestId('video').evaluate((v) => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'x.srt'));
    for (const type of ['dragenter', 'dragover']) {
      v.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    }
  });
  await expect(page.getByTestId('drop-overlay')).toContainText('Drop subtitles or a .torrent');
  await expect(page.getByTestId('page-drop')).toHaveCount(0);
  // "Привет мир" in windows-1251.
  const privetMir = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0xec, 0xe8, 0xf0];
  const srt = [...Buffer.from('1\n00:00:01,000 --> 00:00:04,000\n'), ...privetMir, 0x0a];
  await drop('dropped.ru.srt', srt);
  await expect(page.getByTestId('subtitles')).toHaveAttribute('data-value', 'upload:1');
  await seekTo(page, 2);
  await expect.poll(() => shownCues(page)).toEqual(['Привет мир']);

  await drop('notes.txt', [...Buffer.from('not subtitles')]);
  // A toast (paused, so the controls and toasts show) naming the file; dismissed until the file
  // changes.
  const toast = page.locator('[data-testid="notice"][data-code="subtitle-failed"]');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Subtitle file unreadable');
  await expect(toast).toContainText('notes.txt');
  await toast.getByTestId('notice-dismiss').click();
  await expect(toast).toHaveCount(0);
  // The failed file changes nothing.
  await expect(page.getByTestId('subtitles')).toHaveAttribute('data-value', 'upload:1');
});

test('embedded MKV tracks are listed; English shows at 2 s, also after seeking away and back', async ({
  page,
}) => {
  await playFixture(page, 'sample.mkv');
  const select = page.getByTestId('subtitles');
  // Neither track is flagged default or forced: Off.
  await expect(select).toHaveAttribute('data-value', '');
  await expect(await subtitleGroup(page, 'Embedded')).toHaveText([
    'English · SRT',
    'Russian · ASS',
  ]);

  await selectSubtitle(page, { label: 'English · SRT' });
  await expect(select).toHaveAttribute('data-value', 'embedded:4');
  await seekTo(page, 2);
  await expect.poll(() => shownCues(page)).toEqual(['Hello from English SRT']);
  await seekTo(page, 10);
  await expect.poll(() => shownCues(page)).toEqual([]);
  await seekTo(page, 6);
  await expect.poll(() => shownCues(page)).toEqual(['Second english cue']);
  await seekTo(page, 2);
  await expect.poll(() => shownCues(page)).toEqual(['Hello from English SRT']);

  // ASS is drawn on the JASSUB overlay instead of the text track (e2e/ass.spec.ts).
  await selectSubtitle(page, { label: 'Russian · ASS' });
  await expect(page.getByTestId('ass-canvas')).toBeVisible({ timeout: 20_000 });
  await seekTo(page, 3);
  expect(await shownCues(page)).toEqual([]);
  await selectSubtitle(page, { label: 'Off' });
  await expect(page.getByTestId('ass-canvas')).toHaveCount(0);
  await expect.poll(() => shownCues(page)).toEqual([]);
  await expect(page.getByTestId('error')).toHaveCount(0);
  await expect(page.locator('[data-testid="notice"][data-code="subtitle-failed"]')).toHaveCount(0);
});

test('an embedded track picked after seeking far ahead finds its cues there', async ({ page }) => {
  // A short buffer window, so the video pipeline restarts at the seek target too.
  await page.addInitScript(() => localStorage.setItem('webtor:buffer-ahead-s', '3'));
  await playFixture(page, 'sample.mkv');
  await seekTo(page, 6.5);
  await selectSubtitle(page, { label: 'English · SRT' });
  await expect.poll(() => shownCues(page), { timeout: 15_000 }).toEqual(['Second english cue']);
});
