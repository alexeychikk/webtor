import { expect, test, type Page } from '@playwright/test';
import { relayStack } from './support/fixtures';

// webtor-relay route (docs/decisions/0006): the magnet's only peer is a TCP seeder on loopback, which
// a page can never reach by itself. Started by e2e/support/relay-stack.mjs.

const currentTime = (page: Page) =>
  page.getByTestId('video').evaluate((v: HTMLVideoElement) => v.currentTime);

const play = async (page: Page, magnet: string) => {
  await page.getByLabel('Magnet link or info hash').fill(magnet);
  await page.getByRole('button', { name: 'Play' }).click();
};

test('plays a magnet only regular peers have, through webtor-relay set by #relay=', async ({
  page,
}) => {
  const { magnet, relayUrl } = await relayStack();
  expect(magnet).not.toMatch(/[?&](xs|ws|tr)=/);

  // webtor-relay's printed Open link: saved, then gone from the address bar.
  await page.goto(`./#relay=${encodeURIComponent(relayUrl)}`);
  await expect(page.getByTestId('relay-button')).toHaveText('Relay: on');
  expect(page.url()).not.toContain('relay');
  expect(await page.evaluate(() => localStorage.getItem('webtor:relay-url'))).toBe(relayUrl);

  await play(page, magnet);
  await expect(page.getByTestId('status')).toContainText('sample.mkv');
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(2);
  await expect(page.getByTestId('status')).toHaveAttribute('data-phase', 'playing');
  // The relay's swarm stats are merged in (the count drops to 0 once the relay holds the whole file
  // and lets the seeder go).
  await expect(page.getByTestId('relay-peers')).toHaveText(/^· \d+ via relay$/);
  await expect(page.getByTestId('error')).toHaveCount(0);

  await page.getByTestId('video').evaluate((v: HTMLVideoElement) => (v.currentTime = 8));
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(9);
});

test('no peers → "Connect a relay" → test, save, and the torrent starts', async ({ page }) => {
  test.setTimeout(120_000);
  const { magnet, relayUrl } = await relayStack();
  await page.goto('./');
  await expect(page.getByTestId('relay-button')).toHaveText('Connect a relay');
  await play(page, magnet);

  // Without a relay nothing in the browser can reach the TCP seeder.
  const noPeers = page.locator('[data-testid="notice"][data-code="no-peers"]');
  await expect(noPeers).toBeVisible({ timeout: 25_000 });
  await noPeers.getByRole('button', { name: 'Connect a relay' }).click();

  const dialog = page.getByTestId('relay-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'latest relay release' })).toHaveAttribute(
    'href',
    'https://github.com/alexeychikk/webtor/releases',
  );
  await expect(dialog).toContainText('Keep the relay URL secret');

  const field = dialog.getByTestId('relay-url');
  await field.fill('http://127.0.0.1:7882');
  await field.blur();
  await expect(dialog).toContainText('needs the secret token path');
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();

  await field.fill(`${relayUrl}/`);
  await dialog.getByRole('button', { name: 'Test' }).click();
  await expect(dialog.getByTestId('relay-test')).toHaveAttribute('data-state', 'ok');
  await expect(dialog.getByTestId('relay-test')).toContainText('Connected to webtor-relay');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('webtor:relay-url'))).toBe(relayUrl);

  // Saving retries the playback that was looking for peers, now through the relay.
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(noPeers).toHaveCount(0);
});

test('relay failures end in relay error messages with a way to the settings', async ({ page }) => {
  const { magnet } = await relayStack();
  // Nothing listens on port 7899: like a relay that isn't running (or a denied network prompt).
  await page.addInitScript(() => {
    localStorage.setItem('webtor:relay-url', 'http://127.0.0.1:7899/0123456789abcdef');
  });
  await page.goto('./');
  await play(page, magnet);
  const error = page.getByTestId('error');
  await expect(error).toHaveAttribute('data-code', 'relay-unreachable');
  await expect(error).toContainText('Cannot reach your relay');
  await error.getByRole('button', { name: 'Relay settings' }).click();
  await expect(page.getByTestId('relay-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // The relay's 504: the swarm gave no metadata in time.
  await page.route(/127\.0\.0\.1:7899\/.*\/metainfo/, (route) =>
    route.fulfill({
      status: 504,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'no metadata from the swarm yet' }),
    }),
  );
  await play(page, `${magnet}&dn=again`);
  await expect(error).toHaveAttribute('data-code', 'relay-no-metadata');
});

test('an invalid #relay= is dropped from the URL and shown in the dialog', async ({ page }) => {
  await page.goto(`./#relay=${encodeURIComponent('http://127.0.0.1:7882')}`);
  const dialog = page.getByTestId('relay-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('needs the secret token path');
  expect(page.url()).not.toContain('relay');
  await expect(page.getByTestId('relay-button')).toHaveText('Connect a relay');
});
