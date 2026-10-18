/**
 * The subtitle selector's state and its rendering into native text tracks (docs/decisions/0004).
 * Sources (embedded, sidecar, upload) register a track plus a loader; cues are loaded on first
 * selection and rendered as `VTTCue`s in one `TextTrack` per source. Text tracks can't be removed
 * from a `<video>`, so on `reset()` they are emptied, disabled and reused for a later source with
 * the same label and language.
 */
import { PlaybackError } from '../player/errors';
import type { SubtitleFileEntry, SubtitleTrackInfo } from '../player/types';
import { shiftCues, SUBTITLE_DELAY_STEP_S, type SubtitleCue } from './cue';
import { guessLanguageFromFilename, isForcedFilename } from './language';
import { parseSubtitleFile, subtitleFormatOf } from './parse';
import {
  defaultSubtitleKey,
  nextSubtitleKey,
  subtitleTrackText,
  type SubtitlePreference,
} from './tracks';

const PREFERENCE_KEY = 'webtor:subtitle-language';
/** Text subtitles are tiny; anything bigger is not a subtitle file. */
export const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;

interface Source {
  info: SubtitleTrackInfo;
  load: () => Promise<SubtitleCue[]>;
  cues?: Promise<SubtitleCue[]>;
  track?: TextTrack;
  /** The delay the track's cues are shifted by. */
  trackDelay?: number;
  /** Embedded tracks: every cue found so far; more arrive through `appendCues`. */
  live?: SubtitleCue[];
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

  attach(video: HTMLVideoElement) {
    if (this.video === video) return;
    this.listening?.abort();
    this.video = video;
    this.listening = new AbortController();
    // The native controls' captions menu can change modes too: follow it.
    video.textTracks.addEventListener('change', () => this.syncFromNative(), {
      signal: this.listening.signal,
    });
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
    this.onEmbeddedSelect = null;
    this.tracks = [];
    this.selected = null;
    this.loading = null;
    this.notice = null;
    this.delay = 0;
  }

  /** Shifts the subtitles by `delay` seconds; the showing track is redrawn at once. */
  async setDelay(delay: number): Promise<void> {
    this.delay = Math.round(delay * 1000) / 1000;
    const source = this.selected === null ? undefined : this.sources.get(this.selected);
    if (!source?.track) return;
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
          renderer: 'text', // ASS/SSA as plain text until the JASSUB renderer lands.
          language: guessLanguageFromFilename(entry.name),
          label: entry.name,
          forced: isForcedFilename(entry.name),
        },
        async () => {
          if (entry.length > MAX_SUBTITLE_BYTES) throw new Error(`${entry.name} is too large`);
          return parseSubtitleFile(await read(entry), entry.name);
        },
      );
    }
    void this.applyDefault();
  }

  /**
   * Lists the playing file's embedded tracks and applies the default selection. Their cues arrive
   * over time through `appendCues`; `onSelect` hears the selected embedded key (or `null`).
   */
  addEmbedded(infos: readonly SubtitleTrackInfo[], onSelect: (key: string | null) => void) {
    for (const info of infos) {
      const source: Source = { info, load: () => Promise.resolve(source.live!), live: [] };
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
    // Drawn with the delay the track is filled with; a later `setDelay` refills from `live`.
    if (source.track && source.trackDelay !== undefined) {
      for (const cue of shiftCues(cues, source.trackDelay)) source.track.addCue(toVttCue(cue));
    }
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
    let cues: SubtitleCue[];
    try {
      cues = parseSubtitleFile(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (err) {
      console.warn('subtitles:', err);
      if (generation === this.generation) {
        this.notice = new PlaybackError('subtitle-failed', file.name);
      }
      return;
    }
    if (generation !== this.generation) return;
    const key = `upload:${++this.uploads}`;
    this.add(
      {
        key,
        kind: 'upload',
        renderer: 'text',
        language: guessLanguageFromFilename(file.name),
        label: file.name,
      },
      () => Promise.resolve(cues),
    );
    await this.select(key);
  }

  /** Selects a track (`null` = Off). `remember`: a user choice, stored as the preferred language. */
  async select(key: string | null, { remember = true } = {}): Promise<void> {
    const source = key === null ? undefined : this.sources.get(key);
    if (key !== null && (!source || source.info.unsupported)) return;
    this.selected = key;
    this.notice = null;
    if (remember) rememberChoice(source?.info ?? null);
    this.onEmbeddedSelect?.(source?.info.kind === 'embedded' ? key : null);
    // Hide the previous track right away, even if the new one still has to load.
    for (const s of this.sources.values()) if (s !== source && s.track) s.track.mode = 'disabled';
    if (!source) {
      this.loading = null;
      return;
    }
    const generation = this.generation;
    this.loading = key;
    let cues: SubtitleCue[];
    try {
      source.cues ??= source.load();
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
    this.loading = null;
    source.track ??= this.createTrack(source.info);
    if (!source.track) return;
    // Embedded: the cues found by now, including any that arrived while this awaited.
    this.fillTrack(source, source.live ?? cues);
    source.track.mode = 'showing';
  }

  private add(info: SubtitleTrackInfo, load: () => Promise<SubtitleCue[]>) {
    this.sources.set(info.key, { info, load });
    this.tracks = [...this.tracks, info];
  }

  private async applyDefault() {
    const key = defaultSubtitleKey(this.tracks, readPreference());
    if (key !== null && this.selected === null) await this.select(key, { remember: false });
  }

  /** (Re)fills the source's track with its cues shifted by the current delay, if not done yet. */
  private fillTrack(source: Source, cues: readonly SubtitleCue[]) {
    const track = source.track;
    if (!track || source.trackDelay === this.delay) return;
    clearTrack(track, track.mode);
    for (const cue of shiftCues(cues, this.delay)) track.addCue(toVttCue(cue));
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
    if (showing) {
      if (showing.info.key !== this.selected) void this.select(showing.info.key);
      return;
    }
    const current = this.selected === null ? undefined : this.sources.get(this.selected);
    // Still loading (no track yet) is not "turned off".
    if (current?.track && this.loading === null) void this.select(null);
  }
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
