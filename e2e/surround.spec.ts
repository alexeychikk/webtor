import { expect, test, type Page } from '@playwright/test';
import { fixtureMagnet } from './support/fixtures';
import { closeMenu, openMenu, selectAudio } from './support/player';

// surround.mkv: one tone per 5.1(side) channel (scripts/make-fixtures.sh). The transcoded stereo
// must carry C in both outputs at about −3 dB, Ls only in L and Rs only in R (ADR 0003 "Downmix").
const TONES = { L: 400, R: 600, C: 1000, Ls: 1400, Rs: 1800 } as const;
type Levels = Record<keyof typeof TONES, [number, number]>;

const video = (page: Page) => page.getByTestId('video');
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);

/**
 * Routes the `<video>` through Web Audio (splitter → one analyser per output channel) and returns
 * the peak level in dB of every tone in L and R, as the mean over ~2 s of playback.
 */
async function toneLevels(page: Page): Promise<Levels> {
  return video(page).evaluate(async (v: HTMLVideoElement, tones) => {
    const ctx = new AudioContext();
    await ctx.resume();
    const src = ctx.createMediaElementSource(v);
    const split = ctx.createChannelSplitter(2);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    src.connect(split);
    const analysers = [0, 1].map((i) => {
      const a = ctx.createAnalyser();
      a.fftSize = 8192;
      a.smoothingTimeConstant = 0;
      split.connect(a, i);
      a.connect(sink);
      return a;
    });
    const binHz = ctx.sampleRate / 8192;
    const sums = Object.fromEntries(Object.keys(tones).map((k) => [k, [0, 0]])) as Record<
      string,
      [number, number]
    >;
    const reads = 12;
    const spectrum = new Float32Array(4096);
    for (let n = 0; n < reads; n++) {
      await new Promise((r) => setTimeout(r, 180));
      analysers.forEach((a, ch) => {
        a.getFloatFrequencyData(spectrum);
        for (const [name, hz] of Object.entries(tones)) {
          const bin = Math.round(hz / binHz);
          let peak = -Infinity;
          for (let b = bin - 3; b <= bin + 3; b++) peak = Math.max(peak, spectrum[b]!);
          sums[name]![ch]! += peak / reads;
        }
      });
    }
    return sums as Levels;
  }, TONES);
}

async function expectStereoDownmix(page: Page) {
  // Measure while the transcoded track plays (8 s fixture: from ~1 s to ~3.5 s).
  await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.8);
  const levels = await toneLevels(page);
  console.log(`levels (dB, [L, R]) ${JSON.stringify(levels)}`);
  const { L, R, C, Ls, Rs } = levels;
  // The front channels stay where they are.
  expect(L[0] - L[1]).toBeGreaterThan(20);
  expect(R[1] - R[0]).toBeGreaterThan(20);
  // Centre: in both outputs, equally loud, about −3 dB under a front channel of the same level.
  expect(Math.abs(C[0] - C[1])).toBeLessThan(1.5);
  expect(C[0] - L[0]).toBeGreaterThan(-6);
  expect(C[0] - L[0]).toBeLessThan(-1);
  expect(C[1] - R[1]).toBeGreaterThan(-6);
  expect(C[1] - R[1]).toBeLessThan(-1);
  // Surrounds: Ls into L only, Rs into R only, also at about −3 dB.
  expect(Ls[0] - Ls[1]).toBeGreaterThan(20);
  expect(Rs[1] - Rs[0]).toBeGreaterThan(20);
  expect(Ls[0] - L[0]).toBeGreaterThan(-6);
  expect(Rs[1] - R[1]).toBeGreaterThan(-6);
}

for (const track of ['DTS 5.1', 'AC-3 5.1', 'E-AC-3 5.1', 'DTS 5.0']) {
  test(`${track} downmixes to stereo with the centre channel in both outputs`, async ({ page }) => {
    const magnet = await fixtureMagnet('surround.mkv');
    await page.goto(`./#magnet=${encodeURIComponent(magnet)}`);
    await expect.poll(() => currentTime(page), { timeout: 30_000 }).toBeGreaterThan(0.3);
    const option = (await openMenu(page, 'audio-track')).getByRole('option', {
      name: new RegExp(`^${track.replace(/[.-]/g, '\\$&')} · `),
    });
    const id = (await option.getAttribute('data-value'))!;
    if ((await option.getAttribute('aria-selected')) === 'true') {
      await closeMenu(page);
    } else {
      // Picked once, the track is remembered (ADR 0009): a reload starts on it, from 0, so no old
      // track is left buffered under the measurement.
      await selectAudio(page, { value: id });
      await expect(video(page)).toHaveAttribute('data-audio-track', id);
      const watched = () =>
        page.evaluate(() =>
          Object.keys(localStorage)
            .filter((k) => k.startsWith('webtor:watch:'))
            .map((k) => localStorage.getItem(k))
            .join(),
        );
      await expect.poll(watched).toContain('"audio"');
      await page.reload();
    }
    await expect(video(page)).toHaveAttribute('data-audio-track', id);
    await expect(video(page)).toHaveAttribute('data-audio-codec', 'opus');
    await expectStereoDownmix(page);
    await expect(page.getByTestId('error')).toHaveCount(0);
  });
}
