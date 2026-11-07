/**
 * MSE glue (docs/decisions/0003): one Mediabunny `Input` over the torrent file, one `Conversion` per
 * SourceBuffer (video copy; audio copy or transcode) remuxing to fragmented MP4. Decisions live in
 * pure modules (`codecs.ts`, `buffer.ts`); this file only wires them to the DOM.
 */
import type { Conversion, Input, InputVideoTrack } from 'mediabunny';
import {
  appendChunk,
  initSegmentBytes,
  MIN_AHEAD_S,
  newQuotaState,
  resetFrom,
  simulateQuota,
  startAt,
  whenIdle,
  type AppendHost,
  type QuotaState,
} from './append';
import {
  aheadOf,
  atBufferedEnd,
  BUFFER_AHEAD_S,
  endLost,
  endSnap,
  endOfStreamIn,
  bufferedToEnd,
  END_SLACK_S,
  endedBefore,
  gapJumpTarget,
  isBuffered,
  lastAtOrBefore,
  quotaEvictionRanges,
  trackStart,
  type Ranges,
} from './buffer';
import { preferredAudioLanguage } from './audio-preference';
import { loadCodecExtensions, loadEncoder } from './codec-extensions';
import {
  decideAudio,
  decideVideo,
  pickLoadableAudioTrack,
  pickTranscodeTarget,
  TRANSCODE_AUDIO,
  type AudioDecision,
  silencePlans,
  type SilencePlan,
  type TranscodeTarget,
} from './codecs';
import { aheadWithin } from '../torrent/piece-window';
import { ByteWindow, trackedSource, type ByteRange, type ReadRole } from './byte-window';
import { stereoDownmixer } from './downmix';
import { ByteReader } from '../subtitles/mkv/reader';
import { readCuePoints, readMkvHeader } from '../subtitles/mkv/header';
import type { ByteTimeIndex, ByteTimePoint } from './byte-time';
import {
  doviConfigOf,
  dolbyVisionPlayback,
  isDolbyVisionSampleEntry,
  type DolbyVisionPlayback,
} from './dolby-vision';
import { PlaybackError, type PlaybackErrorCode } from './errors';
import { hdrFormatOf, type HdrFormat } from './hdr';
import { AAC_FRAME_SAMPLES, silentAacFrame } from './silence';
import {
  MAX_REMOTE_RESUMES,
  REMOTE_KEYFRAME_INTERVAL_S,
  REMOTE_VIDEO_MIME,
  REMOTE_WARMUP_MS,
  remoteResumePoint,
  transcodeSlow,
  type RemoteVideo,
} from './remote-video';
import {
  appendOffset,
  elementDuration,
  restartPoint,
  timeline,
  toSourceTime,
  type Timeline,
} from './timeline';
import type { AudioTrackInfo, ByteSource } from './types';

type Mediabunny = typeof import('mediabunny');

/**
 * Dolby Vision (docs/decisions/0010). Mediabunny doesn't see it: MKV carries the configuration
 * record in the track's `BlockAdditionMapping` (read with our EBML header pass), and MP4's DV-only
 * sample entries (`dvh1`, `dvhe`…) come out as an unknown codec. `detail` names the profile or entry.
 */
async function dolbyVisionOf(
  mb: Mediabunny,
  input: Input,
  track: InputVideoTrack,
  source: ByteSource,
): Promise<(DolbyVisionPlayback & { detail: string }) | null> {
  if ((await track.getCodec()) === null) {
    const entry = String((await track.getInternalCodecId()) ?? '');
    return isDolbyVisionSampleEntry(entry)
      ? { kind: 'unsupported', profile: '', detail: entry }
      : null;
  }
  if (!((await input.getFormat()) instanceof mb.MatroskaInputFormat)) return null;
  const header = await readMkvHeader(new ByteReader(source)).catch((err: unknown) => {
    console.warn('Dolby Vision check: MKV header unreadable', err);
    return null;
  });
  const entry = header?.videoTracks.find((t) => t.number === track.id);
  const config = doviConfigOf(entry?.blockAdditionMappings ?? []);
  if (!config) return null;
  const playback = dolbyVisionPlayback(config);
  return { ...playback, detail: `profile ${playback.profile}` };
}

declare global {
  // Safari 17+ (and iOS 17.1+, where it is the only MSE). Not in lib.dom yet.
  var ManagedMediaSource: typeof MediaSource | undefined;
}

/** `ManagedMediaSource` where the browser has it (Safari), else `MediaSource`, else null. */
export function mediaSourceClass(): { MS: typeof MediaSource; managed: boolean } | null {
  if (typeof globalThis.ManagedMediaSource === 'function') {
    return { MS: globalThis.ManagedMediaSource, managed: true };
  }
  if (typeof globalThis.MediaSource === 'function') return { MS: MediaSource, managed: false };
  return null;
}

/** Thrown into a stale pipeline's output stream to stop it after a seek or destroy. */
class StalePipeline extends Error {}

const SEEK_DEBOUNCE_MS = 150;
/** Bit rate of the silence after an audio track that ends before the video (`fillSilence`). */
const SILENCE_BITRATE = 64_000;
/** A seek with its target buffered in every SourceBuffer is stuck after this long (`onStuckSeek`). */
const STUCK_SEEK_MS = 4000;
/**
 * The same for the start's gap jump (`openStartGate`), which normally completes in ~0.2 s: a stuck
 * one costs the user this long before the file opens again.
 */
const START_STUCK_SEEK_MS = 1500;
/** The longest the other pipelines wait for the video's first media (`startGate`). */
const START_GATE_MAX_MS = 5000;
/** The longest a seek waits for the element to end (`holdSeek`); the rest is at most `EOS_AHEAD_S`. */
const HELD_SEEK_MAX_MS = 1000;

/** e2e: 0 lets the small fixtures exercise the piece window (ADR 0012). */
function readSlackBytes(): number | undefined {
  try {
    const value = localStorage.getItem('webtor:read-slack-bytes');
    return value === null ? undefined : Number(value);
  } catch {
    return undefined;
  }
}

/** e2e: a small demuxer cache without prefetch, so the small fixtures are read piece by piece. */
function readCacheBytes(): number | undefined {
  try {
    return Number(localStorage.getItem('webtor:read-cache-bytes')) || undefined;
  } catch {
    return undefined;
  }
}

/** e2e uses a few seconds so the 12 s fixture exercises back-pressure and seek restarts. */
function bufferAheadSeconds(): number {
  try {
    return Number(localStorage.getItem('webtor:buffer-ahead-s')) || BUFFER_AHEAD_S;
  } catch {
    return BUFFER_AHEAD_S;
  }
}

/** e2e: a Safari-like SourceBuffer quota in bytes (`simulateQuota`), 0 = the browser's own. */
function simulatedQuotaBytes(): number {
  try {
    return Number(localStorage.getItem('webtor:sb-quota-bytes')) || 0;
  } catch {
    return 0;
  }
}

declare global {
  /** e2e: quota hits under `webtor:sb-quota-bytes`. */
  var __webtorQuotaHits: number | undefined;
}

interface Pipeline {
  kind: 'video' | 'audio';
  trackId: number;
  sb: SourceBuffer;
  /** MIME type the next start needs; `sbMime` is what the SourceBuffer is set to (`changeType`). */
  mime: string;
  sbMime: string;
  /** Audio only: copy or transcode. */
  decision?: AudioDecision;
  /** Video converted by the relay (ADR 0007 §2) instead of a local `Conversion`. */
  remote?: RemoteState;
  /** Bumped on every (re)start; work belonging to an older generation stops. */
  gen: number;
  conversion: Conversion | null;
  done: boolean;
  /**
   * Element time where the track's media ends, NaN until known: from the packet lookup of a restart
   * past it (`startOf`), or where the SourceBuffer's media ends once a run appended through the end.
   */
  end: number;
  /**
   * Element time of the newest fragment the current conversion produced (Mediabunny's `onMoof`,
   * which fires before the fragment reaches `append`); -Infinity before the first one.
   */
  writtenTo: number;
  /**
   * Audio switch: the previous track stays buffered up to here while the new one overwrites it.
   * Until `writtenTo` passes it, `sb.buffered` mostly shows the old track, so back-pressure
   * follows `writtenTo` instead. -Infinity when nothing is being replaced.
   */
  replaceUntil: number;
  /** `QuotaExceededError` back-pressure (append.ts). */
  quota: QuotaState;
  /**
   * Local video: element times of the fragments appended (each starts on a keyframe), ascending.
   * Under quota, eviction behind the playhead ends on one of them.
   */
  keyframes: number[];
}

interface RemoteState {
  /** Ends the current relay request (seek, restart, destroy). */
  abort: AbortController | null;
  /** `performance.now()` when the relay answered the current request (`null` before), for `transcodeSlow`. */
  startedAt: number | null;
  /** Stream cuts in a row without data in between (see `MAX_REMOTE_RESUMES`). */
  cuts: number;
}

