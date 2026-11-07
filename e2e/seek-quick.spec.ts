import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

// Quick seek streaks (←/→ pressed and held) on e2e/fixtures/resume/movie.mkv (40 s) with the
// piece-window.spec.ts settings, so every streak restarts the pipelines over evicted pieces. WebKit's
// GStreamer backend sometimes failed one with a fatal "Failed to send data for decoding": WebKit
// sets its decoders' `max-errors` to 0, so one packet avdec_h264 rejects is a MediaError DECODE
// (ADR 0003 "Decode errors"). The player then opens the file again where it was. That error can't be
// provoked on purpose, so the recovery tests raise one on the element. A real one sets the error,
// then closes the MediaSource, and the pipelines hit the removed SourceBuffers before the element's
// `error` event: `failingDecode` plays that order.

const video = (page: Page) => page.getByTestId('video');
const prop = <K extends keyof HTMLVideoElement>(page: Page, k: K) =>
  video(page).evaluate((v: HTMLVideoElement, k) => v[k], k) as Promise<HTMLVideoElement[K]>;

async function open(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('webtor:buffer-ahead-s', '4');
    localStorage.setItem('webtor:read-slack-bytes', '0');
    localStorage.setItem('webtor:read-cache-bytes', String(64 * 1024));
    localStorage.setItem('webtor:subtitle-language', 'off');
  });
  const magnet = await fixtureMagnet('resume');
  await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
  await expect(page.getByTestId('status')).toContainText('movie.mkv');
  await expect.poll(() => prop(page, 'currentTime'), { timeout: 30_000 }).toBeGreaterThan(0.5);
}

/** The seek completes and the playhead moves on from there, with no error. */
async function playsOn(page: Page, what: string) {
  await expect.poll(() => prop(page, 'seeking'), { message: what, timeout: 15_000 }).toBe(false);
  const at = await prop(page, 'currentTime');
  await expect
    .poll(() => prop(page, 'currentTime'), { message: what, timeout: 15_000 })
    .toBeGreaterThan(at + 0.5);
  await expect(page.getByTestId('error')).toHaveCount(0);
}

/**
 * Raises the element's `error` event as WebKit does on a decode error; returns `src` and time then.
 * With `on`, only while the element still plays that `src` (null if the player reopened since).
 */
type Raised = { src: string; at: number };
function decodeError(page: Page): Promise<Raised>;
function decodeError(page: Page, on: string): Promise<Raised | null>;
function decodeError(page: Page, on?: string): Promise<Raised | null> {
  return video(page).evaluate((v: HTMLVideoElement, on) => {
    if (on !== undefined && v.src !== on) return null;
    const before = { src: v.src, at: v.currentTime };
    Object.defineProperty(v, 'error', {
      configurable: true,
      get: () => ({ code: 3, message: 'Failed to send data for decoding' }),
    });
    v.dispatchEvent(new Event('error'));
    Reflect.deleteProperty(v, 'error');
    return before;
  }, on);
}

/**
 * A → streak, then a decode error on the player that ran it. A real engine decode error can reopen
 * the file first (the reason for this spec); then the streak settles and goes again from further back.
 */
async function decodeErrorAfterStreak(page: Page) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await prop(page, 'currentTime');
    const src = await prop(page, 'src');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    const raised = await decodeError(page, src);
    if (raised) return { ...raised, before };
    await playsOn(page, `real reopen during streak ${attempt}`);
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
    await playsOn(page, `back after streak ${attempt}`);
  }
  throw new Error('every streak reopened by itself before the decode error');
}

/** Keeps the page's MediaSource in `window.__mediaSource` for `failingDecode`. */
function keepMediaSource(page: Page) {
  return page.addInitScript(() => {
    for (const MS of [window.MediaSource, window.ManagedMediaSource]) {
      const add = MS?.prototype.addSourceBuffer;
      if (!MS || !add) continue;
      MS.prototype.addSourceBuffer = function (this: MediaSource, type: string) {
        (window as unknown as { __mediaSource: MediaSource }).__mediaSource = this;
        return add.call(this, type);
      };
    }
  });
}

