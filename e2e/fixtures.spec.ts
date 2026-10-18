import { expect, test } from '@playwright/test';
import { FIXTURE_BASE, fixtureMagnet } from './support/fixtures';

test('fixture server serves a peerless magnet for sample.mkv', async ({ request }) => {
  const magnet = await fixtureMagnet('sample.mkv');
  expect(magnet).toMatch(/^magnet:\?xt=urn:btih:[0-9a-f]{40}&/);
  expect(magnet).toContain('xs=');
  const ranged = await request.get(`${FIXTURE_BASE}/sample.mkv`, {
    headers: { Range: 'bytes=0-3' },
  });
  expect(ranged.status()).toBe(206);
  // EBML magic: every Matroska file starts with 1A 45 DF A3.
  expect([...(await ranged.body())]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
});
