/**
 * The subtitle selector's state and its rendering into native text tracks (docs/decisions/0004).
 * Sources (embedded, sidecar, upload) register a track plus a loader; cues are loaded on first
 * selection and rendered as `VTTCue`s in one `TextTrack` per source. Text tracks can't be removed
 * from a `<video>`, so on `reset()` they are emptied, disabled and reused for a later source with
 * the same label and language.
 */
import { PlaybackError } from '../player/errors';
import type { SubtitleFileEntry, SubtitleTrackInfo } from '../player/types';
import type { SubtitleCue } from './cue';
import { guessLanguageFromFilename, isForcedFilename } from './language';
import { parseSubtitleFile, subtitleFormatOf } from './parse';
import { defaultSubtitleKey, subtitleTrackText, type SubtitlePreference } from './tracks';

const PREFERENCE_KEY = 'webtor:subtitle-language';
/** Text subtitles are tiny; anything bigger is not a subtitle file. */
export const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;

interface Source {
  info: SubtitleTrackInfo;
  load: () => Promise<SubtitleCue[]>;
  cues?: Promise<SubtitleCue[]>;
  track?: TextTrack;
}

export class SubtitleManager {
  /** Every listed track, in source order; group them with `groupSubtitleTracks`. */
  tracks = $state<SubtitleTrackInfo[]>([]);
  /** Selected track key; `null` = Off. */
  selected = $state<string | null>(null);
  /** Key whose cues are being fetched/parsed. */
  loading = $state<string | null>(null);
  notice = $state<PlaybackError | null>(null);

  private sources = new Map<string, Source>();
  private video: HTMLVideoElement | null = null;
  private generation = 0;
  private uploads = 0;
  /** Emptied tracks of earlier sources, reusable by label + language. */
  private pool: TextTrack[] = [];
  private listening: AbortController | null = null;

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
    this.tracks = [];
    this.selected = null;
    this.loading = null;
    this.notice = null;
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
    source.track ??= this.createTrack(source.info, cues);
    if (source.track) source.track.mode = 'showing';
  }

  private add(info: SubtitleTrackInfo, load: () => Promise<SubtitleCue[]>) {
    this.sources.set(info.key, { info, load });
    this.tracks = [...this.tracks, info];
  }

  private async applyDefault() {
    const key = defaultSubtitleKey(this.tracks, readPreference());
    if (key !== null && this.selected === null) await this.select(key, { remember: false });
  }

  private createTrack(
    info: SubtitleTrackInfo,
    cues: readonly SubtitleCue[],
  ): TextTrack | undefined {
    const video = this.video;
    if (!video) return undefined;
    const label = subtitleTrackText(info);
    const reuse = this.pool.findIndex((t) => t.label === label && t.language === info.language);
    const track =
      reuse >= 0
        ? this.pool.splice(reuse, 1)[0]!
        : video.addTextTrack('subtitles', label, info.language);
    track.mode = 'disabled';
    for (const cue of cues) track.addCue(toVttCue(cue));
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

function clearTrack(track: TextTrack) {
  track.mode = 'disabled';
  for (const cue of [...(track.cues ?? [])]) track.removeCue(cue);
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
