import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_BASE, fixtureMagnet, relayStack } from './support/fixtures';

// Replacing what plays with another torrent (header field, .torrent), in place: the old torrent is
// torn down and the new one opens as on a fresh page, never via the landing (idle) view.

const video = (page: Page) => page.getByTestId('video');
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);
const status = (page: Page) => page.getByTestId('status');

/**
 * A chunk store whose deletion never finishes once `window.__webtorStuckStore` is set (OPFS
 * `removeEntry` hangs): WebTorrent then never calls a torrent's `destroy()` back, which used to
 * leave a switch on the landing view and the next load stuck on "Still searching…".
 */
const stuckStore = () => {
  const w = window as unknown as { __webtorStuckStore?: boolean; __webtorStuckCalls?: number };
  const proto = globalThis.FileSystemDirectoryHandle?.prototype;
  if (!proto) return;
  const removeEntry = proto.removeEntry;
  proto.removeEntry = function (this: FileSystemDirectoryHandle, ...args) {
    if (!w.__webtorStuckStore) return removeEntry.apply(this, args);
    w.__webtorStuckCalls = (w.__webtorStuckCalls ?? 0) + 1;
    return new Promise<void>(() => {});
  };
};

/** Records every `data-phase` the status takes from now on. */
const recordPhases = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="status"]')!;
    const w = window as unknown as { __phases: string[] };
    w.__phases = [];
    new MutationObserver(() => w.__phases.push(el.getAttribute('data-phase') ?? '')).observe(el, {
      attributes: true,
      attributeFilter: ['data-phase'],
    });
  });
const phases = (page: Page) =>
  page.evaluate(() => (window as unknown as { __phases: string[] }).__phases);

async function enterMagnet(page: Page, magnet: string) {
  await page.getByLabel('Magnet link or info hash').fill(magnet);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
}

async function expectPlaying(page: Page, name: string) {
  await expect(status(page)).toContainText(name);
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(page.getByTestId('error')).toHaveCount(0);
  await expect(page.locator('[data-testid="notice"][data-code="no-peers"]')).toHaveCount(0);
}

test('another magnet replaces the playing one in place, A → B → A, even when a destroy hangs', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.addInitScript(stuckStore);
  const a = await fixtureMagnet('sample.mkv');
  const b = await fixtureMagnet('offset.ts');
  await page.goto(`./#magnet=${encodeURIComponent(a)}`);
  await expectPlaying(page, 'sample.mkv');

  await page.evaluate(() => {
    (window as unknown as { __webtorStuckStore: boolean }).__webtorStuckStore = true;
  });
  await recordPhases(page);

  // Playing → B.
  await enterMagnet(page, b);
  await expectPlaying(page, 'offset.ts');
  await expect(page).toHaveURL(/#magnet=magnet%3A[^&]*offset\.ts/);

  // Paused → A again (the same torrent as before).
  await video(page).evaluate((v: HTMLVideoElement) => v.pause());
  await enterMagnet(page, a);
  await expectPlaying(page, 'sample.mkv');

  // → B once more.
  await enterMagnet(page, b);
  await expectPlaying(page, 'offset.ts');

  // Never the landing view on the way, and nothing from the old torrents failed.
  expect(await phases(page)).not.toContain('idle');
  await expect(page.locator('.hero-body')).toHaveCount(0);
  expect(errors).toEqual([]);
  // The stuck store was really in the way (else this test proves nothing about a hanging destroy).
  expect(
    await page.evaluate(
      () => (window as unknown as { __webtorStuckCalls?: number }).__webtorStuckCalls,
    ),
  ).toBeGreaterThan(0);
});

test('with a relay: relay magnet → opened .torrent → relay magnet, in place', async ({ page }) => {
  test.setTimeout(120_000);
  const { magnet, relayUrl } = await relayStack();
  await page.goto(`./#relay=${encodeURIComponent(relayUrl)}`);
  await expect(page.getByTestId('relay-button')).toHaveAttribute('aria-label', 'Relay: on');
  await enterMagnet(page, magnet);
  await expectPlaying(page, 'sample.mkv');
  await recordPhases(page);

  const res = await fetch(`${FIXTURE_BASE}/offset.ts.torrent`);
  await page.getByTestId('torrent-file').setInputFiles({
    name: 'offset.ts.torrent',
    mimeType: 'application/x-bittorrent',
    buffer: Buffer.from(await res.arrayBuffer()),
  });
  await expectPlaying(page, 'offset.ts');

  await enterMagnet(page, magnet);
  await expectPlaying(page, 'sample.mkv');
  await expect(status(page)).toHaveAttribute('data-phase', /playing|buffering/);
  expect(await phases(page)).not.toContain('idle');
});

test('the help opened from the no-peers card closes with Esc, the backdrop and its button', async ({
  page,
}) => {
  test.setTimeout(90_000);
  // Nobody has this torrent: the watchdog posts `no-peers` after 20 s, and keeps ticking.
  await page.goto(`./#magnet=${'0'.repeat(39)}2`);
  const notice = page.locator('[data-testid="notice"][data-code="no-peers"]');
  await expect(notice).toBeVisible({ timeout: 40_000 });
  const help = page.getByTestId('why-dialog');

  await notice.getByTestId('why-link').click();
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();

  await notice.getByTestId('why-link').click();
  await expect(help).toBeVisible();
  // A click inside the dialog keeps it; one on the backdrop (outside its box) closes it.
  await help.getByRole('heading', { name: 'What helps' }).click();
  await expect(help).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(help).toBeHidden();

  await notice.getByTestId('why-link').click();
  await expect(help).toBeVisible();
  await help.getByRole('button', { name: 'Close' }).click();
  await expect(help).toBeHidden();
  // It stays closed while the search goes on (the watchdog ticks every second).
  await page.waitForTimeout(2500);
  await expect(help).toBeHidden();
  await expect(notice).toBeVisible();
});
