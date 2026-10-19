/**
 * Fullscreen and styled-subtitle capabilities (docs/decisions/0004). The ASS overlay is a canvas next
 * to the `<video>`, so it stays visible only when the player container goes fullscreen. Where only
 * the video element can (iOS Safari), or while the bare video is fullscreen anyway (a browser's own
 * fullscreen control), ASS is shown as plain text in a native text track instead.
 */

export interface DisplayCapabilities {
  /** What JASSUB needs: Worker, WebAssembly and a canvas that can hand its drawing to a worker. */
  styledAss: boolean;
  /** An element (the player container) can go fullscreen. */
  containerFullscreen: boolean;
  /** Only the `<video>` itself can (`webkitEnterFullscreen`, iOS Safari). */
  videoFullscreen: boolean;
}

/** The globals feature detection looks at; `globalThis` in the browser, fakes in tests. */
export interface DisplayEnvironment {
  Worker?: unknown;
  WebAssembly?: unknown;
  OffscreenCanvas?: unknown;
  HTMLCanvasElement?: { prototype: object };
  HTMLVideoElement?: { prototype: object };
  Element?: { prototype: object };
  document?: { fullscreenEnabled?: boolean; webkitFullscreenEnabled?: boolean };
}

export function detectDisplayCapabilities(
  env: DisplayEnvironment = globalThis as DisplayEnvironment,
): DisplayCapabilities {
  const canvas = env.HTMLCanvasElement?.prototype ?? {};
  const element = env.Element?.prototype ?? {};
  const video = env.HTMLVideoElement?.prototype ?? {};
  const doc = env.document ?? {};
  return {
    styledAss:
      typeof env.Worker === 'function' &&
      typeof env.WebAssembly === 'object' &&
      typeof env.OffscreenCanvas === 'function' &&
      'transferControlToOffscreen' in canvas,
    containerFullscreen:
      (doc.fullscreenEnabled === true || doc.webkitFullscreenEnabled === true) &&
      ('requestFullscreen' in element || 'webkitRequestFullscreen' in element),
    videoFullscreen: 'webkitEnterFullscreen' in video,
  };
}

/** What the player's fullscreen control does: the container, the bare video (iOS), or none. */
export type FullscreenMethod = 'container' | 'video' | 'none';

export function fullscreenMethod(caps: DisplayCapabilities): FullscreenMethod {
  if (caps.containerFullscreen) return 'container';
  return caps.videoFullscreen ? 'video' : 'none';
}

/**
 * Which controls the player shows: always our own control layer (docs/decisions/0008), never the
 * native `controls`. Its fullscreen icon fullscreens the container where it can (the ASS overlay
 * stays over the picture), the bare video on iPhone (`enterVideoFullscreen`), and is absent where
 * neither can (`fullscreenMethod` = `none`).
 */
export function controlsFor(_method: FullscreenMethod): 'own' {
  return 'own';
}

/** How an ASS/SSA track is drawn right now: libass on the overlay canvas, or plain text cues. */
export function assRenderMode(
  caps: DisplayCapabilities,
  /** The `<video>` element itself is fullscreen (it hides the overlay). */
  videoIsFullscreen: boolean,
): 'styled' | 'text' {
  return caps.styledAss && caps.containerFullscreen && !videoIsFullscreen ? 'styled' : 'text';
}

// DOM glue: the Fullscreen API with Safari's `webkit` prefix.

interface WebkitDocument {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
}
interface WebkitElement {
  webkitRequestFullscreen?: () => void;
}
interface WebkitVideo {
  webkitEnterFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
}

export function fullscreenElement(): Element | null {
  return document.fullscreenElement ?? (document as WebkitDocument).webkitFullscreenElement ?? null;
}

export async function enterFullscreen(element: Element): Promise<void> {
  if (element.requestFullscreen) await element.requestFullscreen();
  else (element as WebkitElement).webkitRequestFullscreen?.();
}

export async function exitFullscreen(): Promise<void> {
  if (document.exitFullscreen) await document.exitFullscreen();
  else (document as WebkitDocument).webkitExitFullscreen?.();
}

/** iOS: the video element's own fullscreen (the only one there). */
export function enterVideoFullscreen(video: HTMLVideoElement) {
  (video as WebkitVideo).webkitEnterFullscreen?.();
}

/** Is the bare `<video>` fullscreen (Fullscreen API or iOS's video-only mode)? */
export function isVideoFullscreen(video: HTMLVideoElement): boolean {
  return (
    fullscreenElement() === video || (video as WebkitVideo).webkitDisplayingFullscreen === true
  );
}

/** Calls `onChange` whenever anything enters or leaves fullscreen, until `signal` aborts. */
export function onFullscreenChange(
  video: HTMLVideoElement,
  onChange: () => void,
  signal: AbortSignal,
) {
  for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(type, onChange, { signal });
  }
  for (const type of ['webkitbeginfullscreen', 'webkitendfullscreen']) {
    video.addEventListener(type, onChange, { signal });
  }
}
