/**
 * The subtitle selector's state and its rendering into native text tracks (docs/decisions/0004).
 * Sources (embedded, sidecar, upload) register a track plus a loader; cues are loaded on first
 * selection and rendered as `VTTCue`s in one `TextTrack` per source. Text tracks can't be removed
 * from a `<video>`, so on `reset()` they are emptied, disabled and reused for a later source with
 * the same label and language.
 *
 * ASS/SSA tracks are drawn by JASSUB on a canvas over the video (`AssOverlay`) when
 * `assRenderMode` allows it; otherwise (iOS, the bare video fullscreen, JASSUB failing) their
 * plain-text cues show in the text track as usual.
 */
import { PlaybackError } from '../player/errors';
import {
  assRenderMode,
  detectDisplayCapabilities,
  isVideoFullscreen,
  onFullscreenChange,
  type DisplayCapabilities,
} from '../player/fullscreen';
import { AssOverlay } from './ass-overlay';
import type { SubtitleFileEntry, SubtitleTrackInfo } from '../player/types';
import { shiftCues, SUBTITLE_DELAY_STEP_S, type SubtitleCue } from './cue';
import { guessLanguageFromFilename, isForcedFilename } from './language';
import { isAssFormat, readSubtitleFile, subtitleFormatOf } from './parse';
import { initialSubtitleKey, subtitleRef, type SubtitleTrackRef } from '../player/watch-state';
import { nextSubtitleKey, subtitleTrackText, type SubtitlePreference } from './tracks';

const PREFERENCE_KEY = 'webtor:subtitle-language';
/** Text subtitles are tiny; anything bigger is not a subtitle file. */
export const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;
/** The styled renderer starts without the attached fonts if they take longer (they follow later). */
const FONT_WAIT_MS = 15_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Source {
  info: SubtitleTrackInfo;
  load: (source: Source) => Promise<SubtitleCue[]>;
  cues?: Promise<SubtitleCue[]>;
  track?: TextTrack;
  /** The delay the track's cues are shifted by. */
  trackDelay?: number;
  /** Embedded tracks: every cue found so far; more arrive through `appendCues`. */
  live?: SubtitleCue[];
  /**
   * ASS/SSA the styled renderer can draw: the whole script (files, set when loaded) or the
   * CodecPrivate header (embedded, whose events come as cues with `assChunk`).
   */
  assScript?: string;
  /** Fonts for the styled renderer (embedded: the file's attachments). */
  fonts?: () => Promise<Uint8Array[]>;
  /** JASSUB could not run for this source: plain text from now on. */
  styledFailed?: boolean;
  /** Uploads: the file's text, kept with the video's watch state when the user picks it. */
  upload?: { name: string; text: string };
}

/** What the user picked, for the per-video watch state (watch-state.ts). */
export interface SubtitleChoiceListener {
  /** A track (`upload` set for a user's file) or Off (`null`). */
  choice(track: SubtitleTrackInfo | null, upload?: { name: string; text: string }): void;
  delay(seconds: number): void;
}

/** Styled options for embedded tracks, from the file's header. */
export interface EmbeddedAssOptions {
  /** Track key → its ASS/SSA header (CodecPrivate). */
  headers: ReadonlyMap<string, string>;
  /** The file's attached fonts (read once, on first use). */
  fonts: () => Promise<Uint8Array[]>;
}

interface OverlayEntry {
  key: string;
  /** `null` while JASSUB loads. */
  overlay: AssOverlay | null;
}

export class SubtitleManager {
  /** Every listed track, in source order; group them with `groupSubtitleTracks`. */
  tracks = $state<SubtitleTrackInfo[]>([]);
  /** Selected track key; `null` = Off. */
  selected = $state<string | null>(null);
  /** Key whose cues are being fetched/parsed. */
  loading = $state<string | null>(null);
  notice = $state<PlaybackError | null>(null);
  /** Seconds every cue is shifted by (positive = later); back to 0 for every new file. */
  delay = $state(0);

