/**
 * Stereo downmix of transcoded audio (docs/decisions/0003 "Downmix"). Mediabunny's own remix only
 * knows 1, 2, 4 and 6 channels and keeps the first two of anything else (5.0, 6.1, 7.1: no centre,
 * so no dialogue), and its 5.1 mix isn't limited. So a transcode keeps the decoded layout and this
 * mixes it to stereo in the conversion's `process` step, before the encoder.
 */
import type { AudioSample } from 'mediabunny';

export type Speaker = 'L' | 'R' | 'C' | 'LFE' | 'Ls' | 'Rs' | 'Lb' | 'Rb' | 'Cs';

/**
 * The speaker of each decoded channel, by channel count. Every decoder we transcode with outputs
 * FFmpeg's native (WAV/SMPTE) order: `@mediabunny/ac3` (AC-3, E-AC-3) and `@mediabunny/dts` are
 * FFmpeg, and WebCodecs decoders use the same order. Decoded samples carry no layout, so counts
 * with two or more possible layouts take one with a centre (3: 3.0 not 2.1; 4: 4.0 = L R C Cs, not
 * quad or 3.1; 5: 5.0 not 4.1). So a 3.1's LFE or a quad's right surround reaches both outputs at
 * −6 dB (a quad's left surround, read as C, at −3 dB) rather than dialogue landing on one side.
 * Channels past 8 are dropped.
 */
export function decoderLayout(channels: number): Speaker[] {
  switch (channels) {
    case 1:
      return ['C'];
    case 2:
      return ['L', 'R'];
    case 3:
      return ['L', 'R', 'C'];
    case 4: // AC-3/DTS 3/1 (4.0: back centre); also read for 3.1 and quad
      return ['L', 'R', 'C', 'Cs'];
    case 5:
      return ['L', 'R', 'C', 'Ls', 'Rs'];
    case 6:
      return ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'];
    case 7: // 6.1 (DTS-ES, DTS-HD): back centre
      return ['L', 'R', 'C', 'LFE', 'Cs', 'Ls', 'Rs'];
    default: // 7.1 (DTS-HD, E-AC-3): back pair, then side pair
      return ['L', 'R', 'C', 'LFE', 'Lb', 'Rb', 'Ls', 'Rs'];
  }
}

const K = Math.SQRT1_2; // −3 dB

/** Gain of each speaker into the [left, right] output (ITU-R BS.775; LFE dropped). */
const GAINS: Record<Speaker, [number, number]> = {
  L: [1, 0],
  R: [0, 1],
  C: [K, K],
  LFE: [0, 0],
  Ls: [K, 0],
  Rs: [0, K],
  Lb: [K, 0],
  Rb: [0, K],
  Cs: [K * K, K * K], // split into Ls/Rs at −3 dB, each of those into L/R at −3 dB
};

/** Per decoded channel, its gain into [left, right]. Mono goes to both outputs at full level. */
export function stereoMatrix(channels: number): [number, number][] {
  if (channels === 1) return [[1, 1]];
  return decoderLayout(channels).map((s) => GAINS[s]);
}

/**
 * A peak limiter at `ceiling` (0 dBFS): instant attack, so no output sample exceeds it, and an
 * exponential release back to unity gain. Below the ceiling it changes nothing, so a stereo or
 * quiet surround source passes through as decoded. State spans the samples of one conversion.
 */
export class Limiter {
  private gain = 1;
  private readonly release: number;

  constructor(
    sampleRate: number,
    private readonly ceiling = 1,
    releaseS = 0.2,
  ) {
    this.release = 1 - Math.exp(-1 / (releaseS * sampleRate));
  }

  /** Limits interleaved stereo `data` in place. */
  process(data: Float32Array) {
    const { ceiling, release } = this;
    let gain = this.gain;
    for (let i = 0; i < data.length; i += 2) {
      const peak = Math.max(Math.abs(data[i]!), Math.abs(data[i + 1]!));
      gain += (1 - gain) * release;
      if (peak * gain > ceiling) gain = ceiling / peak;
      data[i]! *= gain;
      data[i + 1]! *= gain;
    }
    this.gain = gain;
  }
}

/** Mixes planar channels (one array per decoded channel, same length) into interleaved stereo. */
export function mixToStereo(planes: Float32Array[], matrix: [number, number][]): Float32Array {
  const frames = planes[0]?.length ?? 0;
  const out = new Float32Array(frames * 2);
  planes.forEach((plane, ch) => {
    const [gl, gr] = matrix[ch] ?? [0, 0];
    if (gl === 0 && gr === 0) return;
    for (let i = 0; i < frames; i++) {
      const x = plane[i]!;
      out[2 * i]! += gl * x;
      out[2 * i + 1]! += gr * x;
    }
  });
  return out;
}

/**
 * A Mediabunny `process` function (`ConversionAudioOptions.process`, with
 * `processedNumberOfChannels: 2`) that turns each decoded sample, in its own layout, into a limited
 * stereo sample. One per conversion (the limiter keeps state). `Sample` is `mb.AudioSample`
 * (Mediabunny is loaded lazily).
 */
export function stereoDownmixer(Sample: typeof AudioSample): (sample: AudioSample) => AudioSample {
  let limiter: Limiter | null = null;
  return (sample) => {
    const { numberOfChannels, numberOfFrames, sampleRate, timestamp } = sample;
    const planes = Array.from({ length: numberOfChannels }, (_, planeIndex) => {
      const plane = new Float32Array(numberOfFrames);
      sample.copyTo(plane, { planeIndex, format: 'f32-planar' });
      return plane;
    });
    const data = mixToStereo(planes, stereoMatrix(numberOfChannels));
    limiter ??= new Limiter(sampleRate);
    limiter.process(data);
    return new Sample({ data, format: 'f32', numberOfChannels: 2, sampleRate, timestamp });
  };
}
