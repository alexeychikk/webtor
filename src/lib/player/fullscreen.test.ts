import { describe, expect, it } from 'vitest';
import {
  assRenderMode,
  detectDisplayCapabilities,
  fullscreenMethod,
  type DisplayCapabilities,
  type DisplayEnvironment,
} from './fullscreen';

class Fake {}
const proto = (...keys: string[]) => ({ prototype: Object.fromEntries(keys.map((k) => [k, 1])) });

/** A desktop browser: workers, wasm, OffscreenCanvas and element fullscreen. */
const desktop = (over: Partial<DisplayEnvironment> = {}): DisplayEnvironment => ({
  Worker: Fake,
  WebAssembly: {},
  OffscreenCanvas: Fake,
  HTMLCanvasElement: proto('transferControlToOffscreen'),
  HTMLVideoElement: proto(),
  Element: proto('requestFullscreen'),
  document: { fullscreenEnabled: true },
  ...over,
});

/** iPhone Safari: everything JASSUB needs, but only the video element can go fullscreen. */
const iphone = desktop({
  Element: proto(),
  HTMLVideoElement: proto('webkitEnterFullscreen'),
  document: {},
});

const caps = (c: Partial<DisplayCapabilities>): DisplayCapabilities => ({
  styledAss: true,
  containerFullscreen: true,
  videoFullscreen: false,
  ...c,
});

describe('display capabilities', () => {
  it('detects a desktop browser', () => {
    expect(detectDisplayCapabilities(desktop())).toEqual({
      styledAss: true,
      containerFullscreen: true,
      videoFullscreen: false,
    });
  });

  it('detects iPhone Safari: no element fullscreen, video-only fullscreen', () => {
    expect(detectDisplayCapabilities(iphone)).toEqual({
      styledAss: true,
      containerFullscreen: false,
      videoFullscreen: true,
    });
  });

  it('accepts the webkit-prefixed Fullscreen API (older Safari)', () => {
    const env = desktop({
      Element: proto('webkitRequestFullscreen'),
      document: { webkitFullscreenEnabled: true },
    });
    expect(detectDisplayCapabilities(env).containerFullscreen).toBe(true);
  });

  it('has no container fullscreen when the page may not use it (iframe without allow)', () => {
    const env = desktop({ document: { fullscreenEnabled: false } });
    expect(detectDisplayCapabilities(env).containerFullscreen).toBe(false);
  });

  it('needs Worker, WebAssembly and OffscreenCanvas transfer for styled ASS', () => {
    expect(detectDisplayCapabilities(desktop({ Worker: undefined })).styledAss).toBe(false);
    expect(detectDisplayCapabilities(desktop({ WebAssembly: undefined })).styledAss).toBe(false);
    expect(detectDisplayCapabilities(desktop({ OffscreenCanvas: undefined })).styledAss).toBe(
      false,
    );
    expect(detectDisplayCapabilities(desktop({ HTMLCanvasElement: proto() })).styledAss).toBe(
      false,
    );
    expect(detectDisplayCapabilities({}).styledAss).toBe(false);
  });
});

describe('fullscreen button', () => {
  it('fullscreens the container where it can, else the video (iOS), else is hidden', () => {
    expect(fullscreenMethod(caps({}))).toBe('container');
    expect(fullscreenMethod(caps({ videoFullscreen: true }))).toBe('container');
    expect(fullscreenMethod(caps({ containerFullscreen: false, videoFullscreen: true }))).toBe(
      'video',
    );
    expect(fullscreenMethod(caps({ containerFullscreen: false }))).toBe('none');
  });
});

describe('ASS render mode (styled overlay or plain-text fallback)', () => {
  it('is styled where the container can go fullscreen', () => {
    expect(assRenderMode(caps({}), false)).toBe('styled');
    expect(assRenderMode(detectDisplayCapabilities(desktop()), false)).toBe('styled');
  });

  it('falls back to text on iOS (no container fullscreen)', () => {
    expect(assRenderMode(detectDisplayCapabilities(iphone), false)).toBe('text');
    expect(assRenderMode(caps({ containerFullscreen: false, videoFullscreen: true }), false)).toBe(
      'text',
    );
  });

  it('falls back to text while the bare video is fullscreen (it hides the overlay)', () => {
    expect(assRenderMode(caps({}), true)).toBe('text');
  });

  it('falls back to text when JASSUB cannot run', () => {
    expect(assRenderMode(caps({ styledAss: false }), false)).toBe('text');
  });
});
