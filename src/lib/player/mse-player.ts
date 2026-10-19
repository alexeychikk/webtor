/**
 * MSE glue (docs/decisions/0003): one Mediabunny `Input` over the torrent file, one `Conversion` per
 * SourceBuffer (video copy; audio copy or transcode) remuxing to fragmented MP4. Decisions live in
 * pure modules (`codecs.ts`, `buffer.ts`); this file only wires them to the DOM.
 */
import type { Conversion, Input, InputVideoTrack } from 'mediabunny';
import { BUFFER_AHEAD_S, bufferedAhead, evictionRange, gapJumpTarget, isBuffered } from './buffer';
import { preferredAudioLanguage } from './audio-preference';
import { loadCodecExtensions } from './codec-extensions';
import {
  decideAudio,
  decideVideo,
  pickLoadableAudioTrack,
  pickTranscodeTarget,
  TRANSCODE_AUDIO,
  type AudioDecision,
} from './codecs';
import { PlaybackError, type PlaybackErrorCode } from './errors';
import {
  MAX_REMOTE_RESUMES,
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

/** e2e uses a few seconds so the 12 s fixture exercises back-pressure and seek restarts. */
function bufferAheadSeconds(): number {
  try {
    return Number(localStorage.getItem('webtor:buffer-ahead-s')) || BUFFER_AHEAD_S;
  } catch {
    return BUFFER_AHEAD_S;
  }
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
}

export class MsePlayer {
  readonly audioTracks: readonly AudioTrackInfo[];
  /** Non-fatal conditions to show next to the player, e.g. `no-playable-audio`. */
  readonly notices: readonly PlaybackErrorCode[];
  private readonly pipelines: Pipeline[] = [];
  private destroyed = false;
  private seekTimer: ReturnType<typeof setTimeout> | undefined;
  private seekGen = 0;
  private readonly abort = new AbortController();
  private readonly bufferAhead = bufferAheadSeconds();
  private switchGen = 0;
  private slowNoticed = false;
  /** AVI without an index (ADR 0007 §1): the last source time a seek can reach, null = anywhere. */
  private seekLimit: (() => number | null) | null = null;

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
  ) {
    this.audioTracks = audioTracks;
    this.notices = notices;
  }

  /**
   * Reads the file header, decides codecs, attaches a MediaSource to `video` and starts both
   * pipelines. Rejects with a `PlaybackError` when the file cannot play.
   */
  static async open(
    video: HTMLVideoElement,
    source: ByteSource,
    opts: MsePlayerOptions,
  ): Promise<MsePlayer> {
    const msc = mediaSourceClass();
    if (!msc) throw new PlaybackError('no-mse');
    const { MS, managed } = msc;
    const isTypeSupported = (mime: string) => MS.isTypeSupported(mime);

    const mb = await import('mediabunny');
    const { AVI_FORMAT_NAME, createAviFormat } = await import('./avi/demuxer');
    const { aviVideoFormatName } = await import('./avi/fourcc');
    const aviFormat = createAviFormat(mb, source);
    const input = new mb.Input({
      // Our AVI demuxer (ADR 0007) on Mediabunny's internals; Mediabunny is pinned for it.
      formats: [aviFormat, ...mb.ALL_FORMATS],
      source: new mb.CustomSource({
        getSize: () => source.size,
        read: (start, end) => source.read(start, end),
        prefetchProfile: 'network',
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
      const picked = await pickLoadableAudioTrack(initialTracks, preferredAudioLanguage(), (t) =>
        loadCodecExtensions(audioDecisions.get(t.id)!),
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

      // The element timeline starts at 0 even when the file's first frame does not.
      const tl = timeline(await videoTrack.getFirstTimestamp());
      const duration = elementDuration(
        tl,
        (await input.getDurationFromMetadata().catch(() => null)) ??
          (await input.computeDuration()),
      );

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
      );
      if (avi?.indexMode === 'scan') player.seekLimit = () => avi.seekLimit();
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
        for (const p of player.pipelines) await player.startPipeline(p, tl.startTime, p.gen);
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
    const prev = { trackId: p.trackId, decision: p.decision, mime: p.mime };
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
      await this.startPipeline(p, toSourceTime(this.timeline, t), g, keptUntil);
    };
    Object.assign(p, { trackId: id, decision, mime: decision.mime });
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
    clearTimeout(this.seekTimer);
    this.abort.abort();
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
      writtenTo: -Infinity,
      replaceUntil: -Infinity,
    });
  }

  private listen() {
    const { signal } = this.abort;
    this.video.addEventListener('seeking', () => this.onSeeking(), { signal });
    this.video.addEventListener(
      'waiting',
      () => {
        this.jumpGap();
        this.checkTranscodeSpeed();
      },
      { signal },
    );
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

  /** Moves a playhead stuck just before buffered media (see `gapJumpTarget`). */
  private jumpGap() {
    if (this.destroyed || this.video.seeking) return;
    const target = gapJumpTarget(this.video.buffered, this.video.currentTime);
    if (target !== null) this.video.currentTime = target;
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

  /** Seek: nothing to do if the target is buffered everywhere, else restart at the keyframe before it. */
  private onSeeking() {
    const t = this.video.currentTime;
    // An AVI without an index: seeks stop at what has been scanned (this fires `seeking` again).
    const limit = this.seekLimit?.();
    if (limit != null) {
      const max = Math.max(0, limit - this.timeline.startTime);
      if (t > max + 0.05) {
        this.video.currentTime = max;
        return;
      }
    }
    if (this.pipelines.every((p) => isBuffered(p.sb.buffered, t))) return;
    clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(
      () => void this.restartAt(this.video.currentTime),
      SEEK_DEBOUNCE_MS,
    );
  }

  /** `t` is element time; the keyframe lookup and trim work in source time. */
  private async restartAt(t: number) {
    const gen = ++this.seekGen;
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
          await cancel;
          await this.resetBuffer(p);
          if (g === p.gen && !this.destroyed) await this.startPipeline(p, k, g);
        }),
      );
    } catch (err) {
      if (gen === this.seekGen) this.fail(err);
    }
  }

  /** Drops everything buffered from element time `from` on and resets the parser. */
  private async resetBuffer(p: Pipeline, from = 0) {
    await settled(p.sb);
    if (this.destroyed) return;
    // remove() also re-opens an `ended` MediaSource, after which abort() is allowed.
    const { buffered } = p.sb;
    if (buffered.length > 0 && buffered.end(buffered.length - 1) > from) {
      p.sb.remove(from, Infinity);
      await settled(p.sb);
    }
    if (this.mediaSource.readyState === 'open') p.sb.abort();
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
    const output = new mb.Output({
      format: new mb.Mp4OutputFormat({
        fastStart: 'fragmented',
        minimumFragmentDuration: 1,
        onMoof: (_data, _pos, timestamp) => {
          if (gen === p.gen) p.writtenTo = offset + timestamp;
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
        return transcode
          ? { codec: transcode.target.codec, ...TRANSCODE_AUDIO, forceTranscode: true }
          : {};
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
    if (p.sbMime !== p.mime) {
      await settled(p.sb);
      if (gen !== p.gen || this.destroyed) return void conversion.cancel().catch(() => {});
      // Another audio codec (e.g. AAC → Opus): the SourceBuffer must expect the new init segment.
      p.sb.changeType(p.mime);
      p.sbMime = p.mime;
    }
    // Conversion output starts at 0 for trim.start = k; place it on the 0-based element timeline.
    p.sb.timestampOffset = offset;
    conversion.execute().then(
      () => {
        if (gen !== p.gen) return;
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
    await settled(p.sb);
    if (gen !== p.gen || this.destroyed) return void abort.abort();
    // The relay's output starts at 0 for `start` = offset.
    p.sb.timestampOffset = offset;
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

  /** Appends one chunk, waiting while enough is buffered ahead and evicting what is far behind. */
  private async append(p: Pipeline, gen: number, data: Uint8Array) {
    const stale = () => gen !== p.gen || this.destroyed;
    if (stale()) throw new StalePipeline();
    while (this.appendedAhead(p) > this.bufferAhead) {
      await this.playbackProgress();
      if (stale()) throw new StalePipeline();
    }
    for (let attempt = 0; ; attempt++) {
      await settled(p.sb);
      if (stale()) throw new StalePipeline();
      const evict = evictionRange(p.sb.buffered, this.video.currentTime, attempt ? 5 : undefined);
      if (evict) {
        p.sb.remove(evict[0], evict[1]);
        await settled(p.sb);
        if (stale()) throw new StalePipeline();
      }
      try {
        p.sb.appendBuffer(data as Uint8Array<ArrayBuffer>);
        await settled(p.sb);
        this.jumpGap();
        return;
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'QuotaExceededError') || attempt > 5) {
          throw err;
        }
        // Buffer full: let playback move on, then evict more aggressively and retry.
        await this.playbackProgress();
      }
    }
  }

  /** Seconds of `p`'s media ahead of the playhead, for back-pressure (see `replaceUntil`). */
  private appendedAhead(p: Pipeline): number {
    const t = this.video.currentTime;
    return p.writtenTo < p.replaceUntil ? p.writtenTo - t : bufferedAhead(p.sb.buffered, t);
  }

  /** Resolves when the playhead moves (or after a second), so back-pressure loops re-check. */
  private playbackProgress(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.video.removeEventListener('timeupdate', done);
        this.video.removeEventListener('seeking', done);
        resolve();
      };
      const timer = setTimeout(done, 1000);
      this.video.addEventListener('timeupdate', done);
      this.video.addEventListener('seeking', done);
    });
  }

  private maybeEndOfStream() {
    if (this.destroyed || !this.pipelines.every((p) => p.done)) return;
    if (this.mediaSource.readyState !== 'open') return;
    if (this.pipelines.some((p) => p.sb.updating)) return;
    this.mediaSource.endOfStream();
  }
}

/** Resolves once the SourceBuffer is idle; rejects if the pending operation failed. */
function settled(sb: SourceBuffer): Promise<void> {
  if (!sb.updating) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onEnd = () => {
      sb.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      sb.removeEventListener('updateend', onEnd);
      reject(new PlaybackError('playback-failed', 'the browser rejected the media data'));
    };
    sb.addEventListener('updateend', onEnd, { once: true });
    sb.addEventListener('error', onError, { once: true });
  });
}
