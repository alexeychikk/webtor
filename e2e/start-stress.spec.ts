import { expect, test } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';

/**
 * Opt-in stress check of the start (CLAUDE.md "The start"): `STRESS_OPENS` fresh opens, each of
 * which must play past 1 s. Skipped unless `STRESS_OPENS` is set, e.g.
 * `STRESS_OPENS=120 pnpm exec playwright test --project=webkit start-stress`.
 * `STRESS_FIXTURE` picks the fixture (default sample.mkv). A failing open prints a log of the
 * element's events, its `currentTime` writes and the SourceBuffers' ranges; an open that needed
 * `onStuckSeek` (a second MediaSource) prints `REOPEN`. An open on one MediaSource must make at
 * most one seek (the gap jump) and no restart (no `SourceBuffer.remove`).
 */
const OPENS = Number(process.env.STRESS_OPENS || 0);
const FIXTURE = process.env.STRESS_FIXTURE || 'sample.mkv';

declare global {
  interface Window {
    __startLog: string[];
  }
}

test.describe('start stress', () => {
  test.skip(OPENS === 0, 'STRESS_OPENS not set');
  for (let i = 0; i < OPENS; i++) {
    test(`open ${i}`, async ({ page }) => {
      await page.addInitScript(() => {
        window.__startLog = [];
        const t0 = performance.now();
        const log = (s: string) => {
          if (window.__startLog.length < 400)
            window.__startLog.push(`${Math.round(performance.now() - t0)} ${s}`);
        };
        const ranges = (b: TimeRanges) =>
          Array.from(
            { length: b.length },
            (_, i) => `${b.start(i).toFixed(3)}-${b.end(i).toFixed(3)}`,
          ).join(',');
        const sbs: SourceBuffer[] = [];
        const add = MediaSource.prototype.addSourceBuffer;
        MediaSource.prototype.addSourceBuffer = function (mime: string) {
          const sb = add.call(this, mime);
          sbs.push(sb);
          log(`addSourceBuffer ${mime}`);
          sb.addEventListener('updateend', () =>
            log(`updateend ${sbs.indexOf(sb)} [${ranges(sb.buffered)}]`),
          );
          return sb;
        };
        const remove = SourceBuffer.prototype.remove;
        SourceBuffer.prototype.remove = function (start: number, end: number) {
          log(`remove ${sbs.indexOf(this)} ${start.toFixed(3)}-${end.toFixed(3)}`);
          remove.call(this, start, end);
        };
        const hooked = new WeakSet<HTMLMediaElement>();
        const hook = (v: HTMLMediaElement) => {
          if (hooked.has(v)) return;
          hooked.add(v);
          for (const e of [
            'loadedmetadata',
            'loadeddata',
            'canplay',
            'seeking',
            'seeked',
            'waiting',
            'playing',
            'error',
            'emptied',
          ])
            v.addEventListener(e, () =>
              log(
                `${e} t=${v.currentTime.toFixed(3)} rs=${v.readyState} seeking=${v.seeking} [${ranges(v.buffered)}]`,
              ),
            );
        };
        const ct = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!;
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
          ...ct,
          set(this: HTMLMediaElement, t: number) {
            log(`set currentTime ${t} rs=${this.readyState} [${ranges(this.buffered)}]`);
            ct.set!.call(this, t);
          },
        });
        const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!;
        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
          ...src,
          set(this: HTMLMediaElement, url: string) {
            hook(this);
            log('set src');
            src.set!.call(this, url);
          },
        });
      });
      await page.goto(`./#magnet=${encodeURIComponent(await fixtureMagnet(FIXTURE))}`);
      const video = page.getByTestId('video');
      const startLog = () => page.evaluate(() => window.__startLog);
      try {
        await expect
          .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 })
          .toBeGreaterThan(1);
      } catch (err) {
        const state = await video.evaluate((v: HTMLVideoElement) => ({
          t: v.currentTime,
          rs: v.readyState,
          seeking: v.seeking,
          paused: v.paused,
        }));
        console.log(`STALL open ${i}`, JSON.stringify(state), '\n' + (await startLog()).join('\n'));
        throw err;
      }
      const opened = (await startLog()).filter((l) => l.endsWith('set src')).length;
      if (opened > 1) {
        console.log(`REOPEN open ${i}: ${opened} MediaSources\n` + (await startLog()).join('\n'));
      } else {
        const log = await startLog();
        const seeks = log.filter((l) => / seeking t=/.test(l)).length;
        const removes = log.filter((l) => / remove \d/.test(l)).length;
        if (seeks > 1 || removes > 0) console.log(`START open ${i}\n` + log.join('\n'));
        expect(seeks, 'seeks at the start').toBeLessThanOrEqual(1);
        expect(removes, 'restarts at the start').toBe(0);
      }
    });
  }
});