  private sources = new Map<string, Source>();
  private video: HTMLVideoElement | null = null;
  private generation = 0;
  private uploads = 0;
  /** Emptied tracks of earlier sources, reusable by label + language. */
  private pool: TextTrack[] = [];
  private listening: AbortController | null = null;
  /** Told which embedded track is selected (`null`: none), so its scanner runs only then. */
  private onEmbeddedSelect: ((key: string | null) => void) | null = null;
  /** The styled renderer of the selected ASS/SSA source, if it has one. */
  private overlay: OverlayEntry | null = null;
  private capabilities: DisplayCapabilities | null = null;
  private videoFullscreen = false;
  /**
   * This video's stored choice (watch-state.ts): a track, Off (`null`), or none (`undefined`: the
   * language default). `listed`: every source of the file is in, so a stored track that is still
   * missing is gone.
   */
  private stored: SubtitleTrackRef | null | undefined = undefined;
  private listed = false;
  /** Hears the user's choices (not defaults or restores). */
  listener: SubtitleChoiceListener | null = null;

  attach(video: HTMLVideoElement, capabilities = detectDisplayCapabilities()) {
    if (this.video === video) return;
    this.listening?.abort();
    this.destroyOverlay();
    this.video = video;
    this.capabilities = capabilities;
    this.listening = new AbortController();
    const { signal } = this.listening;
    // The native controls' captions menu can change modes too: follow it.
    video.textTracks.addEventListener('change', () => this.syncFromNative(), { signal });
    // The bare video going fullscreen hides the overlay: show ASS as text while it is.
    onFullscreenChange(
      video,
      () => {
        const fullscreen = isVideoFullscreen(video);
        if (fullscreen === this.videoFullscreen) return;
        this.videoFullscreen = fullscreen;
        const source = this.selectedSource();
        if (source?.track && this.loading === null) void this.refresh(source);
      },
      signal,
    );
  }

  /** Drops every source (a new torrent or file is loading). */
  reset() {
    this.generation++;
    for (const source of this.sources.values()) {
      if (!source.track) continue;
      clearTrack(source.track);
      this.pool.push(source.track);
    }
    this.sources.clear();
    this.destroyOverlay();
    this.onEmbeddedSelect = null;
    this.tracks = [];
    this.selected = null;
    this.loading = null;
    this.notice = null;
    this.delay = 0;
    this.stored = undefined;
    this.listed = false;
  }

  /**
   * After `reset()`, before the sources: what the user picked for this video last time (`stored`:
   * a track, `null` = Off, `undefined` = nothing) and the delay they set.
   */
  restore(stored: SubtitleTrackRef | null | undefined, delay = 0) {
    this.stored = stored;
    this.delay = Number.isFinite(delay) ? delay : 0;
  }

  /** Every source of the file is listed (embedded tracks read, or none): settles a pending restore. */
  listingDone() {
    this.listed = true;
    void this.applyDefault();
  }

  /**
   * Shifts the subtitles by `delay` seconds: the text track is refilled with shifted cues and the
   * styled overlay renders with a time offset.
   */
  async setDelay(delay: number): Promise<void> {
    this.delay = Math.round(delay * 1000) / 1000;
    this.listener?.delay(this.delay);
    const source = this.selectedSource();
    if (!source) return;
    if (this.overlay?.key === source.info.key) this.overlay.overlay?.setDelay(this.delay);
    if (!source.track) return;
    // Embedded: refill from every cue found so far (the scan keeps appending to `live`).
    if (source.live) return this.fillTrack(source, source.live);
    if (!source.cues) return;
    const cues = await source.cues;
    if (this.sources.get(source.info.key) === source) this.fillTrack(source, cues);
  }

  /** The ± buttons: `steps` × 0.5 s. */
  nudgeDelay(steps: number): Promise<void> {
    return this.setDelay(this.delay + steps * SUBTITLE_DELAY_STEP_S);
  }

  /** The `c` shortcut: next track in selector order, then Off. */
  cycle(): Promise<void> {
    return this.select(nextSubtitleKey(this.tracks, this.selected));
  }

