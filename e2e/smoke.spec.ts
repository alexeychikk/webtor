import { expect, test } from '@playwright/test';

test('accepts a magnet link', async ({ page }) => {
  await page.goto('./');
  const play = page.getByRole('button', { name: 'Play' });
  await expect(play).toBeDisabled();
  await page
    .getByLabel('Magnet link or info hash')
    .fill('magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10');
  await expect(play).toBeEnabled();
  await play.click();
  await expect(page.getByTestId('status')).toBeVisible();
});
