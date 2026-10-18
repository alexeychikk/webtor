/**
 * Drives one playback: torrent → file pick → MsePlayer, plus the status the UI shows
 * (phase, stats, notices, fatal error). One instance per page; `load()` replaces what is playing.
 */
import type { Torrent } from 'webtorrent/dist/webtorrent.min.js';
import { torrentByteSource } from '../torrent/byte-source';
import { addTorrent, destroyTorrent } from '../torrent/client';
import { listSubtitleFiles, pickVideoFile } from '../torrent/files';
import { SubtitleManager } from '../subtitles/manager.svelte';
import { isTorrentId } from '../torrent/trackers';
import { PlaybackError, type PlaybackErrorCode } from './errors';
import { MsePlayer, mediaSourceClass } from './mse-player';
import type { TorrentStats } from './types';
import { nextStarvedFor, watchdogNotice } from './watchdog';

/**
 * - `connecting`: looking for peers / metadata
 * - `metadata`: torrent info known, reading the video file's header
 * - `buffering`: the player waits for data
 * - `playing` / `paused`
 * - `error`: fatal, `error` says why
 */
export type Phase =
  'idle' | 'connecting' | 'metadata' | 'buffering' | 'playing' | 'paused' | 'error';

const TICK_MS = 1000;
const HAVE_FUTURE_DATA = 3;

export class PlayerController {
  phase = $state<Phase>('idle');
  stats = $state<TorrentStats>({ numPeers: 0, downloadSpeed: 0, uploadSpeed: 0, progress: 0 });
  /** Non-fatal conditions (`no-peers`, `stalled`, `no-playable-audio`, …). */
  notices = $state<PlaybackErrorCode[]>([]);
  error = $state<PlaybackError | null>(null);
  fileName = $state<string | null>(null);
  /** Subtitle selector state; sources are reset with every `load()`. */
  readonly subtitles = new SubtitleManager();

  private run = 0;
  private torrent: Torrent | null = null;
  private player: MsePlayer | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private videoEvents: AbortController | null = null;
  private startedAt = 0;
  private starvedFor = 0;
  private lastDownloaded = 0;

  /** Starts playing `input` (magnet or info hash) in `video`, replacing the current playback. */
  async load(input: string, video: HTMLVideoElement): Promise<void> {
    await this.stop();
    const run = ++this.run;
    this.video = video;
    this.subtitles.attach(video);
    this.phase = 'connecting';
    this.error = null;
    this.notices = [];
    this.fileName = null;
    this.stats = { numPeers: 0, downloadSpeed: 0, uploadSpeed: 0, progress: 0 };

    if (!isTorrentId(input)) return this.fail(new PlaybackError('invalid-input'));
    if (!mediaSourceClass()) return this.fail(new PlaybackError('no-mse'));
    // Web seeds and xs= still work without WebRTC, so this is a notice, not a failure.
    if (typeof RTCPeerConnection === 'undefined') this.notices = ['no-webrtc'];

    let torrent: Torrent;
    try {
      torrent = await addTorrent(input);
    } catch (err) {
      if (run === this.run) this.fail(new PlaybackError('torrent-failed', String(err)));
      return;
    }
    if (run !== this.run) return void destroyTorrent(torrent);
    this.torrent = torrent;
    this.startedAt = performance.now();
    this.starvedFor = 0;
    this.lastDownloaded = torrent.downloaded;
    torrent.on('error', (err) => {
      if (run === this.run) this.fail(new PlaybackError('torrent-failed', String(err)));
    });
    torrent.on('warning', (err) => console.warn('torrent:', err));
    torrent.on('metadata', () => {
      if (run === this.run && this.phase === 'connecting') this.phase = 'metadata';
    });
    this.timer = setInterval(() => this.tick(), TICK_MS);

    if (!torrent.ready) {
      await new Promise<void>((resolve) => torrent.once('ready', () => resolve()));
      if (run !== this.run) return;
    }
    this.phase = 'metadata';

    const pick = pickVideoFile(torrent.files);
    if (!pick.ok) return this.fail(new PlaybackError(pick.code));
    const file = torrent.files[pick.file.index]!;
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
    this.phase = 'buffering';
    this.watchVideo(video);
    video.play().catch((err: unknown) => {
      // Autoplay blocked (no user gesture, e.g. #magnet= on page load): wait for the play button.
      if (run === this.run && (err as Error)?.name === 'NotAllowedError') this.updatePhase();
    });
  }

  /** Stops playback and drops the torrent and its stored pieces. */
  async stop(): Promise<void> {
    this.run++;
    clearInterval(this.timer);
    this.videoEvents?.abort();
    this.videoEvents = null;
    this.player?.destroy();
    this.player = null;
    this.subtitles.reset();
    const torrent = this.torrent;
    this.torrent = null;
    this.phase = 'idle';
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
    this.stats = {
      numPeers: t.numPeers,
      downloadSpeed: t.downloadSpeed,
      uploadSpeed: t.uploadSpeed,
      progress: t.progress,
    };
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
