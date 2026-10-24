import { AudioSample } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { decoderLayout, Limiter, mixToStereo, stereoDownmixer, stereoMatrix } from './downmix';

const K = Math.SQRT1_2;

/** One constant plane per channel: channel i holds `values[i]`. */
const planes = (values: number[], frames = 4) =>
  values.map((v) => new Float32Array(frames).fill(v));

/** [left, right] of the first output frame when only `speaker` of `layout` carries 1.0. */
function route(channels: number, speaker: string): [number, number] {
  const layout = decoderLayout(channels);
  const out = mixToStereo(
    planes(layout.map((s) => (s === speaker ? 1 : 0))),
    stereoMatrix(channels),
  );
  return [out[0]!, out[1]!];
}

// Decoded layouts per transcoded codec, in FFmpeg's native order (`@mediabunny/ac3` and
// `@mediabunny/dts` are FFmpeg decoders): the channel counts each codec delivers.
const CODECS: Record<string, Record<string, number>> = {
  dts: { '5.0': 5, '5.1': 6, '6.1 (ES)': 7, '7.1 (HD)': 8 },
  ac3: { '3.0': 3, '5.0': 5, '5.1': 6 },
  eac3: { '5.1': 6, '7.1': 8 },
};

describe('stereo downmix per transcoded codec', () => {
  for (const [codec, layouts] of Object.entries(CODECS)) {
    for (const [name, channels] of Object.entries(layouts)) {
      it(`${codec} ${name}: C in both outputs at −3 dB, surrounds to their side, LFE dropped`, () => {
        const layout = decoderLayout(channels);
        expect(layout).toHaveLength(channels);
        expect(route(channels, 'L')).toEqual([1, 0]);
        expect(route(channels, 'R')).toEqual([0, 1]);
        const [cl, cr] = route(channels, 'C');
        expect(cl).toBeCloseTo(K, 5);
        expect(cr).toBeCloseTo(K, 5);
        expect(20 * Math.log10(cl)).toBeCloseTo(-3, 0);
        if (layout.includes('Ls')) {
          expect(route(channels, 'Ls')[0]).toBeCloseTo(K, 5);
          expect(route(channels, 'Ls')[1]).toBe(0);
          expect(route(channels, 'Rs')[0]).toBe(0);
          expect(route(channels, 'Rs')[1]).toBeCloseTo(K, 5);
        }
        if (layout.includes('LFE')) expect(route(channels, 'LFE')).toEqual([0, 0]);
      });
    }
  }

  it('maps the FFmpeg channel orders', () => {
    expect(decoderLayout(6)).toEqual(['L', 'R', 'C', 'LFE', 'Ls', 'Rs']);
    expect(decoderLayout(7)).toEqual(['L', 'R', 'C', 'LFE', 'Cs', 'Ls', 'Rs']);
    expect(decoderLayout(8)).toEqual(['L', 'R', 'C', 'LFE', 'Lb', 'Rb', 'Ls', 'Rs']);
  });

  it('6.1: the back centre reaches both outputs at −6 dB', () => {
    const [l, r] = route(7, 'Cs');
    expect(l).toBeCloseTo(0.5, 5);
    expect(r).toBeCloseTo(0.5, 5);
  });

  it('7.1: the back pair goes to its side at −3 dB', () => {
    expect(route(8, 'Lb')[0]).toBeCloseTo(K, 5);
    expect(route(8, 'Lb')[1]).toBe(0);
    expect(route(8, 'Rb')[1]).toBeCloseTo(K, 5);
    expect(route(8, 'Rb')[0]).toBe(0);
  });

  it('stereo passes through and mono goes to both outputs, unchanged', () => {
    expect(Array.from(mixToStereo(planes([0.25, -0.5], 1), stereoMatrix(2)))).toEqual([0.25, -0.5]);
    expect(Array.from(mixToStereo(planes([0.3], 1), stereoMatrix(1)))).toEqual([
      Math.fround(0.3),
      Math.fround(0.3),
    ]);
  });

  it('drops channels past 8', () => {
    expect(stereoMatrix(10)).toHaveLength(8);
    const out = mixToStereo(planes([0, 0, 0, 0, 0, 0, 0, 0, 1, 1]), stereoMatrix(10));
    expect(Array.from(out).every((x) => x === 0)).toBe(true);
  });
});

describe('Limiter', () => {
  it('leaves a signal under 0 dBFS untouched', () => {
    const data = new Float32Array([0.5, -0.9, 1, -1, 0.1, 0.2]);
    const before = Array.from(data);
    new Limiter(48_000).process(data);
    expect(Array.from(data)).toEqual(before);
  });

  it('keeps every sample of a hot mix at or under 0 dBFS, then recovers', () => {
    const limiter = new Limiter(48_000, 1, 0.01);
    const loud = new Float32Array(2000).map((_, i) => (i % 2 ? -2.4 : 2.4) * Math.sin(i / 7));
    limiter.process(loud);
    expect(Math.max(...Array.from(loud, Math.abs))).toBeLessThanOrEqual(1 + 1e-6);
    // 0.1 s of quiet later (10 time constants), the gain is back to unity.
    const quiet = new Float32Array(9600).fill(0.1);
    limiter.process(quiet);
    expect(quiet[quiet.length - 1]).toBeCloseTo(0.1, 4);
  });

  it('carries its gain over from one sample to the next', () => {
    const limiter = new Limiter(48_000);
    limiter.process(new Float32Array([4, 4]));
    const next = new Float32Array([0.8, 0.8]);
    limiter.process(next);
    expect(next[0]).toBeLessThan(0.8);
  });
});

describe('stereoDownmixer (Mediabunny process step)', () => {
  it('turns a planar 5.1 sample into a limited interleaved stereo sample', () => {
    const frames = 8;
    //               L    R    C    LFE  Ls   Rs
    const values = [0.2, 0.1, 0.4, 0.9, 0.3, 0];
    const data = new Float32Array(frames * 6);
    values.forEach((v, ch) => data.fill(v, ch * frames, (ch + 1) * frames));
    const sample = new AudioSample({
      data,
      format: 'f32-planar',
      numberOfChannels: 6,
      sampleRate: 48_000,
      timestamp: 3.5,
    });
    const out = stereoDownmixer(AudioSample)(sample);
    expect(out.numberOfChannels).toBe(2);
    expect(out.numberOfFrames).toBe(frames);
    expect(out.sampleRate).toBe(48_000);
    expect(out.timestamp).toBe(3.5);
    const stereo = new Float32Array(frames * 2);
    out.copyTo(stereo, { planeIndex: 0, format: 'f32' });
    expect(stereo[0]).toBeCloseTo(0.2 + K * 0.4 + K * 0.3, 5);
    expect(stereo[1]).toBeCloseTo(0.1 + K * 0.4, 5);
    sample.close();
    out.close();
  });

  it('limits a hot 7.1 mix so the encoder never gets a clipped sample', () => {
    const frames = 16;
    const sample = new AudioSample({
      data: new Float32Array(frames * 8).fill(0.9),
      format: 'f32-planar',
      numberOfChannels: 8,
      sampleRate: 48_000,
      timestamp: 0,
    });
    const out = stereoDownmixer(AudioSample)(sample);
    const stereo = new Float32Array(frames * 2);
    out.copyTo(stereo, { planeIndex: 0, format: 'f32' });
    expect(Math.max(...Array.from(stereo, Math.abs))).toBeLessThanOrEqual(1 + 1e-6);
    sample.close();
    out.close();
  });
});
