/**
 * Drives one playback: torrent → file pick → MsePlayer, plus the status the UI shows
 * (phase, stats, notices, fatal error). One instance per page; `load()` replaces what is playing,
 * `selectFile()` swaps the file within the same torrent (a fresh MsePlayer, same torrent).
 */
import type { Torrent } from 'webtorrent/dist/webtorrent.min.js';
import { torrentByteSource } from '../torrent/byte-source';
import { addRelayTorrent, addTorrent, addTorrentFile, destroyTorrent } from '../torrent/client';
import {
  listSubtitleFiles,
  listVideoFiles,
  pickVideoFile,
  type VideoFileListEntry,
} from '../torrent/files';
import {
  mergeRelayStats,
  relayEndpoints,
  relayTorrentRef,
  type RelayStats,
} from '../torrent/relay';
import { fetchRelayMetainfo, fetchRelayStats } from '../torrent/relay-client';
import { relaySettings } from '../torrent/relay-settings.svelte';
import { SubtitleManager } from '../subtitles/manager.svelte';
import { isTorrentId } from '../torrent/trackers';
import { rememberAudioLanguage } from './audio-preference';
import { PlaybackError, type PlaybackErrorCode } from './errors';
import { MsePlayer, mediaSourceClass } from './mse-player';
import type { AudioTrackInfo, TorrentStats } from './types';
import { nextStarvedFor, watchdogNotice } from './watchdog';

/**
 * - `connecting`: looking for peers / metadata (with a relay: waiting for the relay's metainfo)
 * - `metadata`: torrent info known, reading the video file's header
 * - `buffering`: the player waits for data
 * - `playing` / `paused`
 * - `error`: fatal, `error` says why
 */
export type Phase =
  'idle' | 'connecting' | 'metadata' | 'buffering' | 'playing' | 'paused' | 'error';

const TICK_MS = 1000;
const RELAY_STATS_MS = 2000;
const NO_STATS: TorrentStats = { numPeers: 0, downloadSpeed: 0, uploadSpeed: 0, progress: 0 };
const HAVE_FUTURE_DATA = 3;
/** Notices about the torrent, not the file: they survive a file switch. */
const TORRENT_NOTICES: readonly PlaybackErrorCode[] = ['no-webrtc', 'no-peers', 'stalled'];

/** A magnet link or info hash, or the bytes of a .torrent file the user opened. */
export type TorrentInput = string | Uint8Array;

/** Cheap sanity check before WebTorrent parses it: a .torrent is a bencoded dictionary. */
const looksLikeTorrentFile = (bytes: Uint8Array) =>
  bytes.length > 0 && bytes.length <= 16 * 1024 * 1024 && bytes[0] === 0x64; /* 'd' */

export class PlayerController {
  phase = $state<Phase>('idle');
  stats = $state<TorrentStats>({ numPeers: 0, downloadSpeed: 0, uploadSpeed: 0, progress: 0 });
  /** Non-fatal conditions (`no-peers`, `stalled`, `no-playable-audio`, …). */
  notices = $state<PlaybackErrorCode[]>([]);
  error = $state<PlaybackError | null>(null);
  fileName = $state<string | null>(null);
  audioTracks = $state<readonly AudioTrackInfo[]>([]);
  /** Selected audio track (`AudioTrackInfo.id`); `null` when the video plays muted. */
  audioTrackId = $state<number | null>(null);
  /** Codec the audio SourceBuffer gets (`aac`, `opus`, …): differs from the track's when transcoded. */
  audioCodec = $state<string | null>(null);
  /** Subtitle selector state; sources are reset with every `load()`. */
  readonly subtitles = new SubtitleManager();
  /** This playback goes through the user's relay (docs/decisions/0006). */
  viaRelay = $state(false);
  /** Video files of the torrent (playable and greyed-out unsupported ones), once its info is known. */
  files = $state<readonly VideoFileListEntry[]>([]);
  /** Index into the torrent's files of the file being played (`#file=`). */
  fileIndex = $state<number | null>(null);
  /** Magnet for the URL hash: the input, or for an opened .torrent file its magnet once known. */
  magnet = $state<string | null>(null);