export interface MsePlayerOptions {
  /** Fatal error after `open` resolved (pipeline or media element failure). */
  onError(err: PlaybackError): void;
  /**
   * True once a newer playback took over the element (e.g. the user picked another file while this
   * one was opening): `open` then rejects instead of attaching its MediaSource over the newer one.
   */
  isStale?(): boolean;
  /**
   * Asked when the browser can't decode the video (DivX/Xvid AVI): the relay's conversion to use, or
   * a rejection with a `relay-*` `PlaybackError`. Without it such a file fails with `video-needs-relay`.
   */
  remoteVideo?(): Promise<RemoteVideo>;
  /** A non-fatal condition that came up while playing (e.g. `relay-transcode-slow`). */
  onNotice?(code: PlaybackErrorCode): void;
  /** The audio track the user picked for this video before (watch-state.ts), if still there. */
  restoreAudio?(tracks: readonly AudioTrackInfo[]): AudioTrackInfo | null;
  /**
   * Resume (watch-state.ts): element time to start at, given the element-timeline duration (NaN if
   * unknown); null = from the start. Not asked for an AVI without an index (seeks can't reach far).
   */
  startAt?(duration: number): number | null;
  /**
   * A seek has not completed `STUCK_SEEK_MS` after every SourceBuffer held its target (WebKit's
   * GStreamer backend can lose one, CLAUDE.md "The start"): the element never recovers, so the
   * owner opens the file again at `t` in a new MsePlayer. Asked at most once per player.
   */
  onStuckSeek?(t: number): void;
  /**
   * The element lost its end (`endLost`, WebKit's GStreamer backend) and the user seeks to `t` or
   * plays (from 0): it can do neither, so the owner opens the file again at `t` in a new MsePlayer.
   */
  onLostEnd?(t: number, play: boolean): void;
  /**
   * Bytes the piece store may hold (ADR 0012): the ahead target shrinks so that much media at the
   * file's mean rate fits (`aheadWithin`).
   */
  windowBytes?: number;
}

export class MsePlayer {
  readonly audioTracks: readonly AudioTrackInfo[];
  /** Non-fatal conditions to show next to the player, e.g. `no-playable-audio`. */
  readonly notices: readonly PlaybackErrorCode[];
  /** HDR format of the video (its colour tags pass through the remux, ADR 0010); null = SDR. */
  hdr: HdrFormat | null = null;
  private readonly pipelines: Pipeline[] = [];
  private destroyed = false;
  private seekTimer: ReturnType<typeof setTimeout> | undefined;
  private eosTimer: ReturnType<typeof setTimeout> | undefined;
  /** Runs `checkStuckSeek` while the element is seeking; null once `onStuckSeek` was asked. */
  private stuckSeekTimer: ReturnType<typeof setTimeout> | undefined | null;
  private seekGen = 0;
  /**
   * `seekGen` of a restart still clearing the buffers and starting its pipelines; 0 = none. Until
   * it did, `sb.buffered` still shows the media it is about to remove.
   */
  private restarting = 0;
  private readonly abort = new AbortController();
  private readonly bufferAhead: number;
  private switchGen = 0;
  private slowNoticed = false;
  /** The container's index for the seek bar (`byteTimeIndex`), source times; null = none (yet). */
  private containerIndex: (() => ByteTimeIndex | null) | null = null;
  /** AVI without an index (ADR 0007 §1): the last source time a seek can reach, null = anywhere. */
  private seekLimit: (() => number | null) | null = null;
  /** Element time playback was resumed at (`startAt`), null when it started from the beginning. */
  resumedAt: number | null = null;
  /**
   * The element's own seek to the resume point once metadata is in: the pipelines already start
   * there, so it needs no restart.
   */
  private initialSeek: number | null = null;
  /** The audio encoder the browser has (Opus or AAC), for transcoding and `fillSilence`. */
  private encoder: TranscodeTarget | null = null;
  /**
   * Holds the other pipelines' media (not their init segments) until the video's first media is in
   * and the gap in front of it, if any, is being jumped (`openStartGate`). WebKit places a B-frame
   * video ~2 frames late while the audio starts at 0, and its GStreamer backend prerolls as soon as
   * media at the playhead is enqueued: a gap-jump seek during that preroll could fail the element or
   * block its main thread (CLAUDE.md "The start"). Null once open, or with one pipeline.
   */
  private startGate: { promise: Promise<void>; open: () => void } | null = null;
  /** `openStartGate` waits for `loadedmetadata` (set once it listens). */
  private gateOnMetadata = false;
  /** The start's gap jump is seeking (`START_STUCK_SEEK_MS` applies). */
  private startJump = false;

  private constructor(
    private readonly mb: Mediabunny,
    private readonly input: Input,
    private readonly video: HTMLVideoElement,
    private readonly mediaSource: MediaSource,
    private readonly objectUrl: string,
    private readonly videoTrack: InputVideoTrack,
    private readonly timeline: Timeline,
    /** Element-timeline duration (starts at 0), NaN if unknown. */
    readonly duration: number,
    audioTracks: AudioTrackInfo[],
    private readonly audioDecisions: ReadonlyMap<number, AudioDecision>,
    notices: PlaybackErrorCode[],
    private readonly opts: MsePlayerOptions,
    private readonly remote: RemoteVideo | null,
    private readonly bytes: ByteWindow,
    fileSize: number,
  ) {
    this.bufferAhead = opts.windowBytes
      ? aheadWithin(bufferAheadSeconds(), opts.windowBytes, fileSize / duration)
      : bufferAheadSeconds();
    this.audioTracks = audioTracks;
    this.notices = notices;
  }

