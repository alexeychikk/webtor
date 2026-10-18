/**
 * Styled ASS/SSA rendering (docs/decisions/0004): JASSUB (libass in wasm) draws on a canvas laid
 * over the `<video>`, inside the player container. JASSUB is imported only when a track needs it.
 * Without cross-origin isolation (GitHub Pages can't send COOP/COEP) it runs single-threaded in its
 * worker. Times are on the element timeline, like the text tracks.
 */
import type JASSUB from 'jassub';
import workerUrl from 'jassub/dist/worker/worker.js?worker&url';
import wasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url';
import modernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm?url';
import defaultFontUrl from 'jassub/dist/default.woff2?url';
import type { SubtitleCue } from './cue';

/** Used for every font the script names that isn't attached (metric-compatible with Arial). */
const DEFAULT_FONT = 'liberation sans';

export interface AssOverlayOptions {
  /** A whole script, or (embedded tracks) the CodecPrivate header that events are added to. */
  script: string;
  /** Font files (MKV attachments), loaded before the first frame. */
  fonts?: readonly Uint8Array[];
}

export class AssOverlay {
  private destroyed = false;

  private constructor(
    private readonly jassub: JASSUB,
    readonly canvas: HTMLCanvasElement,
    private readonly video: HTMLVideoElement,
  ) {}

  /** Loads JASSUB and starts drawing over `video`; rejects when it can't run. */
  static async create(video: HTMLVideoElement, options: AssOverlayOptions): Promise<AssOverlay> {
    const { default: Jassub } = await import('jassub');
    const canvas = document.createElement('canvas');
    canvas.className = 'ass-overlay';
    canvas.dataset.testid = 'ass-canvas';
    canvas.hidden = true;
    // JASSUB sizes and places it over the video's picture, relative to their offset parent.
    video.after(canvas);
    let jassub: JASSUB | undefined;
    try {
      jassub = new Jassub({
        video,
        canvas,
        subContent: options.script,
        // Loaded before `ready`: a font fetched on demand shows only from the next frame, which
        // never comes while paused (JASSUB doesn't repaint when a late font arrives).
        fonts: [new URL(defaultFontUrl, document.baseURI).href, ...(options.fonts ?? [])],
        defaultFont: DEFAULT_FONT,
        // No local-font permission prompts and no Google Fonts lookups (privacy).
        queryFonts: false,
        workerUrl,
        wasmUrl: new URL(wasmUrl, document.baseURI).href,
        modernWasmUrl: new URL(modernWasmUrl, document.baseURI).href,
      });
      await jassub.ready;
    } catch (err) {
      await jassub?.destroy().catch(() => {});
      canvas.remove();
      throw err;
    }
    return new AssOverlay(jassub, canvas, video);
  }

  /** Adds embedded events (cues that carry `assChunk`); libass skips ones it already has. */
  addChunks(cues: readonly SubtitleCue[]) {
    if (this.destroyed) return;
    let added = false;
    for (const cue of cues) {
      if (cue.assChunk === undefined) continue;
      added = true;
      const start = Math.round(cue.start * 1000);
      const duration = Math.max(1, Math.round((cue.end - cue.start) * 1000));
      this.jassub.renderer.processChunk(cue.assChunk, start, duration).catch(warn);
    }
    // Paused: no new video frame will trigger a draw, so repaint for events at the playhead.
    if (added && this.video.paused) this.jassub.resize(true).catch(warn);
  }

  /** Fonts that arrived after the start (slow attachments); redraws with them. */
  addFonts(fonts: readonly Uint8Array[]) {
    if (this.destroyed || !fonts.length) return;
    this.jassub.renderer
      .addFonts([...fonts])
      .then(async () => {
        if (!this.destroyed) await this.jassub.resize(true);
      })
      .catch(warn);
  }

  /**
   * Draws every event `delay` seconds later (the subtitle delay; positive = later): libass renders
   * the script at `mediaTime − delay`.
   */
  setDelay(delay: number) {
    if (this.destroyed || this.jassub.timeOffset === -delay) return;
    this.jassub.timeOffset = -delay;
    this.jassub.resize(true).catch(warn);
  }

  setVisible(visible: boolean) {
    if (this.destroyed || this.canvas.hidden === !visible) return;
    this.canvas.hidden = !visible;
    if (visible) this.jassub.resize(true).catch(warn);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.canvas.remove();
    this.jassub.destroy().catch(warn);
  }
}

const warn = (err: unknown) => console.warn('subtitles: ASS renderer:', err);
