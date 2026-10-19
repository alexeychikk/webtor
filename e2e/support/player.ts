import { expect, type Locator, type Page } from '@playwright/test';

let jitter = 0;
/** Moves the pointer over the player, which shows the (auto-hiding) control layer for 1 s. */
export async function wakeControls(page: Page) {
  const box = (await page.getByTestId('screen').boundingBox())!;
  jitter = (jitter + 1) % 20;
  await page.mouse.move(box.x + box.width / 2 + jitter, box.y + box.height / 3);
}

/** Menu test ids by their trigger's (docs/decisions/0008 §9). */
const MENUS: Record<string, string> = {
  subtitles: 'subtitles-menu',
  'audio-track': 'audio-menu',
  'files-button': 'files-panel',
  'stats-button': 'stats-panel',
  'more-button': 'more-menu',
};

/** Opens the menu of a control-bar trigger (`subtitles`, `audio-track`, …) unless it is open. */
export async function openMenu(page: Page, trigger: string): Promise<Locator> {
  const menu = page.getByTestId(MENUS[trigger]!);
  if (await menu.isVisible()) return menu;
  await wakeControls(page);
  await page.getByTestId(trigger).click();
  await expect(menu).toBeVisible();
  return menu;
}

/** Closes whatever menu is open (Esc). */
export async function closeMenu(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-player-menu]')).toHaveCount(0);
}

type Pick = { label: string | RegExp } | { value: string };

async function pick(page: Page, trigger: string, testid: string, by: Pick) {
  const menu = await openMenu(page, trigger);
  const option =
    'value' in by
      ? menu.locator(`[data-testid="${testid}"][data-value="${by.value}"]`)
      : menu.getByRole('option', { name: by.label, exact: typeof by.label === 'string' });
  await option.click();
  await expect(page.locator('[data-player-menu]')).toHaveCount(0);
}

/** Picks a subtitle track (or Off) in the subtitles menu, by its text or its key. */
export const selectSubtitle = (page: Page, by: Pick) =>
  pick(page, 'subtitles', 'subtitle-option', by);

/** Picks an audio track in the audio menu, by its accessible name or its track id. */
export const selectAudio = (page: Page, by: Pick) => pick(page, 'audio-track', 'audio-option', by);

/** Opens the subtitles menu and returns the options of one group (`Embedded`, `In torrent`, …). */
export async function subtitleGroup(page: Page, label: string): Promise<Locator> {
  const menu = await openMenu(page, 'subtitles');
  return menu.getByRole('group', { name: label }).getByRole('option');
}