  /**
   * Reads the file header, decides codecs, attaches a MediaSource to `video` and starts both
   * pipelines. Rejects with a `PlaybackError` when the file cannot play.
   */
  static async open(
    video: HTMLVideoElement,
    file: ByteSource,
    opts: MsePlayerOptions,
  ): Promise<MsePlayer> {
    const msc = mediaSourceClass();
    if (!msc) throw new PlaybackError('no-mse');
    const { MS, managed } = msc;
    const isTypeSupported = (mime: string) => MS.isTypeSupported(mime);

    const mb = await import('mediabunny');
    const { AVI_FORMAT_NAME, createAviFormat } = await import('./avi/demuxer');
    const { aviVideoFormatName } = await import('./avi/fourcc');
    const bytes = new ByteWindow(readSlackBytes());
    const readCache = readCacheBytes();
    const source = trackedSource(file, bytes);
    const aviFormat = createAviFormat(mb, source);
    const input = new mb.Input({
      // Our AVI demuxer (ADR 0007) on Mediabunny's internals; Mediabunny is pinned for it.
      formats: [aviFormat, ...mb.ALL_FORMATS],
      source: new mb.CustomSource({
        getSize: () => source.size,
        read: (start, end) => source.read(start, end),
        ...(readCache
          ? { maxCacheSize: readCache, prefetchProfile: 'none' }
          : { prefetchProfile: 'network' }),
      }),
    });
    try {
      let videoTrack: InputVideoTrack | null;
      try {
        videoTrack = await input.getPrimaryVideoTrack();
      } catch (err) {
        if (err instanceof mb.UnsupportedInputFormatError) {
          throw new PlaybackError('unsupported-container');
        }
        throw err;
      }
      if (!videoTrack) throw new PlaybackError('no-playable-file', 'no video track');
      const dolbyVision = await dolbyVisionOf(mb, input, videoTrack, source);
      if (dolbyVision?.kind === 'unsupported') {
        throw new PlaybackError('dolby-vision-unsupported', dolbyVision.detail);
      }
      if (dolbyVision) console.info(`Dolby Vision ${dolbyVision.detail}: plays its base layer`);
      const avi = (await input.getFormat()).name === AVI_FORMAT_NAME ? aviFormat.demuxer : null;
      let remote: RemoteVideo | null = null;
      if (
        (await videoTrack.getCodec()) === null &&
        (await input.getFormat()).name === AVI_FORMAT_NAME
      ) {
        // DivX/Xvid & co.: no browser decodes them; the relay can convert them (ADR 0007 §2).
        const fourcc = String((await videoTrack.getInternalCodecId()) ?? '');
        if (!opts.remoteVideo)
          throw new PlaybackError('video-needs-relay', aviVideoFormatName(fourcc));
        remote = await opts.remoteVideo();
      }

      const video_ = remote
        ? isTypeSupported(REMOTE_VIDEO_MIME)
          ? ({ ok: true, mime: REMOTE_VIDEO_MIME } as const)
          : ({ ok: false, code: 'unsupported-video-codec', detail: 'H.264 High' } as const)
        : decideVideo(
            await videoTrack.getCodec(),
            await videoTrack.getCodecParameterString(),
            isTypeSupported,
          );
      if (!video_.ok) throw new PlaybackError(video_.code, video_.detail);

      const canEncode = (codec: 'opus' | 'aac') =>
        mb.canEncodeAudio(codec, TRANSCODE_AUDIO).catch(() => false);
      const target = pickTranscodeTarget(
        { encodeOpus: await canEncode('opus'), encodeAac: await canEncode('aac') },
        isTypeSupported,
      );
      const audioDecisions = new Map<number, AudioDecision>();
      const initialTracks = await Promise.all(
        (await input.getAudioTracks()).map(async (t, i): Promise<AudioTrackInfo> => {
          const codec = await t.getCodec();
          const codecString = await t.getCodecParameterString();
          const language = await t.getLanguageCode();
          const name = await t.getName();
          const decision = decideAudio(
            { codec, codecString, decodable: await t.canDecode().catch(() => false) },
            isTypeSupported,
            target,
          );
          audioDecisions.set(t.id, decision);
          return {
            id: t.id,
            codec,
            codecString,
            language,
            label: name || (language !== 'und' ? language : `Track ${i + 1}`),
            channels: await t.getNumberOfChannels(),
            isDefault: (await t.getDisposition()).default,
            playback: decision.playback,
            outputCodec: decision.playback === 'unsupported' ? null : decision.outputCodec,
            reason: decision.playback === 'unsupported' ? decision.reason : undefined,
          };
        }),
      );
      // Before the MediaSource opens: a SourceBuffer can't be added once media has been appended.
      // A track whose wasm extension fails to load is marked unsupported and another one is picked.
      const picked = await pickLoadableAudioTrack(
        initialTracks,
        preferredAudioLanguage(),
        (t) => loadCodecExtensions(audioDecisions.get(t.id)!),
        opts.restoreAudio,
      );
      const audioTracks = picked.tracks;
      const audio = picked.track;
      for (const t of audioTracks) {
        if (picked.failed.includes(t.id)) {
          audioDecisions.set(t.id, { playback: 'unsupported', reason: t.reason ?? '' });
        }
      }
      const audioDecision = audio ? audioDecisions.get(audio.id) : undefined;
      const notices: PlaybackErrorCode[] = [];
      if (picked.failed.length > 0) {
        console.warn('audio converter failed to load for tracks', picked.failed);
        notices.push('audio-convert-failed');
      }
      if (!audio && audioTracks.length > 0) notices.push('no-playable-audio');
      if (avi?.indexMode === 'scan') notices.push('avi-no-index');
      if (dolbyVision?.kind === 'base-layer') notices.push('dolby-vision-base-layer');
      // The relay's conversion (DivX/Xvid → H.264) is SDR.
      const hdr = remote ? null : hdrFormatOf(await videoTrack.getColorSpace().catch(() => null));

      // The element timeline starts at 0 even when the file's first frame does not.
      const tl = timeline(await videoTrack.getFirstTimestamp());
      const duration = elementDuration(
        tl,
        (await input.getDurationFromMetadata().catch(() => null)) ??
          (await input.computeDuration()),
      );
      // Resume: both pipelines start at the keyframe before the resume point, so nothing is
      // fetched from the start of the file. The relay converts from the exact time (ffmpeg -ss).
      const resumeAt = avi?.indexMode === 'scan' ? null : (opts.startAt?.(duration) ?? null);
      let k = tl.startTime;
      if (resumeAt !== null && !remote) {
        const key = await new mb.EncodedPacketSink(videoTrack).getKeyPacket(
          toSourceTime(tl, resumeAt),
          { verifyKeyPackets: true },
        );
        k = restartPoint(tl, key?.timestamp);
      } else if (resumeAt !== null) {
        k = toSourceTime(tl, resumeAt);
      }

      const mediaSource = new MS();
      if (managed) video.disableRemotePlayback = true;
      if (opts.isStale?.()) throw new PlaybackError('playback-failed', 'superseded');
      const objectUrl = URL.createObjectURL(mediaSource);
      const opened = new Promise((resolve) =>
        mediaSource.addEventListener('sourceopen', resolve, { once: true }),
      );
      video.src = objectUrl;
      await opened;
      if (Number.isFinite(duration)) mediaSource.duration = duration;

      const player = new MsePlayer(
        mb,
        input,
        video,
        mediaSource,
        objectUrl,
        videoTrack,
        tl,
        duration,
        audioTracks,
        audioDecisions,
        notices,
        opts,
        remote,
        bytes,
        source.size,
      );
      if (avi?.indexMode === 'scan') player.seekLimit = () => avi.seekLimit();
      if (avi) player.containerIndex = () => avi.byteTimeIndex();
      else if ((await input.getFormat()) instanceof mb.MatroskaInputFormat) {
        void player.readMatroskaIndex(file);
      }
      player.hdr = hdr;
      player.encoder = target;
      if (resumeAt !== null) {
        // Before any media: the element keeps it as its start position and seeks there once the
        // init segments are in (one `seeking`, see `onSeeking`).
        player.resumedAt = resumeAt;
        player.initialSeek = resumeAt;
        video.currentTime = resumeAt;
      }
      try {
        try {
          player.addPipeline('video', videoTrack.id, video_.mime);
          if (remote) player.pipelines[0]!.remote = { abort: null, startedAt: null, cuts: 0 };
          if (audio && audioDecision && audioDecision.playback !== 'unsupported') {
            player.addPipeline('audio', audio.id, audioDecision.mime, audioDecision);
          }
        } catch (err) {
          throw new PlaybackError('unsupported-video-codec', String(err));
        }
        player.listen();
        if (player.pipelines.length > 1) player.closeStartGate();
        for (const p of player.pipelines) {
          await player.startPipeline(p, await player.startOf(p, k), p.gen);
        }
        return player;
      } catch (err) {
        player.destroy();
        throw err;
      }
    } catch (err) {
      if (!input.disposed) input.dispose();
      throw err instanceof PlaybackError ? err : new PlaybackError('playback-failed', String(err));
    }
  }

  /**
   * Bytes of the file playback needs now (ADR 0012): from `KEEP_BEHIND_S` behind the playhead to
   * the furthest read since the last seek; null = keep everything.
   */
  keepRange(): ByteRange | null {
    return this.destroyed ? null : this.bytes.keep(this.video.currentTime);
  }

  /**
   * `file` (the playing file's source) with its reads in the piece window, for readers beside the
   * pipelines: pinned while they run, and a `scan`'s reach kept until the next seek (ADR 0012).
   */
  windowed(file: ByteSource, role: Exclude<ReadRole, 'demux'>): ByteSource {
    return trackedSource(file, this.bytes, role);
  }

  /**
   * Where media times sit in the file, element times, for the seek bar's downloaded layer (ADR
   * 0012 "Seek bar"): the container's index (MKV Cues, AVI index), else what the reads learned,
   * up to the end once every pipeline appended through it.
   */
  byteTimeIndex(): ByteTimeIndex | null {
    if (this.destroyed) return null;
    const toElement = (p: ByteTimePoint) => ({
      byte: p.byte,
      time: p.time - this.timeline.startTime,
    });
    const index = this.containerIndex?.();
    if (index && index.points.length > 0) {
      return { ...index, points: index.points.map(toElement) };
    }
    const points = [...this.bytes.points()];
    const local = this.pipelines.filter((p) => !p.remote);
    if (local.length > 0 && local.every((p) => p.done) && Number.isFinite(this.duration)) {
      points.push({ byte: this.bytes.readEnd, time: this.duration });
    }
    return { points, whole: false };
  }

  /** Matroska Cues → `containerIndex`. Never fatal: without it the layer uses the reads. */
  private async readMatroskaIndex(file: ByteSource) {
    try {
      const reader = new ByteReader(this.windowed(file, 'once'));
      const header = await readMkvHeader(reader);
      if (!header || this.destroyed) return;
      const cues = await readCuePoints(reader, header);
      if (cues.length === 0 || this.destroyed) return;
      const lastCluster = Math.max(...cues.map((c) => c.cluster));
      const after = [header.cuesPosition, header.attachmentsPosition].filter(
        (p): p is number => p !== null && p > lastCluster,
      );
      const mediaEnd = Math.min(header.segmentEnd, ...after);
      const index: ByteTimeIndex = {
        points: cues.map((c) => ({ byte: c.cluster, time: c.time })),
        whole: true,
        mediaEnd,
      };
      this.containerIndex = () => index;
    } catch (err) {
      console.warn('seek bar: no Matroska index:', err);
    }
  }

  private noteProduced() {
    let furthest = -Infinity;
    for (const p of this.pipelines) if (!p.remote) furthest = Math.max(furthest, p.writtenTo);
    this.bytes.produced(furthest);
  }

  /** Source time of element time 0 (the file's first video timestamp). */
  get startTime(): number {
    return this.timeline.startTime;
  }

  get audioTrackId(): number | null {
    return this.audioPipeline?.trackId ?? null;
  }

  /** Mediabunny codec fed to the audio SourceBuffer (`aac`, `opus`, …); `null` when muted. */
  get audioCodec(): string | null {
    const d = this.audioPipeline?.decision;
    return d && d.playback !== 'unsupported' ? d.outputCodec : null;
  }