  /** Bumped by every load, file switch, stop and failure: async work of an older one bails out. */
  private run = 0;
  private input: TorrentInput | null = null;
  private torrent: Torrent | null = null;
  private player: MsePlayer | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private videoEvents: AbortController | null = null;
  private startedAt = 0;
  private starvedFor = 0;
  private lastDownloaded = 0;
  private relayAbort: AbortController | null = null;
  private relayTimer: ReturnType<typeof setInterval> | undefined;
  private relayStats: RelayStats | null = null;

  /**
   * Starts playing `input` (magnet, info hash or .torrent bytes) in `video`, replacing the current
   * playback. `fileIndex` (from `#file=`) picks the file when it is playable; else the largest video.
   */
  load(input: TorrentInput, video: HTMLVideoElement, fileIndex: number | null = null) {
    return this.start(input, video, fileIndex, []);
  }

  /**
   * Plays another file of the torrent: the current MsePlayer (MediaSource, SourceBuffers,
   * conversions) and subtitle sources are torn down and a fresh one opens on the same torrent.
   * After a fatal error the torrent is gone, so it is loaded again on that file.
   */
  async selectFile(index: number): Promise<void> {
    const entry = this.files.find((f) => f.index === index);
    const video = this.video;
    if (!entry || entry.kind !== 'playable' || !video || this.input === null) return;
    const torrent = this.torrent;
    if (!torrent || this.phase === 'error') {
      return this.start(this.input, video, index, this.files);
    }
    if (index === this.fileIndex) return;
    const run = ++this.run;
    this.closeFile();
    this.phase = 'metadata';
    this.starvedFor = 0;
    this.lastDownloaded = torrent.downloaded;
    await this.openFile(run, torrent, index);
  }

  private async start(
    input: TorrentInput,
    video: HTMLVideoElement,
    fileIndex: number | null,
    files: readonly VideoFileListEntry[],
  ): Promise<void> {
    await this.stop();
    const run = ++this.run;
    this.input = input;
    this.video = video;
    this.subtitles.attach(video);
    this.phase = 'connecting';
    this.error = null;
    this.notices = [];
    this.fileName = null;
    this.files = files;
    this.fileIndex = files.length ? fileIndex : null;
    this.magnet = typeof input === 'string' ? input.trim() : null;
    this.resetFileState();
    this.stats = NO_STATS;
    // An opened .torrent already has the info dict, so it goes straight to WebTorrent.
    const relayBase = typeof input === 'string' ? relaySettings.base : null;
    this.viaRelay = relayBase !== null;
    this.relayStats = null;

    const valid = typeof input === 'string' ? isTorrentId(input) : looksLikeTorrentFile(input);
    if (!valid) return this.fail(new PlaybackError('invalid-input'));
    if (!mediaSourceClass()) return this.fail(new PlaybackError('no-mse'));
    // Web seeds and xs= still work without WebRTC, so this is a notice, not a failure.
    if (typeof RTCPeerConnection === 'undefined') this.notices = ['no-webrtc'];

    let torrent: Torrent;
    try {
      if (typeof input !== 'string') torrent = await addTorrentFile(input);
      else if (relayBase) torrent = await this.addViaRelay(input, relayBase);
      else torrent = await addTorrent(input);
    } catch (err) {
      if (run === this.run) {
        this.fail(
          err instanceof PlaybackError ? err : new PlaybackError('torrent-failed', String(err)),
        );
      }
      return;
    }
    if (run !== this.run) return void destroyTorrent(torrent);
    this.torrent = torrent;
    this.startedAt = performance.now();
    this.starvedFor = 0;
    this.lastDownloaded = torrent.downloaded;
    torrent.on('error', (err) => {
      if (torrent !== this.torrent) return;
      // WebTorrent's word for a .torrent file it cannot parse.
      const unreadable = typeof input !== 'string' && /invalid torrent/i.test(String(err));
      this.fail(new PlaybackError(unreadable ? 'invalid-input' : 'torrent-failed', String(err)));
    });
    torrent.on('warning', (err) => console.warn('torrent:', err));
    torrent.on('metadata', () => {
      if (torrent === this.torrent && this.phase === 'connecting') this.phase = 'metadata';
    });
    this.timer = setInterval(() => this.tick(), TICK_MS);

    if (!torrent.ready) {
      await new Promise<void>((resolve) => torrent.once('ready', () => resolve()));
      if (run !== this.run) return;
    }
    this.phase = 'metadata';
    this.files = listVideoFiles(torrent.files);
    if (typeof input !== 'string') this.magnet = torrent.magnetURI;

    const pick = pickVideoFile(torrent.files, fileIndex);
    if (!pick.ok) return this.fail(new PlaybackError(pick.code));
    await this.openFile(run, torrent, pick.file.index);
  }

