import { describe, expect, it } from 'vitest';
import { silentAacFrame } from './silence';

const hex = (u: Uint8Array | null) =>
  u ? Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('') : null;

describe('silentAacFrame', () => {
  it('picks the frame by the channel configuration of an AAC-LC config', () => {
    // AAC-LC, 44.1 kHz, mono, with the explicit "no SBR" extension ffmpeg writes.
    expect(hex(silentAacFrame(new Uint8Array([0x12, 0x08, 0x56, 0xe5, 0x00])))).toBe('01182007');
    // AAC-LC, 48 kHz, stereo.
    expect(hex(silentAacFrame(new Uint8Array([0x11, 0x90])))).toBe('211004608c1c');
    // AAC-LC, 48 kHz, 5.1.
    expect(hex(silentAacFrame(new Uint8Array([0x11, 0xb0])))).toBe(
      '011820010880230460231004608c0c230000e0',
    );
  });

  it('declines anything but AAC-LC with a standard channel configuration', () => {
    expect(silentAacFrame(null)).toBeNull();
    expect(silentAacFrame(new Uint8Array([0x12]))).toBeNull();
    // HE-AAC (object type 5).
    expect(silentAacFrame(new Uint8Array([0x2b, 0x92, 0x08, 0x00]))).toBeNull();
    // Channel configuration 0 (layout in a PCE).
    expect(silentAacFrame(new Uint8Array([0x11, 0x80]))).toBeNull();
    // Explicit sampling frequency.
    expect(silentAacFrame(new Uint8Array([0x17, 0x80, 0x00, 0x00, 0x00]))).toBeNull();
  });
});
