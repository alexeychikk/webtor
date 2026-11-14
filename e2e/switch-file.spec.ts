import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { fixtureMagnet, relayStack } from './support/fixtures';
import { openMenu } from './support/player';

// e2e/fixtures/multi-file: episode-2.mkv (the largest, opened first) and episode-1.ts. The first
// file's web seed answers its header, then never again (a slow swarm, from the page's side): every
// web seed slot holds one of its piece requests. A switch must take those back, or the new file's
// header waits behind them until WebTorrent's 60 s fetch timeout ("stuck in metadata").

const HEADER_BYTES = 64 * 1024;
const FIRST = 'episode-2.mkv';
const SECOND = 'episode-1.ts';
const FIXTURE_WEB_SEED = /127\.0\.0\.1:9000\/multi-file\//;

const rangeStart = (request: Request) =>
  Number(/bytes=(\d+)-/.exec(request.headers()['range'] ?? '')?.[1] ?? 0);

const pastFirstHeader = (request: Request) =>
  request.url().includes(FIRST) && rangeStart(request) >= HEADER_BYTES;

/** Holds the web seed requests `hold` picks (never answered); returns the held count. */
async function holdWebSeed(
  page: Page,
  webSeed: RegExp,
  hold: (request: Request) => boolean = pastFirstHeader,
): Promise<() => number> {
  const held: Route[] = [];
  await page.route(webSeed, (route) => {
    if (!hold(route.request())) return route.continue();
    held.push(route);
  });
  return () => held.length;
}

/** Waits until the held requests stop growing: every slot of the web seed is taken. */
async function waitForSlotsTaken(held: () => number) {
  let last = -1;
  await expect
    .poll(
      () => {
        const now = held();
        const settled = now > 0 && now === last;
        last = now;
        return settled;
      },
      { intervals: [2_000], timeout: 30_000 },
    )
    .toBe(true);
}

async function switchTo(page: Page, name: string) {
  await openMenu(page, 'files-button');
  await page.getByTestId('file').filter({ hasText: name }).click();
  await expect(page.getByTestId('files-panel')).toHaveCount(0);
}

async function expectSwitchPlays(page: Page) {
  const status = page.getByTestId('status');
  await expect(status).toContainText(FIRST);
  await switchTo(page, SECOND);
  await expect(status).toContainText(SECOND);
  await expect(status).toHaveAttribute('data-phase', 'playing', { timeout: 20_000 });
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('a file switched to while the first one still downloads plays', async ({ page }) => {
  const held = await holdWebSeed(page, FIXTURE_WEB_SEED);
  const magnet = await fixtureMagnet('multi-file');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await waitForSlotsTaken(held);
  await expectSwitchPlays(page);
});

test('a file switched to plays through webtor-relay while the first one still downloads', async ({
  page,
}) => {
  const { multiFileMagnet, relayUrl } = await relayStack();
  const held = await holdWebSeed(page, /\/webseed\//);
  await page.goto(`./#relay=${encodeURIComponent(relayUrl)}`);
  await page.getByLabel('Magnet link or info hash').fill(multiFileMagnet);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await waitForSlotsTaken(held);
  await expectSwitchPlays(page);
});

test('a file switched to that gets no data shows the stalled notice, not an endless spinner', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const held = await holdWebSeed(
    page,
    FIXTURE_WEB_SEED,
    (request) => pastFirstHeader(request) || request.url().includes(SECOND),
  );
  const magnet = await fixtureMagnet('multi-file');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await waitForSlotsTaken(held);
  const status = page.getByTestId('status');
  await switchTo(page, SECOND);
  await expect(status).toContainText(SECOND);
  await expect(status).toHaveAttribute('data-phase', 'metadata');
  await expect(page.locator('[data-testid="notice"][data-code="stalled"]')).toBeAttached({
    timeout: 45_000,
  });
  await expect(status).toHaveAttribute('data-phase', 'metadata');
});