/**
 * Fails like WebKit's decode error: `error` set and the SourceBuffers removed, so the pipelines
 * fail on them, with no `error` event (it comes later, if at all). A new `src` clears the error.
 */
function failingDecode(page: Page): Promise<{ at: number }> {
  return video(page).evaluate((v: HTMLVideoElement) => {
    const at = v.currentTime;
    Object.defineProperty(v, 'error', {
      configurable: true,
      get: () => ({ code: 3, message: 'Failed to send data for decoding' }),
    });
    const src = v.src;
    const reopened = new MutationObserver(() => {
      if (v.src === src) return;
      reopened.disconnect();
      Reflect.deleteProperty(v, 'error');
    });
    reopened.observe(v, { attributeFilter: ['src'] });
    const ms = (window as unknown as { __mediaSource: MediaSource }).__mediaSource;
    for (const sb of [...ms.sourceBuffers]) ms.removeSourceBuffer(sb);
    return { at };
  });
}

// Between ~10 s and ~37 s: a streak clamped to 0 met WebKit's start problems (CLAUDE.md "The start"),
// with this sandbox's decode errors at 0 s again and again (MAX_REOPENS, the error card).
test('quick seek streaks play on', async ({ page }) => {
  await open(page);
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight');
  await playsOn(page, 'away from the start');
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await playsOn(page, `→ streak ${r}`);
    await page.keyboard.press('ArrowLeft');
    await playsOn(page, `← ${r}`);
    await page.keyboard.down('ArrowLeft');
    await page.keyboard.down('ArrowLeft');
    await page.keyboard.up('ArrowLeft');
    await playsOn(page, `← auto-repeat ${r}`);
  }
});

test('a decode error during a streak opens the file again at the seek target', async ({ page }) => {
  await open(page);
  const { src, at, before } = await decodeErrorAfterStreak(page);
  expect(at).toBeGreaterThan(before + 5);
  await expect.poll(() => prop(page, 'src')).not.toBe(src);
  await playsOn(page, 'after the reopen');
  expect(await prop(page, 'currentTime')).toBeGreaterThan(at - 3);
  expect(await prop(page, 'paused')).toBe(false);

  // Recovered: a decode error elsewhere later reopens again.
  await page.keyboard.press('ArrowLeft');
  await playsOn(page, '←');
  await video(page).evaluate((v: HTMLVideoElement) => (v.currentTime = 34));
  await playsOn(page, 'far forward');
  const again = await decodeError(page);
  await expect.poll(() => prop(page, 'src')).not.toBe(again.src);
  await playsOn(page, 'after the second reopen');
});

test('a decode error that closes the MediaSource first opens the file again', async ({ page }) => {
  await keepMediaSource(page);
  await open(page);
  await expect.poll(() => prop(page, 'currentTime'), { timeout: 30_000 }).toBeGreaterThan(8);
  const src = await prop(page, 'src');
  const { at } = await failingDecode(page);
  await expect.poll(() => prop(page, 'src')).not.toBe(src);
  await playsOn(page, 'after the reopen');
  expect(await prop(page, 'currentTime')).toBeGreaterThan(at - 3);
  expect(await prop(page, 'paused')).toBe(false);
});

test('decode errors again and again at one spot end in the error card', async ({ page }) => {
  await open(page);
  // Away from the start without a seek: a reopen there can get stuck (CLAUDE.md "The start"),
  // and stuck seeks count towards the same reopens.
  await expect.poll(() => prop(page, 'currentTime'), { timeout: 30_000 }).toBeGreaterThan(10);
  for (let i = 0; i < 3; i++) {
    const { src } = await decodeError(page);
    await expect.poll(() => prop(page, 'src'), { message: `reopen ${i + 1}` }).not.toBe(src);
    await playsOn(page, `after reopen ${i + 1}`);
  }
  await decodeError(page);
  await expect(page.getByTestId('error')).toBeVisible();
  await expect(page.getByTestId('error')).toContainText('Failed to send data for decoding');
});