  /** Opens file `index` of `torrent` in a new MsePlayer, with its sidecar subtitles. */
  private async openFile(run: number, torrent: Torrent, index: number): Promise<void> {
    const video = this.video!;
    const file = torrent.files[index]!;
    this.fileIndex = index;
    this.fileName = file.name;
    this.subtitles.addSidecars(listSubtitleFiles(torrent.files, file.name), async (entry) => {
      const sidecar = torrent.files[entry.index];
      if (!sidecar) throw new Error(`no file ${entry.index}`);
      return new Uint8Array(await sidecar.arrayBuffer());
    });

    let player: MsePlayer;
    try {
      player = await MsePlayer.open(video, torrentByteSource(file), {
        onError: (err) => {
          if (run === this.run) this.fail(err);
        },
        isStale: () => run !== this.run,
      });
    } catch (err) {
      if (run === this.run) {
        this.fail(err instanceof PlaybackError ? err : new PlaybackError('playback-failed'));
      }
      return;
    }
    if (run !== this.run) return player.destroy();
    this.player = player;
    this.notices = [...this.notices, ...player.notices];
    this.audioTracks = player.audioTracks;
    this.audioTrackId = player.audioTrackId;
    this.audioCodec = player.audioCodec;
    this.phase = 'buffering';
    this.watchVideo(video);
    video.play().catch((err: unknown) => {
      // Autoplay blocked (no user gesture, e.g. #magnet= on page load): wait for the play button.
      if (run === this.run && (err as Error)?.name === 'NotAllowedError') this.updatePhase();
    });
  }

  /** Tears down the playing file (MsePlayer and its SourceBuffers, subtitle sources), keeps the torrent. */
  private closeFile() {
    this.videoEvents?.abort();
    this.videoEvents = null;
    this.player?.destroy();
    this.player = null;
    this.subtitles.reset();
    this.fileName = null;
    this.resetFileState();
    this.notices = this.notices.filter((n) => TORRENT_NOTICES.includes(n));
  }

  private resetFileState() {
    this.audioTracks = [];
    this.audioTrackId = null;
    this.audioCodec = null;
  }

  /** Switches the audio track (video keeps playing) and remembers its language for next time. */
  async selectAudioTrack(id: number): Promise<void> {
    const player = this.player;
    const track = this.audioTracks.find((t) => t.id === id);
    if (!player || !track || id === this.audioTrackId) return;
    this.audioTrackId = id;
    const others = () => this.notices.filter((n) => n !== 'audio-convert-failed');
    try {
      await player.selectAudioTrack(id);
      if (player !== this.player) return;
      rememberAudioLanguage(track.language);
      this.notices = others();
    } catch (err) {
      if (player !== this.player) return;
      console.warn(err);
      this.notices = [...others(), 'audio-convert-failed'];
    }
    // A newer switch may have superseded this one; show what the player actually plays.
    this.audioTrackId = player.audioTrackId;
    this.audioCodec = player.audioCodec;
  }