  private get audioPipeline(): Pipeline | undefined {
    return this.pipelines.find((p) => p.kind === 'audio');
  }

  /**
   * Switches the audio track, restarting only the audio pipeline at the playhead: video keeps
   * playing, and the old track stays buffered until the new one's fragments overwrite it, so
   * playback never waits on the new pipeline's warm-up (decoder/encoder start, first fragment).
   * Rejects (and goes back to the previous track) when the new one can't start.
   */
  async selectAudioTrack(id: number): Promise<void> {
    const p = this.audioPipeline;
    const decision = this.audioDecisions.get(id);
    if (!p || !decision || decision.playback === 'unsupported') {
      throw new PlaybackError('unsupported-audio-codec');
    }
    const sg = ++this.switchGen;
    if (p.trackId === id && p.conversion) return;
    await loadCodecExtensions(decision).catch((err: unknown) => {
      throw new PlaybackError('audio-convert-failed', String(err));
    });
    if (sg !== this.switchGen || this.destroyed) return;
    const prev = { trackId: p.trackId, decision: p.decision, mime: p.mime, end: p.end };
    const restart = async () => {
      const g = ++p.gen;
      const c = p.conversion;
      p.conversion = null;
      p.done = false;
      await c?.cancel().catch(() => {});
      // Keep what is buffered (only reset the parser); the new appends replace it from `t` on.
      await this.resetBuffer(p, Infinity);
      if (g !== p.gen || this.destroyed) return;
      const t = this.video.currentTime;
      const { buffered } = p.sb;
      const keptUntil = buffered.length ? buffered.end(buffered.length - 1) : -Infinity;
      const k = await this.startOf(p, toSourceTime(this.timeline, t));
      if (g !== p.gen || this.destroyed) return;
      await this.startPipeline(p, k, g, keptUntil);
    };
    Object.assign(p, { trackId: id, decision, mime: decision.mime, end: NaN });
    try {
      await restart();
    } catch (err) {
      if (sg !== this.switchGen || this.destroyed) return;
      Object.assign(p, prev);
      await restart().catch((e: unknown) => this.fail(e));
      throw err instanceof PlaybackError
        ? err
        : new PlaybackError('audio-convert-failed', String(err));
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.startGate?.open();
    clearTimeout(this.seekTimer);
    clearTimeout(this.eosTimer);
    this.disarmStuckSeek();
    clearTimeout(this.heldSeekTimer);
    this.abort.abort();
    this.releaseSeeks?.();
    for (const p of this.pipelines) void this.stopPipeline(p);
    if (!this.input.disposed) this.input.dispose();
    // Leave the element alone if a newer player already attached its own MediaSource.
    if (this.video.src === this.objectUrl) {
      this.video.removeAttribute('src');
      this.video.load();
    }
    URL.revokeObjectURL(this.objectUrl);
  }

  /** Invalidates `p`'s current run (its conversion or relay request); resolves once it is cancelled. */
  private stopPipeline(p: Pipeline): { g: number; cancel: Promise<void> | undefined } {
    const g = ++p.gen;
    const c = p.conversion;
    p.conversion = null;
    p.done = false;
    p.remote?.abort?.abort();
    if (p.remote) p.remote.abort = null;
    return { g, cancel: c?.cancel().catch(() => {}) };
  }

  private addPipeline(
    kind: Pipeline['kind'],
    trackId: number,
    mime: string,
    decision?: AudioDecision,
  ) {
    const sb = this.mediaSource.addSourceBuffer(mime);
    this.pipelines.push({
      kind,
      trackId,
      sb,
      mime,
      sbMime: mime,
      decision,
      gen: 0,
      conversion: null,
      done: false,
      end: NaN,
      writtenTo: -Infinity,
      replaceUntil: -Infinity,
      quota: newQuotaState(),
      keyframes: [],
    });
    const quota = simulatedQuotaBytes();
    if (quota > 0) {
      simulateQuota(sb, quota, () => {
        globalThis.__webtorQuotaHits = (globalThis.__webtorQuotaHits ?? 0) + 1;
      });
    }
  }

  private releaseSeeks: (() => void) | null = null;
  /** The element's own `currentTime` setter (`interceptSeeks`). */
  private seekTo: (t: number) => void = (t) => void (this.video.currentTime = t);
  /** `endOfStream()` went out and the element hasn't ended since (`holdSeek`). */
  private ending = false;
  /** A seek held until the element ends (`holdSeek`): its target, and whether to play on. */
  private heldSeek: { t: number; play: boolean } | null = null;
  private heldSeekTimer: ReturnType<typeof setTimeout> | undefined;
  /** Where the element ended, until the next seek or play (`endLost`). */
  private endedAt: number | null = null;
  /** A seek or play on an element that lost its end, sent to `onLostEnd` in a microtask. */
  private lostEndRequest: { t: number; play: boolean } | null = null;

  /**
   * Every `currentTime` write (ours, the app's, any script's) goes through `holdSeek` and
   * `reopen` before the element queues the seek: WebKit decides what to re-enqueue when it runs
   * the seek, so `seeking` is too late. An own accessor on this element over the prototype's;
   * removed on `destroy` unless a newer player replaced it.
   */
  private interceptSeeks() {
    const proto = HTMLMediaElement.prototype;
    const native = Object.getOwnPropertyDescriptor(proto, 'currentTime');
    const nativeEnded = Object.getOwnPropertyDescriptor(proto, 'ended')?.get;
    if (!native?.get || !native.set || !nativeEnded) return;
    const { get, set } = native;
    const video = this.video;
    const nativePlay = proto.play;
    this.seekTo = (t) => {
      this.endedAt = null;
      set.call(video, t);
    };
    const lost = () =>
      endLost(this.endedAt, nativeEnded.call(video) as boolean, get.call(video) as number);
    const time: PropertyDescriptor = {
      configurable: true,
      enumerable: true,
      get: () => (lost() ? this.endedAt! : (get.call(video) as number)),
      set: (t: number) => {
        if (lost()) return this.recoverLostEnd(t, false);
        if (this.holdSeek(t)) return;
        this.reopen();
        this.seekTo(t);
      },
    };
    const ended: PropertyDescriptor = {
      configurable: true,
      enumerable: true,
      get: () => lost() || (nativeEnded.call(video) as boolean),
    };
    const play = () => {
      if (lost()) {
        this.recoverLostEnd(0, true);
        return Promise.resolve();
      }
      this.endedAt = null;
      return nativePlay.call(video);
    };
    Object.defineProperty(video, 'currentTime', time);
    Object.defineProperty(video, 'ended', ended);
    Object.defineProperty(video, 'play', { configurable: true, writable: true, value: play });
    this.releaseSeeks = () => {
      const own = video as unknown as Record<string, unknown>;
      if (Object.getOwnPropertyDescriptor(video, 'currentTime')?.set !== time.set) return;
      delete own.currentTime;
      delete own.ended;
      delete own.play;
    };
  }

  /**
   * A seek to `t` (or a play, from 0) on an element that lost its end (`endLost`): it would error
   * or hang, so the owner opens the file again there (`onLostEnd`). A seek and a play in the same
   * task (`currentTime = 0; play()`) make one request; a seek to the end stays ended.
   */
  private recoverLostEnd(t: number, play: boolean) {
    if (this.destroyed || !this.opts.onLostEnd) return;
    const pending = this.lostEndRequest;
    if (pending) {
      if (!play) pending.t = t;
      pending.play ||= play;
      return;
    }
    if (!play && t >= this.endedAt! - 0.001) return;
    const request = { t, play };
    this.lostEndRequest = request;
    queueMicrotask(() => {
      this.lostEndRequest = null;
      if (this.destroyed) return;
      const at = request.t >= this.endedAt! - 0.001 && request.play ? 0 : request.t;
      this.opts.onLostEnd?.(at, request.play);
    });
  }

  /**
   * Holds a seek made after `endOfStream()` but before the element ended (at most `EOS_AHEAD_S`
   * of media while playing) until `ended`. WebKit's GStreamer backend can't seek in that window:
   * its decoder drained the EOS, so a seek errors ("No valid frames decoded before end of stream")
   * or never completes, whether or not the MediaSource is reopened first. After `ended` seeks work.
   * A paused element plays the rest to get there; a seek that was playing plays on. See CLAUDE.md.
   */
  private holdSeek(t: number): boolean {
    const v = this.video;
    if (this.destroyed || !this.ending || v.ended || this.mediaSource.readyState !== 'ended') {
      return false;
    }
    const first = this.heldSeek === null;
    this.heldSeek = { t, play: first ? !v.paused : this.heldSeek!.play };
    if (first) {
      if (v.paused) void v.play().catch(() => {});
      this.heldSeekTimer = setTimeout(() => this.releaseSeek(), HELD_SEEK_MAX_MS);
    }
    return true;
  }

  /** Runs the held seek (`holdSeek`) once the element ended, or after `HELD_SEEK_MAX_MS`. */
  private releaseSeek() {
    clearTimeout(this.heldSeekTimer);
    const held = this.heldSeek;
    this.heldSeek = null;
    if (!held || this.destroyed) return;
    const v = this.video;
    const toEnd = held.t >= v.duration - 0.001;
    // Ended there already: a seek to the end has nothing left to do.
    if (toEnd && v.ended) return;
    this.reopen();
    this.seekTo(held.t);
    if (held.play && !toEnd) void v.play().catch(() => {});
    else if (!held.play && !v.paused) v.pause();
  }

  private listen() {
    this.interceptSeeks();
    const { signal } = this.abort;
    this.video.addEventListener('seeking', () => this.onSeeking(), { signal });
    for (const ev of ['seeking', 'emptied']) {
      this.video.addEventListener(ev, () => (this.endedAt = null), { signal });
    }
    this.video.addEventListener('seeking', () => this.armStuckSeek(), { signal });
    this.video.addEventListener('seeked', () => this.disarmStuckSeek(), { signal });
    this.video.addEventListener('loadedmetadata', () => this.jumpGap(), { signal });
    this.video.addEventListener(
      'waiting',
      () => {
        this.maybeEndOfStream();
        this.jumpGap();
        this.recoverHole();
        this.checkTranscodeSpeed();
      },
      { signal },
    );
    for (const ev of ['timeupdate', 'playing', 'ratechange'])
      this.video.addEventListener(ev, () => this.armEndOfStream(), { signal });
    this.video.addEventListener(
      'ended',
      () => {
        this.endedAt = this.video.currentTime;
        this.ending = false;
        this.releaseSeek();
      },
      { signal },
    );
    for (const ev of ['pause', 'seeking', 'waiting'])
      this.video.addEventListener(ev, () => clearTimeout(this.eosTimer), { signal });
    this.video.addEventListener(
      'error',
      () => {
        const e = this.video.error;
        if (e)
          this.fail(new PlaybackError('playback-failed', e.message || `media error ${e.code}`));
      },
      { signal },
    );
  }

  private fail(err: unknown) {
    if (this.destroyed) return;
    this.opts.onError(
      err instanceof PlaybackError ? err : new PlaybackError('playback-failed', String(err)),
    );
  }

  private armStuckSeek() {
    if (this.stuckSeekTimer === null || !this.opts.onStuckSeek) return;
    clearTimeout(this.stuckSeekTimer);
    const ms = this.startJump ? START_STUCK_SEEK_MS : STUCK_SEEK_MS;
    this.stuckSeekTimer = setTimeout(() => this.checkStuckSeek(), ms);
  }

  private disarmStuckSeek() {
    this.startJump = false;
    if (this.stuckSeekTimer !== null) clearTimeout(this.stuckSeekTimer);
  }

  /**
   * Still seeking `STUCK_SEEK_MS` later: stuck if every SourceBuffer holds the target (the
   * element's own `buffered` can read empty while WebKit seeks), else the data is still on its way,
   * so look again later. A seek held for the end (`holdSeek`) waits for `ended` instead.
   */
  private checkStuckSeek() {
    const v = this.video;
    if (this.destroyed || !v.seeking) return;
    const t = v.currentTime;
    if (this.heldSeek || !this.pipelines.every((p) => isBuffered(p.sb.buffered, t))) {
      return this.armStuckSeek();
    }
    this.stuckSeekTimer = null;
    this.opts.onStuckSeek?.(t);
  }

  private closeStartGate() {
    let open = () => {};
    const promise = new Promise<void>((resolve) => (open = resolve));
    const timer = setTimeout(() => this.startGate?.open(), START_GATE_MAX_MS);
    this.startGate = {
      promise,
      open: () => {
        clearTimeout(timer);
        this.startGate = null;
        open();
      },
    };
  }

  /**
   * The video's first media is in: jump the gap in front of it, if any, while nothing else is
   * buffered, then let the other pipelines append (`startGate`). The gate opens once the element
   * started the seek (`seeking`), so the seek reaches the backend before any other media does.
   */
  private openStartGate(video: Pipeline) {
    const gate = this.startGate;
    if (!gate || this.destroyed || video.sb.buffered.length === 0) return;
    const target = gapJumpTarget(video.sb.buffered, this.video.currentTime);
    if (target === null || this.video.seeking) return gate.open();
    if (this.video.readyState < HTMLMediaElement.HAVE_METADATA) {
      // Before the metadata a write only sets the start position, and WebKit seeks there inside
      // its own load, while its backend prerolls: wait until the jump is a seek of its own.
      if (!this.gateOnMetadata) {
        this.gateOnMetadata = true;
        this.video.addEventListener('loadedmetadata', () => this.openStartGate(video), {
          once: true,
          signal: this.abort.signal,
        });
      }
      return;
    }
    this.video.addEventListener('seeking', () => gate.open(), { once: true });
    // Only the video holds the target yet: without this, `onSeeking` would restart every pipeline
    // during the very preroll the gate protects.
    this.initialSeek = target;
    this.startJump = true;
    this.video.currentTime = target;
  }

  /**
   * Moves a playhead stuck just before buffered media (see `gapJumpTarget`). Not while the start
   * gate is closed (`openStartGate` makes the first jump), nor before the metadata: WebKit's
   * `buffered` then ignores a SourceBuffer without media, and a write there is a seek inside its
   * own load, during the backend's preroll (CLAUDE.md "The start"); `loadedmetadata` calls again.
   */
  private jumpGap() {
    const v = this.video;
    if (this.destroyed || v.seeking || this.startGate) return;
    if (v.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const target = gapJumpTarget(this.video.buffered, this.video.currentTime);
    if (target !== null) this.video.currentTime = target;
  }

  /**
   * A hole at the playhead that the pipelines already went past (the UA evicted media ahead, which
   * `ManagedMediaSource` may do; see `bufferedchange`): nothing would ever fill it, so restart there.
   * Only a hole between buffered ranges counts, and once per position.
   */
  private holeRestartAt = NaN;
  private recoverHole() {
    if (this.destroyed || this.video.seeking) return;
    const t = this.video.currentTime;
    if (!this.pipelines.some((p) => hasHoleAt(p.sb.buffered, t))) return;
    if (Math.abs(t - this.holeRestartAt) < 1) return;
    this.holeRestartAt = t;
    void this.restartAt(t);
  }

  /** `relay-transcode-slow` once the element starves for video the relay is still converting. */
  private checkTranscodeSpeed() {
    const p = this.pipelines.find((x) => x.remote);
    if (!p?.remote || this.destroyed || this.slowNoticed) return;
    const slow = transcodeSlow({
      videoBuffered: p.sb.buffered,
      currentTime: this.video.currentTime,
      seeking: this.video.seeking,
      done: p.done,
      sinceStartMs: p.remote.startedAt === null ? null : performance.now() - p.remote.startedAt,
    });
    if (!slow) return;
    this.slowNoticed = true;
    this.opts.onNotice?.('relay-transcode-slow');
  }

  /**
   * Seek: nothing to do if the target is buffered everywhere (and no restart is about to clear the
   * buffers), else restart at the keyframe before it.
   */
  private onSeeking() {
    this.reopen();
    const t = this.video.currentTime;
    const initial = this.initialSeek;
    this.initialSeek = null;
    if (initial !== null && Math.abs(t - initial) < 0.01) return;
    // An AVI without an index: seeks stop at what has been scanned (this fires `seeking` again).
    const limit = this.seekLimit?.();
    if (limit != null) {
      const max = Math.max(0, limit - this.timeline.startTime);
      if (t > max + 0.05) {
        this.video.currentTime = max;
        return;
      }
    }
    // (Not with a seek limit: it would clamp the snapped seek back, and so on.)
    const snap = limit == null ? endSnap(t, this.video.duration, this.videoEnd()) : null;
    if (snap !== null) {
      // This fires `seeking` again, a moment before the end.
      this.video.currentTime = snap;
      return;
    }
    if (!this.restarting && !this.seekNeedsRestart(t)) return void this.maybeEndOfStream();
    clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(() => {
      // The appends this seek woke may have reached the end meanwhile (see `seekNeedsRestart`).
      const now = this.video.currentTime;
      if (this.restarting || !this.appendedToEnd(now)) void this.restartAt(now);
      else this.maybeEndOfStream();
    }, SEEK_DEBOUNCE_MS);
  }

  /** Where the video's last frame ends, once its pipeline appended through the end; else NaN. */
  private videoEnd(): number {
    const p = this.pipelines.find((x) => x.kind === 'video');
    const n = p?.done ? p.sb.buffered.length : 0;
    return n > 0 ? p!.sb.buffered.end(n - 1) : NaN;
  }

  /**
   * Every pipeline appended through the end and holds the media from `t` on (`bufferedToEnd`), or
   * its track ended before `t` (`trackEndedBefore`).
   */
  private appendedToEnd(t: number): boolean {
    const end = this.mediaSource.duration;
    return this.pipelines.every(
      (p) => p.done && (bufferedToEnd(p.sb.buffered, t, end) || this.trackEndedBefore(p, t)),
    );
  }

  /**
   * `p` appended through the end of its track, which ends before `t` (audio ending before the
   * video, `t` in the audio-less tail), and still holds its last media: once the MediaSource
   * ends, MSE stretches that to the end of the media and the other tracks play on.
   */
  private trackEndedBefore(p: Pipeline, t: number): boolean {
    return p.done && endedBefore(p.sb.buffered, t, p.end);
  }

  /**
   * False when every pipeline has media at `t`, or appended through the end of the file and `t` is
   * at or past its last frame (a seek to `duration`, a long forward streak): nothing is left to
   * append there, and the element ends on its own. A restart there removes and re-appends the tail
   * after the element reached the end of an `ended` MediaSource, which WebKit's GStreamer backend
   * refuses with a fatal "Failed to push buffer". Same for a track that ended before `t`
   * (`trackEndedBefore`): the stream ends (`maybeEndOfStream`) and the other tracks play on.
   */
  private seekNeedsRestart(t: number): boolean {
    const end = this.mediaSource.duration;
    return this.pipelines.some(
      (p) =>
        !isBuffered(p.sb.buffered, t) &&
        !(p.done && bufferedToEnd(p.sb.buffered, t, end)) &&
        !this.trackEndedBefore(p, t),
    );
  }

  /**
   * Source time `p` (re)starts at for a (re)start at `k`: `k`, unless `p`'s track has no packet at
   * or after it (audio ending before the video, `k` in the audio-less tail). Then a conversion
   * trimmed to `k` would output nothing the browser accepts, and an empty SourceBuffer leaves the
   * element nothing to play: `p` appends its track's last media instead (`trackStart`), then
   * silence up to the end (`fillSilence`), so the other tracks play on. Notes where the track ends
   * in `p.end`.
   */
  private async startOf(p: Pipeline, k: number): Promise<number> {
    if (p.kind !== 'audio') return k;
    try {
      const track = (await this.input.getAudioTracks()).find((x) => x.id === p.trackId);
      if (!track) return k;
      const sink = new this.mb.EncodedPacketSink(track);
      const packet = await sink.getPacket(k, { metadataOnly: true });
      const next = packet && (await sink.getNextPacket(packet, { metadataOnly: true }));
      const { start, end } = trackStart(
        k,
        packet && { timestamp: packet.timestamp, duration: packet.duration, last: !next },
        this.timeline.startTime,
      );
      if (end !== null) p.end = appendOffset(this.timeline, end);
      return start;
    } catch (err) {
      console.warn('audio packet lookup failed', err);
      return k;
    }
  }

  /** `t` is element time; the keyframe lookup and trim work in source time. */
  private async restartAt(t: number) {
    const gen = ++this.seekGen;
    this.restarting = gen;
    this.bytes.restart();
    // Stop the old pipelines first so their reads stop competing with the keyframe lookup.
    const stopped = this.pipelines.map((p) => ({ p, ...this.stopPipeline(p) }));
    try {
      // The relay's conversion starts exactly at `t` (ffmpeg input -ss), and every audio packet is a
      // key packet: no keyframe to look up.
      const key = this.remote
        ? null
        : await new this.mb.EncodedPacketSink(this.videoTrack).getKeyPacket(
            toSourceTime(this.timeline, t),
            { verifyKeyPackets: true },
          );
      if (gen !== this.seekGen || this.destroyed) return;
      const k = this.remote
        ? toSourceTime(this.timeline, t)
        : restartPoint(this.timeline, key?.timestamp);
      await Promise.all(
        stopped.map(async ({ p, g, cancel }) => {
          const start = await this.startOf(p, k);
          await cancel;
          await this.resetBuffer(p);
          if (g === p.gen && !this.destroyed) await this.startPipeline(p, start, g);
        }),
      );
    } catch (err) {
      if (gen === this.seekGen) this.fail(err);
    } finally {
      if (this.restarting === gen) this.restarting = 0;
    }
  }

  /** Drops everything buffered from element time `from` on and resets the parser. */
  private async resetBuffer(p: Pipeline, from = 0) {
    await resetFrom(
      p.sb,
      from,
      () => this.destroyed,
      () => this.mediaSource.readyState === 'open',
    );
  }

  /**
   * Starts `p` at source time `k` (a keyframe, or the first frame). `replaceUntil`: element time up
   * to which another track's media is still buffered and gets overwritten (audio switch).
   */
  private async startPipeline(p: Pipeline, k: number, gen: number, replaceUntil = -Infinity) {
    if (p.remote) return this.startRemote(p, k, gen);
    const { mb } = this;
    const offset = appendOffset(this.timeline, k);
    p.writtenTo = -Infinity;
    p.replaceUntil = replaceUntil;
    p.keyframes = p.keyframes.filter((x) => x < offset);
    const output = new mb.Output({
      format: new mb.Mp4OutputFormat({
        fastStart: 'fragmented',
        minimumFragmentDuration: 1,
        onMoof: (_data, _pos, timestamp) => {
          if (gen !== p.gen) return;
          p.writtenTo = offset + timestamp;
          this.noteProduced();
          // Every fragment starts on a keyframe (Mediabunny's fragmented MP4).
          if (p.kind === 'video') {
            p.keyframes.push(p.writtenTo);
            const t = this.video.currentTime;
            if (p.keyframes.length > 1000) p.keyframes = p.keyframes.filter((x) => x > t - 300);
          }
        },
      }),
      target: new mb.AppendOnlyStreamTarget(
        new WritableStream<Uint8Array>({ write: (data) => this.append(p, gen, data) }),
      ),
    });
    const d = p.decision;
    const transcode = d?.playback === 'transcode' ? d : null;
    const conversion = await mb.Conversion.init({
      input: this.input,
      output,
      video: (t) => (p.kind === 'video' && t.id === p.trackId ? {} : { discard: true }),
      audio: (t) => {
        if (p.kind !== 'audio' || t.id !== p.trackId) return { discard: true };
        if (!transcode) return {};
        // Resample only: the decoded layout reaches our own stereo downmix (docs/decisions/0003).
        const { numberOfChannels, sampleRate, bitrate } = TRANSCODE_AUDIO;
        return {
          codec: transcode.target.codec,
          sampleRate,
          bitrate,
          forceTranscode: true,
          process: stereoDownmixer(mb.AudioSample),
          processedNumberOfChannels: numberOfChannels,
          processedSampleRate: sampleRate,
        };
      },
      trim: { start: k },
      // Video is never transcoded (it can't be encoded in real time); copied audio must stay copied.
      copy: transcode ? false : { mode: 'forced' },
      showWarnings: false,
    });
    if (gen !== p.gen || this.destroyed) return void conversion.cancel().catch(() => {});
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks
        .filter((d) => d.reason !== 'discarded_by_user')
        .map((d) => d.reason);
      throw new PlaybackError(
        p.kind === 'video' ? 'unsupported-video-codec' : 'unsupported-audio-codec',
        reasons.join(', ') || 'conversion is not valid',
      );
    }
    p.conversion = conversion;
    // Another audio codec (e.g. AAC → Opus): the SourceBuffer must expect the new init segment.
    // Conversion output starts at 0 for trim.start = k; place it on the 0-based element timeline.
    const mime = p.sbMime !== p.mime ? p.mime : undefined;
    if (!(await startAt(p.sb, offset, () => gen !== p.gen || this.destroyed, mime))) {
      return void conversion.cancel().catch(() => {});
    }
    if (mime !== undefined) p.sbMime = mime;
    conversion.execute().then(
      () => {
        if (gen !== p.gen) return;
        const { buffered } = p.sb;
        if (Number.isNaN(p.end) && p.writtenTo > -Infinity && buffered.length > 0) {
          p.end = buffered.end(buffered.length - 1);
        }
        if (p.kind === 'audio' && p.end < this.duration - END_SLACK_S) {
          return void this.fillSilence(p, gen);
        }
        p.done = true;
        this.maybeEndOfStream();
      },
      (err) => {
        if (gen !== p.gen || this.destroyed) return;
        if (err instanceof mb.ConversionCanceledError || err instanceof StalePipeline) return;
        this.fail(err);
      },
    );
  }

  /**
   * `p`'s track ended at `p.end`, short of the end of the media (audio shorter than the video):
   * appends encoded silence from there to the end, so every SourceBuffer covers the tail. WebKit
   * (GStreamer) can't seek where one SourceBuffer has no samples, even after `endOfStream()`
   * stretched its ranges. Copied AAC-LC gets silent frames under its own config (silence.ts);
   * else the silence is encoded like the track where possible (`silencePlans`). Without an
   * encoder, or when it fails, the pipeline ends at its track's end (`trackEndedBefore`): the
   * stream ends and MSE stretches the track's last range, which Chromium plays.
   */
  private async fillSilence(p: Pipeline, gen: number) {
    const { mb } = this;
    const stale = () => gen !== p.gen || this.destroyed;
    const from = p.end;
    let output: import('mediabunny').Output | null = null;
    try {
      const track = (await this.input.getAudioTracks()).find((t) => t.id === p.trackId);
      const config = p.decision?.playback === 'copy' ? await track?.getDecoderConfig() : null;
      const desc = config?.description;
      const frame = silentAacFrame(
        desc &&
          (ArrayBuffer.isView(desc)
            ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
            : new Uint8Array(desc)),
      );
      const plan = frame ? null : await this.silencePlan(p);
      if (stale()) return;
      if (!frame && !plan) throw new Error('no encoder for it');
      if (!(await startAt(p.sb, from, stale, plan?.mime))) return;
      // A restart compares `sbMime` with `mime` and switches the SourceBuffer back.
      if (plan?.mime !== undefined) p.sbMime = plan.mime;
      p.writtenTo = -Infinity;
      output = new mb.Output({
        format: new mb.Mp4OutputFormat({
          fastStart: 'fragmented',
          minimumFragmentDuration: 1,
          onMoof: (_data, _pos, timestamp) => {
            if (gen !== p.gen) return;
            p.writtenTo = from + timestamp;
            this.noteProduced();
          },
        }),
        target: new mb.AppendOnlyStreamTarget(
          new WritableStream<Uint8Array>({ write: (data) => this.append(p, gen, data) }),
        ),
      });
      const total = this.duration - from;
      let source: import('mediabunny').AudioSource;
      if (frame && config) {
        // Copied AAC-LC: silent frames under the track's own config (silence.ts).
        const packets = new mb.EncodedAudioPacketSource('aac');
        source = packets;
        output.addAudioTrack(packets);
        await output.start();
        const step = AAC_FRAME_SAMPLES / config.sampleRate;
        for (let i = 0; i * step < total; i += 1) {
          if (stale()) return void output.cancel().catch(() => {});
          const packet = new mb.EncodedPacket(frame, 'key', i * step, step);
          await packets.add(packet, i === 0 ? { decoderConfig: config } : undefined);
        }
      } else {
        const { codec, numberOfChannels, sampleRate } = plan!;
        const samples = new mb.AudioSampleSource({ codec, bitrate: SILENCE_BITRATE });
        source = samples;
        output.addAudioTrack(samples);
        await output.start();
        const zeros = new Float32Array(sampleRate * numberOfChannels);
        for (let t = 0; t < total; t += 1) {
          if (stale()) return void output.cancel().catch(() => {});
          const frames = Math.ceil(Math.min(1, total - t) * sampleRate);
          const sample = new mb.AudioSample({
            data: zeros.subarray(0, frames * numberOfChannels),
            format: 'f32-planar',
            numberOfChannels,
            sampleRate,
            timestamp: t,
          });
          try {
            await samples.add(sample);
          } finally {
            sample.close();
          }
        }
      }
      source.close();
      await output.finalize();
      if (stale()) return;
      // The SourceBuffer now runs to the end like any other track's.
      p.end = NaN;
    } catch (err) {
      void output?.cancel().catch(() => {});
      if (stale()) return;
      console.warn('silence after the end of the audio track failed', err);
    }
    if (stale()) return;
    p.done = true;
    this.maybeEndOfStream();
  }

  /** The first of `silencePlans` the browser can encode, its encoder loaded; null if none. */
  private async silencePlan(p: Pipeline): Promise<SilencePlan | null> {
    const info = this.audioTracks.find((t) => t.id === p.trackId);
    const track = (await this.input.getAudioTracks()).find((t) => t.id === p.trackId);
    if (!info || !track || !p.decision) return null;
    const plans = silencePlans(
      p.decision,
      { ...info, sampleRate: await track.getSampleRate() },
      this.encoder,
      typeof p.sb.changeType === 'function',
    );
    for (const plan of plans) {
      const { codec, numberOfChannels, sampleRate, wasmEncoder } = plan;
      try {
        if (wasmEncoder) await loadEncoder({ codec, codecString: 'mp4a.40.2', wasmEncoder });
        const config = { numberOfChannels, sampleRate, bitrate: SILENCE_BITRATE };
        if (await this.mb.canEncodeAudio(codec, config)) return plan;
      } catch (err) {
        console.warn('audio encoder unavailable for the silence', err);
      }
    }
    return null;
  }

  /** Starts the relay's conversion at source time `k` and pumps it into `p`'s SourceBuffer. */
  private async startRemote(p: Pipeline, k: number, gen: number) {
    const remote = p.remote!;
    const offset = appendOffset(this.timeline, k);
    p.writtenTo = -Infinity;
    p.replaceUntil = -Infinity;
    const abort = new AbortController();
    remote.abort = abort;
    // The warm-up clock starts when the relay answers: before that, ffmpeg waits for the swarm.
    remote.startedAt = null;
    let body: ReadableStream<Uint8Array>;
    try {
      body = await this.remote!.open(offset, abort.signal);
    } catch (err) {
      if (gen !== p.gen || this.destroyed) return;
      throw err;
    }
    if (gen !== p.gen || this.destroyed) return void abort.abort();
    remote.startedAt = performance.now();
    // A `waiting` during the warm-up is not re-fired while the element keeps starving: look again.
    setTimeout(() => {
      if (gen === p.gen && !this.video.paused) this.checkTranscodeSpeed();
    }, REMOTE_WARMUP_MS + 100);
    // The relay's output starts at 0 for `start` = offset.
    if (!(await startAt(p.sb, offset, () => gen !== p.gen || this.destroyed))) {
      return void abort.abort();
    }
    void this.pumpRemote(p, gen, body);
  }

  /**
   * Reads the relay's stream into the SourceBuffer. `append` waits while enough is buffered ahead,
   * and not reading is the back-pressure: the relay's ffmpeg blocks on its pipe (ADR 0007 §2).
   */
  private async pumpRemote(p: Pipeline, gen: number, body: ReadableStream<Uint8Array>) {
    const remote = p.remote!;
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (gen !== p.gen || this.destroyed) return;
        if (done) break;
        remote.cuts = 0;
        await this.append(p, gen, value);
      }
    } catch (err) {
      if (gen !== p.gen || this.destroyed || err instanceof StalePipeline) return;
      if (err instanceof PlaybackError) return this.fail(err);
      // The stream broke off (the relay ended a job idle for long, e.g. a paused tab, or the network
      // dropped): go on from what is buffered.
      void this.resumeRemote(p, gen).catch((e: unknown) => this.fail(e));
      return;
    } finally {
      reader.releaseLock();
    }
    p.done = true;
    this.maybeEndOfStream();
  }

  private async resumeRemote(p: Pipeline, gen: number) {
    const remote = p.remote!;
    if (++remote.cuts > MAX_REMOTE_RESUMES) {
      throw new PlaybackError(
        'relay-transcode-failed',
        'the relay’s video stream keeps breaking off',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * remote.cuts));
    if (gen !== p.gen || this.destroyed) return;
    const { g } = this.stopPipeline(p);
    const at = remoteResumePoint(p.sb.buffered, this.video.currentTime);
    await this.resetBuffer(p, at);
    if (g !== p.gen || this.destroyed) return;
    await this.startRemote(p, toSourceTime(this.timeline, at), g);
  }

  /** Appends one chunk with back-pressure; `QuotaExceededError` waits for room (append.ts). */
  private async append(p: Pipeline, gen: number, data: Uint8Array) {
    const host: AppendHost = {
      name: p.kind,
      target: this.bufferAhead,
      currentTime: () => this.video.currentTime,
      ahead: () => this.appendedAhead(p),
      streaming: () => (this.mediaSource as { streaming?: boolean }).streaming !== false,
      playing: () => !this.video.paused,
      progress: () => this.playbackProgress(),
      now: () => performance.now(),
      check: () => {
        if (gen !== p.gen || this.destroyed) throw new StalePipeline();
      },
      safeCut: (cut) => this.safeCut(p, cut),
      staleAhead: () => {
        // Audio switch: the old track ahead of the new pipeline gets overwritten anyway.
        if (p.writtenTo >= p.replaceUntil) return null;
        const from = Math.max(this.video.currentTime, p.writtenTo) + MIN_AHEAD_S;
        if (from >= p.replaceUntil) return null;
        p.replaceUntil = from;
        return [from, Infinity];
      },
      relieve: () => this.relieve(p, () => gen !== p.gen),
    };
    if (this.startGate && p.kind !== 'video') {
      // The init segment may go in (the element needs every one for its metadata), media waits.
      // A chunk can be the init segment alone: held back, the metadata would wait for the gate.
      const init = initSegmentBytes(data);
      if (init > 0) {
        await appendChunk(p.sb, data.subarray(0, init) as Uint8Array<ArrayBuffer>, host, p.quota);
        data = data.subarray(init);
        if (data.byteLength === 0) return;
      }
      await this.startGate?.promise;
      host.check();
    }
    await appendChunk(p.sb, data as Uint8Array<ArrayBuffer>, host, p.quota);
    if (p.kind === 'video') this.openStartGate(p);
    this.jumpGap();
  }

  /** Where eviction behind `p`'s playhead may end so that it keeps the GOP being played. */
  private safeCut(p: Pipeline, cut: number): number {
    if (p.kind === 'audio') return cut;
    if (p.remote) return cut - REMOTE_KEYFRAME_INTERVAL_S;
    return lastAtOrBefore(p.keyframes, cut);
  }

  /**
   * `self` hit the quota with almost nothing ahead: the quota is shared (or the UA is low on memory),
   * so free room in the other SourceBuffers: first behind the playhead, else by cutting their media
   * ahead to half (and capping them there), so one pipeline never starves the other.
   */
  private async relieve(self: Pipeline, selfStale: () => boolean): Promise<boolean> {
    const t = this.video.currentTime;
    let freed = false;
    for (const q of this.pipelines) {
      if (q === self || this.destroyed || selfStale()) continue;
      try {
        const ev = quotaEvictionRanges(q.sb.buffered, t, (cut) => this.safeCut(q, cut));
        for (const [from, to] of ev) await whenIdle(q.sb, () => q.sb.remove(from, to));
        if (ev.length > 0) {
          freed = true;
          continue;
        }
        const ahead = aheadOf(q.sb.buffered, t);
        if (ahead < 2 * MIN_AHEAD_S) continue;
        const keep = Math.max(MIN_AHEAD_S, ahead / 2);
        q.quota.cap = Math.min(q.quota.cap, keep);
        if (await this.trimAhead(q, t + keep, selfStale)) freed = true;
      } catch (err) {
        console.warn('freeing buffer room failed', err);
      }
    }
    return freed;
  }

  /**
   * Drops `q`'s media from element time `until` on and restarts it there. False if it can't.
   *
   * The keyframe lookup is async: a seek (`restartAt`), an audio switch or any other restart may land
   * meanwhile. Those own `q` now, and stopping it here would bump `q.gen` under them (they then skip
   * it) and restart it at the stale pre-seek `until`. So bail out when `q`'s run, the seek generation
   * or the calling pipeline's run (`callerStale`) changed during the await.
   */
  private async trimAhead(
    q: Pipeline,
    until: number,
    callerStale: () => boolean,
  ): Promise<boolean> {
    const qGen = q.gen;
    const seekGen = this.seekGen;
    const stale = () =>
      this.destroyed || q.gen !== qGen || this.seekGen !== seekGen || callerStale();
    let k = toSourceTime(this.timeline, until);
    if (q.kind === 'video' && !q.remote) {
      const key = await new this.mb.EncodedPacketSink(this.videoTrack).getKeyPacket(k, {
        verifyKeyPackets: true,
      });
      k = restartPoint(this.timeline, key?.timestamp);
    } else if ((await this.startOf(q, k)) !== k) {
      // Its track ends before `until`: nothing there to trim.
      return false;
    }
    if (stale()) return false;
    // A long GOP would cut into what is playing now.
    if (appendOffset(this.timeline, k) < this.video.currentTime + 1) return false;
    const { g, cancel } = this.stopPipeline(q);
    await cancel;
    await this.resetBuffer(q, appendOffset(this.timeline, k));
    if (g !== q.gen || this.destroyed) return true;
    this.startPipeline(q, k, g).catch((err: unknown) => {
      if (g === q.gen) this.fail(err);
    });
    return true;
  }

  /**
   * Seconds of `p`'s media ahead of the playhead, for back-pressure (see `replaceUntil`). 0 once
   * another track ended before the playhead (`trackEndedBefore`): the element plays on only once the
   * MediaSource ended, so `p` must append through the end, however long the tail.
   */
  private appendedAhead(p: Pipeline): number {
    const t = this.video.currentTime;
    if (this.pipelines.some((q) => q !== p && this.trackEndedBefore(q, t))) return 0;
    return p.writtenTo < p.replaceUntil ? p.writtenTo - t : aheadOf(p.sb.buffered, t);
  }

  /**
   * Resolves when the playhead moves, a seek starts, ManagedMediaSource wants data again
   * (`startstreaming`) or evicted some (`bufferedchange`), or after a second, so back-pressure
   * loops re-check.
   */
  private playbackProgress(): Promise<void> {
    return new Promise((resolve) => {
      const targets: EventTarget[] = [
        this.video,
        this.mediaSource,
        ...this.pipelines.map((p) => p.sb),
      ];
      const events = ['timeupdate', 'seeking', 'startstreaming', 'bufferedchange'];
      const done = () => {
        clearTimeout(timer);
        for (const x of targets) for (const e of events) x.removeEventListener(e, done);
        resolve();
      };
      const timer = setTimeout(done, 1000);
      for (const x of targets) for (const e of events) x.addEventListener(e, done);
    });
  }

  /** What the stats panel shows about buffering (docs/decisions/0003 "Back-pressure and quota"). */
  bufferInfo(): BufferInfo {
    const t = this.video.currentTime;
    let ahead = Infinity;
    let cap = Infinity;
    let quotaHits = 0;
    for (const p of this.pipelines) {
      ahead = Math.min(ahead, aheadOf(p.sb.buffered, t));
      cap = Math.min(cap, p.quota.cap);
      quotaHits += p.quota.hits;
    }
    return {
      ahead: Number.isFinite(ahead) ? ahead : 0,
      target: Math.min(this.bufferAhead, cap),
      quotaHits,
    };
  }

  /**
   * Ends the MediaSource once every pipeline appended through the end and the playhead reached the
   * end of the buffered media (within `lead`): a stall there (`waiting`) or a seek there. While
   * playing, `armEndOfStream` ends it a moment before instead. Not as soon as the appends are done:
   * WebKit's GStreamer backend then drains the EOS through its decoder before the end, and any seek
   * made after that fails ("No valid frames decoded before end of stream") or freezes. See CLAUDE.md.
   */
  private maybeEndOfStream(lead?: number) {
    if (!this.canEndStream()) return;
    const ranges = this.pipelines.map((p) => p.sb.buffered);
    if (!atBufferedEnd(ranges, this.video.currentTime, lead)) return;
    this.endStream();
  }

  private endStream() {
    this.mediaSource.endOfStream();
    this.ending = true;
  }

  /**
   * Reopens an ended MediaSource (a `remove()` of nothing past its end does that): a seek after
   * `endOfStream()` then plays on like one before it, and the stream ends again at the end.
   */
  private reopen() {
    if (this.destroyed || this.mediaSource.readyState !== 'ended') return;
    const sb = this.pipelines[0]?.sb;
    if (!sb || sb.updating) return;
    try {
      sb.remove(this.mediaSource.duration, Infinity);
    } catch (err) {
      console.warn('reopen failed', err);
      return;
    }
    this.ending = false;
    sb.addEventListener(
      'updateend',
      () => {
        this.maybeEndOfStream();
        this.armEndOfStream();
      },
      { once: true },
    );
  }

  private canEndStream(): boolean {
    return (
      !this.destroyed &&
      this.pipelines.every((p) => p.done && !p.sb.updating) &&
      this.mediaSource.readyState === 'open'
    );
  }

  /**
   * While playing into the end of the buffered media with every append done: `endOfStream()`
   * `EOS_AHEAD_S` before it (`endOfStreamIn`), on a timer re-checked when it fires, so the element
   * plays into an ended MediaSource rather than stalling at the end first (see `EOS_AHEAD_S`).
   * Called on `timeupdate`, `playing` and `ratechange`; a pause, a seek or a stall cancels it.
   */
  private armEndOfStream() {
    clearTimeout(this.eosTimer);
    if (!this.canEndStream() || this.video.paused || this.video.seeking) return;
    const v = this.video;
    const ranges = this.pipelines.map((p) => p.sb.buffered);
    const wait = endOfStreamIn(ranges, v.currentTime, v.playbackRate);
    if (wait === null) return;
    if (wait === 0) return void this.endStream();
    this.eosTimer = setTimeout(() => this.armEndOfStream(), wait * 1000);
  }
}

export interface BufferInfo {
  /** Seconds buffered ahead of the playhead in every SourceBuffer. */
  ahead: number;
  /** Ahead target (s): `BUFFER_AHEAD_S`, lowered by quota hits (`QuotaState.cap`). */
  target: number;
  /** `QuotaExceededError`s so far, all SourceBuffers. */
  quotaHits: number;
}

/** `t` is unbuffered but there is media both before and after it (well past a small gap). */
function hasHoleAt(ranges: Ranges, t: number): boolean {
  if (isBuffered(ranges, t)) return false;
  let before = false;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= t) before = true;
    else if (before && gapJumpTarget(ranges, t) === null) return true;
  }
  return false;
}