  /** Lists the torrent's subtitle files and applies the default selection. */
  addSidecars(
    entries: readonly SubtitleFileEntry[],
    read: (entry: SubtitleFileEntry) => Promise<Uint8Array>,
  ) {
    for (const entry of entries) {
      this.add(
        {
          key: `sidecar:${entry.index}`,
          kind: 'sidecar',
          renderer: isAssFormat(subtitleFormatOf(entry.name)) ? 'ass' : 'text',
          language: guessLanguageFromFilename(entry.name),
          label: entry.name,
          forced: isForcedFilename(entry.name),
        },
        async (source) => {
          if (entry.length > MAX_SUBTITLE_BYTES) throw new Error(`${entry.name} is too large`);
          const file = readSubtitleFile(await read(entry), entry.name);
          if (isAssFormat(file.format)) source.assScript = file.text;
          return file.cues;
        },
      );
    }
    void this.applyDefault();
  }

  /**
   * Lists the playing file's embedded tracks and applies the default selection. Their cues arrive
   * over time through `appendCues`; `onSelect` hears the selected embedded key (or `null`).
   */
  addEmbedded(
    infos: readonly SubtitleTrackInfo[],
    onSelect: (key: string | null) => void,
    ass?: EmbeddedAssOptions,
  ) {
    for (const info of infos) {
      const source: Source = { info, load: () => Promise.resolve(source.live!), live: [] };
      const header = ass?.headers.get(info.key);
      if (header !== undefined) {
        source.assScript = header;
        source.fonts = ass!.fonts;
      }
      this.sources.set(info.key, source);
    }
    this.tracks = [...this.tracks, ...infos];
    this.onEmbeddedSelect = onSelect;
    const selected = this.selected === null ? undefined : this.sources.get(this.selected);
    onSelect(selected?.info.kind === 'embedded' ? selected.info.key : null);
    void this.applyDefault();
  }

  /** New cues of an embedded track (found by the cluster scanner). */
  appendCues(key: string, cues: readonly SubtitleCue[]) {
    const source = this.sources.get(key);
    if (!source?.live) return;
    source.live.push(...cues);
    // Drawn with the delay the track is filled with; a later `setDelay` refills from `live`. The
    // overlay takes them unshifted: it applies the delay as its time offset.
    if (source.track && source.trackDelay !== undefined) {
      addCues(source.track, shiftCues(cues, source.trackDelay));
    }
    if (this.overlay?.key === key) this.overlay.overlay?.addChunks(cues);
  }

  /** The embedded scan failed: cues found so far stay, the user is told the rest is missing. */
  embeddedFailed() {
    const source = this.selected === null ? undefined : this.sources.get(this.selected);
    if (source?.info.kind === 'embedded') {
      this.notice = new PlaybackError('subtitle-failed', source.info.label);
    }
  }

