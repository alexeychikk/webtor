import { expect, test, type Page } from '@playwright/test';
import { relayStack } from './support/fixtures';

// "Copy diagnostics" in the relay dialog: the relay's event log (GET /v1/diagnostics, api 4) and
// the page's playback state in one blob, without the relay URL or its token.

const play = async (page: Page, magnet: string) => {
  await page.getByLabel('Magnet link or info hash').fill(magnet);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
};

const copyDiagnostics = async (page: Page) => {
  await page.getByTestId('relay-button').click();
  const button = page.getByTestId('relay-diagnostics');
  await button.click();
  await expect(button).toHaveAttribute('data-state', 'copied', { timeout: 15_000 });
  const text = await page.evaluate(() => navigator.clipboard.readText());
  return { text, json: JSON.parse(text) };
};

const secretsOf = (relayUrl: string) => {
  const url = new URL(relayUrl);
  return [relayUrl, url.pathname.split('/').filter(Boolean).pop()!, url.host];
};

test('copies the relay events of the torrent playing and the page state, without the relay URL', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { magnet, relayUrl } = await relayStack();
  await page.goto(`./#relay=${encodeURIComponent(relayUrl)}`);
  await play(page, magnet);
  await expect
    .poll(() => page.getByTestId('video').evaluate((v: HTMLVideoElement) => v.currentTime), {
      timeout: 30_000,
    })
    .toBeGreaterThan(1);

  const { text, json } = await copyDiagnostics(page);
  await expect(page.getByTestId('relay-diagnostics-note')).toHaveAttribute('data-relay', 'ok');
  for (const secret of secretsOf(relayUrl)) expect(text).not.toContain(secret);

  const infoHash = /btih:([0-9a-f]{40})/i.exec(magnet)![1]!.toLowerCase();
  expect(json.app).toMatchObject({
    viaRelay: true,
    infoHash,
    file: { name: 'sample.mkv', type: 'mkv' },
    pieceWindow: { budgetBytes: expect.any(Number) },
    browser: { mediaSource: true },
  });
  expect(['playing', 'paused', 'buffering']).toContain(json.app.phase);
  expect(json.relay.api).toBeGreaterThanOrEqual(4);
  expect(json.relay.torrents).toHaveLength(1);
  const kinds = json.relay.torrents[0].events.events.map((e: { kind: string }) => e.kind);
  expect(kinds).toContain('added');
  expect(kinds).toContain('peer-connected');
  // The loopback seeder's address is masked.
  expect(text).toMatch(/"127\.0\.x\.x#[0-9a-f]+"/);
});

test('a relay too old to report: copies the page side and says so', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { relayUrl } = await relayStack();
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  await page.route(/\/v1\/diagnostics/, (route) =>
    route.fulfill({ status: 404, headers: cors, body: '404 page not found' }),
  );
  await page.route(/\/v1\/info$/, async (route) => {
    const info = await (await route.fetch()).json();
    await route.fulfill({ headers: cors, body: JSON.stringify({ ...info, api: 3 }) });
  });
  await page.goto(`./#relay=${encodeURIComponent(relayUrl)}`);

  const { text, json } = await copyDiagnostics(page);
  const note = page.getByTestId('relay-diagnostics-note');
  await expect(note).toHaveAttribute('data-relay', 'too-old');
  await expect(note).toContainText('too old to report');
  expect(json.relay.unavailable).toMatch(/too old to report/);
  expect(json.app).toMatchObject({ phase: 'idle', browser: { mediaSource: true } });
  for (const secret of secretsOf(relayUrl)) expect(text).not.toContain(secret);
});

test('when the clipboard refuses, the report is shown to copy by hand', async ({ page }) => {
  const { relayUrl } = await relayStack();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
    });
  });
  await page.goto(`./#relay=${encodeURIComponent(relayUrl)}`);
  await page.getByTestId('relay-button').click();
  await page.getByTestId('relay-diagnostics').click();
  await expect(page.getByTestId('relay-diagnostics')).toHaveAttribute('data-state', 'failed');
  const shown = page.getByTestId('relay-diagnostics-text');
  await expect(shown).toBeVisible();
  const text = await shown.inputValue();
  expect(JSON.parse(text).relay.api).toBeGreaterThanOrEqual(4);
  for (const secret of secretsOf(relayUrl)) expect(text).not.toContain(secret);
});
