/**
 * Contracts between the torrent layer, the media pipeline and the UI. See docs/decisions/0003 and 0004.
 * Implementations live next to this file (src/lib/player/*) and in src/lib/torrent/*.
 */

/** Random-access bytes of one file; backs a Mediabunny `CustomSource` and the subtitle extractor. */
export interface ByteSource {
  readonly size: number;
  /** Bytes [start, end) — end EXCLUSIVE (Mediabunny convention; convert for WebTorrent's inclusive end). */
  read(start: number, end: number): Promise<Uint8Array> | ReadableStream<Uint8Array>;
}

export interface VideoFileEntry {
  /** Index into `torrent.files`. */
  index: number;
  path: string;
  name: string;
  length: number;
}

export interface SubtitleFileEntry extends VideoFileEntry {
  format: 'srt' | 'vtt' | 'ass' | 'ssa';
}

export interface AudioTrackInfo {
  /** Mediabunny `InputTrack.id`. */
  id: number;
  codec: string | null;
  /** RFC 6381 string, e.g. `mp4a.40.2`, `ac-3`. */
  codecString: string | null;
  language: string;
  label: string;
  channels: number;
  isDefault: boolean;
  /** `copy`: MSE plays it as is; `transcode`: decoded + re-encoded in-browser; `unsupported`: greyed out. */
  playback: 'copy' | 'transcode' | 'unsupported';
  /** Mediabunny codec of what reaches MSE (`aac`, `opus`, …); `null` when unsupported. */
  outputCodec: string | null;
  /** Why an `unsupported` track can't play, for the selector. */
  reason?: string;
}

export type SubtitleSourceKind = 'embedded' | 'sidecar' | 'upload';

export interface SubtitleTrackInfo {
  /** Stable key for the selector, e.g. `embedded:3`, `sidecar:7`, `upload:1`. */
  key: string;
  kind: SubtitleSourceKind;
  /** `text` → native VTTCue track; `ass` → JASSUB canvas overlay. */
  renderer: 'text' | 'ass';
  /** Normalised language code (`normalizeLanguage`), "" when unknown. */
  language: string;
  /** Track name or file name; the selector adds the language (`subtitleTrackText`). */
  label: string;
  /** Embedded `FlagDefault`. */
  isDefault?: boolean;
  /** Embedded `FlagForced`, or `.forced.` in a sidecar filename. */
  forced?: boolean;
  /** Listed but not selectable (bitmap PGS / VobSub). */
  unsupported?: boolean;
}

export interface TorrentStats {
  numPeers: number;
  downloadSpeed: number;
  uploadSpeed: number;
  progress: number;
  /** Payload bytes received so far, and the torrent size once its info is known. */
  downloaded?: number;
  length?: number;
  /** Swarm peers behind the relay (included in `numPeers`); absent without a relay. */
  relayPeers?: number;
}

/** One playing file. Created per (torrent, file) pair; destroyed when the user picks another file. */
export interface PlaybackSession {
  readonly duration: number;
  readonly audioTracks: readonly AudioTrackInfo[];
  /** Grows while playing: embedded tracks are known up front, cues arrive as clusters are read. */
  readonly subtitleTracks: readonly SubtitleTrackInfo[];
  selectAudioTrack(id: number): Promise<void>;
  /** `null` = subtitles off. */
  selectSubtitleTrack(key: string | null): Promise<void>;
  addSubtitleFile(file: File): Promise<SubtitleTrackInfo>;
  destroy(): Promise<void>;
}