  /**
   * The relay joins the swarm (TCP/uTP/DHT/trackers) and hands over the info dict; WebTorrent then
   * gets the data through the relay's web seed, plus any WebRTC peers. The relay's swarm stats are
   * polled for the UI from the start, so "finding peers" shows how many it found.
   */
  private async addViaRelay(input: string, base: string): Promise<Torrent> {
    const ref = relayTorrentRef(input);
    if (!ref) throw new PlaybackError('invalid-input');
    const urls = relayEndpoints(base, ref.infoHash, ref.magnetQuery);
    const abort = new AbortController();
    this.relayAbort = abort;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const stats = await fetchRelayStats(urls.stats, abort.signal);
      polling = false;
      if (abort.signal.aborted || !stats) return;
      this.relayStats = stats;
      if (!this.torrent) this.stats = mergeRelayStats(NO_STATS, 0, stats);
    };
    this.relayTimer = setInterval(() => void poll(), RELAY_STATS_MS);
    const torrentFile = await fetchRelayMetainfo(urls.metainfo, abort.signal);
    void poll();
    return addRelayTorrent(torrentFile, input, [urls.webseed, ...ref.ws]);
  }

  private stopRelay() {
    clearInterval(this.relayTimer);
    this.relayAbort?.abort();
    this.relayAbort = null;
  }

  /** Stops playback and drops the torrent and its stored pieces. */
  async stop(): Promise<void> {
    this.run++;
    clearInterval(this.timer);
    this.stopRelay();
    this.videoEvents?.abort();
    this.videoEvents = null;
    this.player?.destroy();
    this.player = null;
    this.subtitles.reset();
    const torrent = this.torrent;
    this.torrent = null;
    this.phase = 'idle';
    this.files = [];
    this.fileIndex = null;
    if (torrent) await destroyTorrent(torrent);
  }

  private fail(err: PlaybackError) {
    if (this.phase === 'error') return;
    // Invalidate this run, so pending awaits in `load()` (e.g. `MsePlayer.open`) bail out.
    this.run++;
    console.warn(err);
    this.error = err;
    this.phase = 'error';
    this.player?.destroy();
    this.player = null;
    this.subtitles.reset();
    clearInterval(this.timer);
    this.stopRelay();
    // A fatal error ends this playback: stop downloading.
    const torrent = this.torrent;
    this.torrent = null;
    if (torrent) void destroyTorrent(torrent);
  }

  private watchVideo(video: HTMLVideoElement) {
    this.videoEvents = new AbortController();
    const { signal } = this.videoEvents;
    for (const type of ['playing', 'waiting', 'pause', 'play', 'seeking', 'seeked', 'canplay']) {
      video.addEventListener(type, () => this.updatePhase(), { signal });
    }
  }

  private updatePhase() {
    const v = this.video;
    if (!v || !this.player || this.phase === 'error' || this.phase === 'idle') return;
    const ready = v.readyState >= HAVE_FUTURE_DATA && !v.seeking;
    if (v.paused) this.phase = ready || v.ended ? 'paused' : 'buffering';
    else this.phase = ready ? 'playing' : 'buffering';
  }

  private tick() {
    const t = this.torrent;
    if (!t) return;
    const stats = {
      numPeers: t.numPeers,
      downloadSpeed: t.downloadSpeed,
      uploadSpeed: t.uploadSpeed,
      progress: t.progress,
    };
    const webSeeds = t.wires.filter((w) => w.type === 'webSeed').length;
    this.stats = mergeRelayStats(stats, webSeeds, this.relayStats);
    const waitingForData = this.phase === 'metadata' || this.phase === 'buffering';
    this.starvedFor = nextStarvedFor(this.starvedFor, {
      waiting: waitingForData,
      downloaded: t.downloaded,
      lastDownloaded: this.lastDownloaded,
      dt: TICK_MS,
    });
    this.lastDownloaded = t.downloaded;
    const notice = watchdogNotice({
      elapsed: performance.now() - this.startedAt,
      hasMetadata: Boolean(t.files?.length),
      numPeers: t.numPeers,
      starvedFor: this.starvedFor,
    });
    const others = this.notices.filter((n) => n !== 'no-peers' && n !== 'stalled');
    const next = notice ? [notice, ...others] : others;
    if (next.join() !== this.notices.join()) this.notices = next;
  }
}