  /** Adds a user's file (input or drop) and selects it. */
  async addFile(file: File): Promise<void> {
    this.notice = null;
    if (!subtitleFormatOf(file.name) || file.size > MAX_SUBTITLE_BYTES) {
      this.notice = new PlaybackError('subtitle-failed', file.name);
      return;
    }
    const generation = this.generation;
    let parsed: ReturnType<typeof readSubtitleFile>;
    try {
      parsed = readSubtitleFile(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (err) {
      console.warn('subtitles:', err);
      if (generation === this.generation) {
        this.notice = new PlaybackError('subtitle-failed', file.name);
      }
      return;
    }
    if (generation !== this.generation) return;
    await this.select(this.addUpload(file.name, parsed));
  }

  /**
   * Re-adds the user's file stored with this video's watch state (not selected: the stored choice
   * decides). An unreadable one is dropped silently.
   */
  restoreUpload(name: string, text: string) {
    try {
      this.addUpload(name, readSubtitleFile(new TextEncoder().encode(text), name));
    } catch (err) {
      console.warn('subtitles: stored upload unreadable:', err);
    }
  }

  private addUpload(name: string, parsed: ReturnType<typeof readSubtitleFile>): string {
    const key = `upload:${++this.uploads}`;
    const ass = isAssFormat(parsed.format);
    this.add(
      {
        key,
        kind: 'upload',
        renderer: ass ? 'ass' : 'text',
        language: guessLanguageFromFilename(name),
        label: name,
      },
      () => Promise.resolve(parsed.cues),
    );
    const source = this.sources.get(key)!;
    if (ass) source.assScript = parsed.text;
    source.upload = { name, text: parsed.text };
    return key;
  }

  /** Selects a track (`null` = Off). `remember`: a user choice, stored as the preferred language. */
  async select(key: string | null, { remember = true } = {}): Promise<void> {
    const source = key === null ? undefined : this.sources.get(key);
    if (key !== null && (!source || source.info.unsupported)) return;
    this.selected = key;
    this.notice = null;
    if (remember) {
      rememberChoice(source?.info ?? null);
      this.stored = source ? subtitleRef(source.info) : null;
      this.listener?.choice(source?.info ?? null, source?.upload);
    }
    this.onEmbeddedSelect?.(source?.info.kind === 'embedded' ? key : null);
    // Hide the previous track right away, even if the new one still has to load.
    for (const s of this.sources.values()) if (s !== source && s.track) s.track.mode = 'disabled';
    if (this.overlay && this.overlay.key !== key) this.destroyOverlay();
    if (!source) {
      this.loading = null;
      return;
    }
    const generation = this.generation;
    this.loading = key;
    let cues: SubtitleCue[];
    try {
      source.cues ??= source.load(source);
      cues = await source.cues;
    } catch (err) {
      console.warn('subtitles:', err);
      source.cues = undefined; // Let the user retry.
      if (generation !== this.generation || this.selected !== key) return;
      this.loading = null;
      this.selected = null;
      this.notice = new PlaybackError('subtitle-failed', source.info.label);
      return;
    }
    if (generation !== this.generation || this.selected !== key) return;
    // Embedded: the cues found by now, including any that arrived while this awaited. The text
    // track is made for ASS too: it is the fallback when the overlay can't be seen.
    source.track ??= this.createTrack(source.info);
    if (source.track) this.fillTrack(source, source.live ?? cues);
    if (this.styled(source)) await this.showOverlay(source);
    if (generation !== this.generation || this.selected !== key) return;
    this.loading = null;
    this.render(source);
  }

  private add(info: SubtitleTrackInfo, load: (source: Source) => Promise<SubtitleCue[]>) {
    this.sources.set(info.key, { info, load });
    this.tracks = [...this.tracks, info];
  }

  private selectedSource(): Source | undefined {
    return this.selected === null ? undefined : this.sources.get(this.selected);
  }

  /** Should `source` be drawn by the styled renderer right now? */
  private styled(source: Source): boolean {
    return (
      source.assScript !== undefined &&
      !source.styledFailed &&
      this.capabilities !== null &&
      assRenderMode(this.capabilities, this.videoFullscreen) === 'styled'
    );
  }

  /** Shows the selected, loaded `source` as overlay or text track, whichever applies now. */
  private render(source: Source) {
    const styled = this.styled(source) && this.overlay?.key === source.info.key;
    this.overlay?.overlay?.setVisible(styled);
    if (source.track) source.track.mode = styled ? 'disabled' : 'showing';
  }

  /** `render`, creating the overlay first when the source turned styled (fullscreen left). */
  private async refresh(source: Source) {
    if (this.styled(source) && this.overlay?.key !== source.info.key) {
      await this.showOverlay(source);
      if (this.selectedSource() !== source || this.loading !== null) return;
    }
    this.render(source);
  }

  /** Creates the overlay of `source` if it has none; on failure it falls back to text for good. */
  private async showOverlay(source: Source): Promise<void> {
    const video = this.video;
    if (!video || this.overlay?.key === source.info.key) return;
    this.destroyOverlay();
    const entry: OverlayEntry = { key: source.info.key, overlay: null };
    this.overlay = entry;
    let overlay: AssOverlay;
    const fonts = (source.fonts?.() ?? Promise.resolve([])).catch((err: unknown) => {
      console.warn('subtitles: attached fonts unavailable:', err);
      return [];
    });
    let late = false;
    try {
      // Attachments usually sit at the end of the file: a slow swarm must not hold the subtitles.
      const ready = await Promise.race([fonts, delay(FONT_WAIT_MS).then(() => null)]);
      if (this.overlay !== entry) return;
      late = ready === null;
      overlay = await AssOverlay.create(video, { script: source.assScript!, fonts: ready ?? [] });
    } catch (err) {
      console.warn('subtitles: styled ASS unavailable, showing plain text:', err);
      source.styledFailed = true;
      if (this.overlay === entry) this.overlay = null;
      return;
    }
    if (this.overlay !== entry) {
      overlay.destroy();
      return;
    }
    entry.overlay = overlay;
    overlay.setDelay(this.delay);
    overlay.addChunks(source.live ?? []);
    if (late) void fonts.then((f) => this.overlay === entry && overlay.addFonts(f));
  }

  private destroyOverlay() {
    this.overlay?.overlay?.destroy();
    this.overlay = null;
  }

  /**
   * Selects this video's stored track (Off stays off), else the language default, unless something
   * is selected already. A stored track not listed yet waits for `listingDone`.
   */
  private async applyDefault() {
    if (this.selected !== null) return;
    const key = initialSubtitleKey(this.tracks, this.stored, readPreference(), this.listed);
    if (key !== null && key !== 'wait') await this.select(key, { remember: false });
  }

  /** (Re)fills the source's track with its cues shifted by the current delay, if not done yet. */
  private fillTrack(source: Source, cues: readonly SubtitleCue[]) {
    const track = source.track;
    if (!track || source.trackDelay === this.delay) return;
    clearTrack(track, track.mode);
    addCues(track, shiftCues(cues, this.delay));
    source.trackDelay = this.delay;
  }

  private createTrack(info: SubtitleTrackInfo): TextTrack | undefined {
    const video = this.video;
    if (!video) return undefined;
    const label = subtitleTrackText(info);
    const reuse = this.pool.findIndex((t) => t.label === label && t.language === info.language);
    const track =
      reuse >= 0
        ? this.pool.splice(reuse, 1)[0]!
        : video.addTextTrack('subtitles', label, info.language);
    track.mode = 'disabled';
    return track;
  }

  /** The user picked a track (or Off) in the native captions menu. */
  private syncFromNative() {
    const showing = [...this.sources.values()].find((s) => s.track?.mode === 'showing');
    for (const t of this.pool) if (t.mode === 'showing') t.mode = 'disabled';
    const current = this.selectedSource();
    const overlaid =
      current !== undefined && this.overlay?.key === current.info.key && this.styled(current);
    if (showing) {
      if (showing !== current) void this.select(showing.info.key);
      // Picked in the native menu while the overlay draws it: don't show it twice.
      else if (overlaid && this.loading === null) this.render(current);
      return;
    }
    // Still loading (no track yet) is not "turned off", nor is a track the overlay draws.
    if (current?.track && this.loading === null && !overlaid) void this.select(null);
  }
}

/** ASS drawings have no plain text: they are left out of the text track. */
function addCues(track: TextTrack, cues: readonly SubtitleCue[]) {
  for (const cue of cues) if (cue.text) track.addCue(toVttCue(cue));
}

/** Removes every cue, then sets `mode`. A disabled track's `cues` is null, so unhide it first. */
function clearTrack(track: TextTrack, mode: TextTrackMode = 'disabled') {
  if (track.mode === 'disabled') track.mode = 'hidden';
  for (const cue of [...(track.cues ?? [])]) track.removeCue(cue);
  track.mode = mode;
}

function toVttCue(cue: SubtitleCue): VTTCue {
  const vtt = new VTTCue(cue.start, cue.end, cue.text);
  const s = cue.settings;
  if (!s) return vtt;
  try {
    if (s.align) vtt.align = s.align as AlignSetting;
    if (s.vertical) vtt.vertical = s.vertical as DirectionSetting;
    if (s.size) vtt.size = parseFloat(s.size);
    if (s.position) vtt.position = parseFloat(s.position);
    if (s.line) {
      const line = s.line.split(',')[0]!;
      vtt.snapToLines = !line.endsWith('%');
      vtt.line = parseFloat(line);
    }
  } catch {
    // An out-of-range setting is ignored, like a browser parsing the .vtt itself would.
  }
  return vtt;
}

function readPreference(): SubtitlePreference {
  try {
    return localStorage.getItem(PREFERENCE_KEY);
  } catch {
    return null;
  }
}

function rememberChoice(info: SubtitleTrackInfo | null) {
  try {
    if (!info) localStorage.setItem(PREFERENCE_KEY, 'off');
    else if (info.language) localStorage.setItem(PREFERENCE_KEY, info.language);
  } catch {
    // Storage blocked: no preference, defaults still work.
  }
}
