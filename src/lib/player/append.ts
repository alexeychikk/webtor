/**
 * Appending to a SourceBuffer with back-pressure (docs/decisions/0003 "Back-pressure and quota").
 * DOM-free: `MsePlayer` supplies the playhead and the waits through `AppendHost`, the tests a fake
 * SourceBuffer (append.test.ts).
 *
 * `QuotaExceededError` is back-pressure, never a failure: Safari/iPadOS (`ManagedMediaSource`) give a
 * SourceBuffer far fewer bytes than the time target needs with a high-bitrate file. On a quota hit
 * the pipeline drops what it can (behind the playhead, stale media ahead of it), lowers its ahead
 * target to what fitted, and waits for playback to free room.
 *
 * WebKit refuses an append whenever buffered + the append's bytes reach its limit, and until a
 * SourceBuffer has parsed an init segment that limit is the audio share (5 %, ~5.5 MB on iOS).
 * Mediabunny writes the moov together with the first whole fragment (a GOP), so `appendChunk`
 * appends the init segment on its own and the rest in pieces of at most `QuotaState.chunk` bytes.
 * The piece size halves while the buffer is starved. It fails only after `STARVED_TIMEOUT_MS` in
 * which not even the smallest piece fitted, nothing could be freed and the playhead could not move,
 * and the message carries the numbers to report.
 */
import {
  aheadOf,
  evictionRange,
  QUOTA_KEEP_BEHIND_S,
  quotaEvictionRanges,
  totalBuffered,
  type Ranges,
} from './buffer';
import { PlaybackError } from './errors';

/** Below this many seconds ahead a pipeline always appends (MMS `endstreaming` or a learned cap). */
export const MIN_AHEAD_S = 3;
/** A quota hit at `a` s ahead caps the pipeline's ahead target at `a * QUOTA_CAP_FACTOR`. */
export const QUOTA_CAP_FACTOR = 0.8;
/** Largest single `appendBuffer` (bytes). Well under any browser's limit, also WebKit's pre-init 5 %. */
export const MAX_APPEND_BYTES = 1 << 20;
/** The piece size never halves below this. */
export const MIN_APPEND_BYTES = 16 << 10;
/** Quota hits in a row with nothing near the playhead and nothing to free, at least, before failing… */
export const MAX_STARVED_HITS = 5;
/** …spread over at least this long (Safari may free memory late; the UA may evict meanwhile). */
export const STARVED_TIMEOUT_MS = 20_000;
/** Under 0.5 s ahead the playhead can't move on this buffer: waiting won't free room in it. */
const STARVED_AHEAD_S = 0.5;

/** The part of `SourceBuffer` used here. */
export interface AppendBuffer {
  readonly buffered: Ranges;
  readonly updating: boolean;
  appendBuffer(data: Uint8Array<ArrayBuffer>): void;
  remove(start: number, end: number): void;
  addEventListener(type: 'updateend' | 'error', listener: () => void, o?: { once?: boolean }): void;
  removeEventListener(type: 'updateend' | 'error', listener: () => void): void;
}

/** What a pipeline learned about its quota. */
export interface QuotaState {
  /** Ahead target (s) learned from `QuotaExceededError`; Infinity until the first one. */
  cap: number;
  /** Quota hits so far (stats panel, `data-quota-hits`). */
  hits: number;
  /** Largest piece appended at once (bytes): halves while starved, doubles back once it isn't. */
  chunk: number;
}

export function newQuotaState(): QuotaState {
  return { cap: Infinity, hits: 0, chunk: MAX_APPEND_BYTES };
}

/** The pipeline side of `appendChunk`. */
export interface AppendHost {
  /** `video` or `audio`, for the failure message. */
  readonly name: string;
  /** Configured ahead target (s), `BUFFER_AHEAD_S` or the e2e knob. */
  readonly target: number;
  currentTime(): number;
  /** Seconds of this pipeline's media ahead of the playhead (see `MsePlayer.appendedAhead`). */
  ahead(): number;
  /** False while a `ManagedMediaSource` asks to stop fetching (`endstreaming`). */
  streaming(): boolean;
  /** True while the element is meant to play (`!video.paused`, also while it waits for data). */
  playing(): boolean;
  /** Resolves when the playhead moves, a seek starts, streaming restarts, or after about 1 s. */
  progress(): Promise<void>;
  /** Milliseconds, monotonic (`performance.now()`). */
  now(): number;
  /** Throws once this run is superseded (seek, restart, destroy). */
  check(): void;
  /**
   * Range under quota where `quotaEvictionRanges` may cut: the last random-access point at or before
   * `cut` (video), or `cut` itself (audio, where every frame is one).
   */
  safeCut(cut: number): number;
  /** Own buffered media the current run overwrites anyway (old audio track ahead), or null. */
  staleAhead(): [number, number] | null;
  /** Shared quota: frees room in the other SourceBuffers; true if it freed anything. */
  relieve(): Promise<boolean>;
}

export function isQuotaExceeded(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'QuotaExceededError'
  );
}

/** Resolves once the SourceBuffer is idle; rejects if the pending operation failed. */
export function settled(sb: AppendBuffer): Promise<void> {
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

/**
 * Waits until `sb` is idle and calls `op` in the same task, so no other pipeline's append slips in
 * between (an `updateend` wakes every waiter).
 */
export async function whenIdle(sb: AppendBuffer, op: () => void): Promise<void> {
  while (sb.updating) await settled(sb);
  op();
  await settled(sb);
}

/** The rest of `SourceBuffer` a (re)start uses. MSE refuses all three while it is `updating`. */
export interface RestartBuffer extends AppendBuffer {
  timestampOffset: number;
  changeType(type: string): void;
  abort(): void;
}

/**
 * Drops what `sb` holds from `from` on, then resets its parser (`abort`, only when `open()`: the
 * MediaSource is `open`). Another pipeline's `relieve()` may start a `remove()` on `sb` at any await,
 * and `remove`/`abort` throw InvalidStateError while it runs: each call waits for idle in its task.
 */
export async function resetFrom(
  sb: RestartBuffer,
  from: number,
  stale: () => boolean,
  open: () => boolean,
): Promise<void> {
  await whenIdle(sb, () => {
    if (stale()) return;
    // remove() also re-opens an `ended` MediaSource, after which abort() is allowed.
    const { buffered } = sb;
    if (buffered.length > 0 && buffered.end(buffered.length - 1) > from) sb.remove(from, Infinity);
  });
  await whenIdle(sb, () => {
    if (!stale() && open()) sb.abort();
  });
}

/**
 * Points `sb` at a new run: `changeType(mime)` when `mime` is given, then `timestampOffset`. Both
 * throw InvalidStateError while `sb` is updating, which another pipeline's `relieve()` (a `remove()`)
 * can make it at any await of the restart. So they wait for idle and run in that same task.
 * Returns false, writing nothing, when `stale()` by then.
 */
export async function startAt(
  sb: RestartBuffer,
  offset: number,
  stale: () => boolean,
  mime?: string,
): Promise<boolean> {
  let ok = false;
  await whenIdle(sb, () => {
    if (stale()) return;
    if (mime !== undefined) sb.changeType(mime);
    sb.timestampOffset = offset;
    ok = true;
  });
  return ok;
}

/** True when the pipeline may append now (back-pressure, quota cap, MMS streaming). */
export function mayAppend(ahead: number, target: number, cap: number, streaming: boolean): boolean {
  if (ahead < Math.min(MIN_AHEAD_S, target)) return true;
  return streaming && ahead <= Math.min(target, cap);
}

/**
 * Byte length of the init segment (`ftyp`/`moov` boxes) at the start of `data` when media follows
 * it in the same chunk, else 0. Mediabunny's first write after a (re)start is moov + a whole
 * fragment, and the relay's first network chunk is ftyp + moov + whatever arrived with it.
 */
export function initSegmentLength(data: Uint8Array): number {
  const n = initSegmentBytes(data);
  return n < data.byteLength ? n : 0;
}

/**
 * Byte length of the whole `ftyp`/`moov` boxes at the start of `data`: all of it for a chunk that
 * is only an init segment, 0 for one that starts with media.
 */
export function initSegmentBytes(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;
  while (pos + 8 <= data.byteLength) {
    const size = view.getUint32(pos);
    const type = String.fromCharCode(
      data[pos + 4]!,
      data[pos + 5]!,
      data[pos + 6]!,
      data[pos + 7]!,
    );
    if ((type !== 'ftyp' && type !== 'moov') || size < 8 || pos + size > data.byteLength) break;
    pos += size;
  }
  return pos;
}

/**
 * Appends `data`, waiting while enough is buffered ahead and evicting what is far behind. The init
 * segment goes first on its own, the rest in pieces of at most `q.chunk` bytes (see the module
 * comment). A `QuotaExceededError` makes it wait for playback, never fail, unless the buffer is
 * starved and nothing can be freed for `STARVED_TIMEOUT_MS`.
 */
export async function appendChunk(
  sb: AppendBuffer,
  data: Uint8Array<ArrayBuffer>,
  host: AppendHost,
  q: QuotaState,
): Promise<void> {
  host.check();
  while (!mayAppend(host.ahead(), host.target, q.cap, host.streaming())) {
    await host.progress();
    host.check();
  }
  const init = initSegmentLength(data);
  let pos = 0;
  while (pos < data.byteLength) {
    const isInit = pos === 0 && init > 0;
    const size = isInit ? init : Math.min(q.chunk, data.byteLength - pos);
    if (await appendPiece(sb, data.subarray(pos, pos + size), host, q, !isInit)) pos += size;
  }
}

/**
 * Appends one piece, retrying on quota hits. False when the piece size was halved instead: the
 * caller splits again. An unsplittable piece (the init segment, which goes in whole) is never
 * halved: returning false would only bring the same piece back at once, a microtask loop. It waits
 * for room like a piece at the smallest size, and fails the same way.
 */
async function appendPiece(
  sb: AppendBuffer,
  piece: Uint8Array<ArrayBuffer>,
  host: AppendHost,
  q: QuotaState,
  splittable: boolean,
): Promise<boolean> {
  let starvedHits = 0;
  let starvedSince = 0;
  let starvedAt = NaN;
  let starvedKeep = QUOTA_KEEP_BEHIND_S;
  for (let attempt = 0; ; attempt++) {
    while (sb.updating) await settled(sb);
    host.check();
    const t = host.currentTime();
    // Once the quota was hit, room ahead matters more than the usual 30 s kept behind. Once
    // starved (the quota is smaller than about two fragments), everything up to the playhead goes,
    // with the sliver ahead of it: the GOP being played stays otherwise, and so does the deadlock.
    const evict =
      attempt === 0 && q.hits === 0
        ? [evictionRange(sb.buffered, t)].filter((r) => r !== null)
        : quotaEvictionRanges(
            sb.buffered,
            t,
            (cut) => host.safeCut(cut),
            starvedHits > 0 ? starvedKeep : QUOTA_KEEP_BEHIND_S,
          );
    for (const [from, to] of evict) {
      await whenIdle(sb, () => sb.remove(from, to));
      host.check();
    }
    try {
      await whenIdle(sb, () => sb.appendBuffer(piece));
      if (q.chunk < MAX_APPEND_BYTES && aheadOf(sb.buffered, host.currentTime()) >= MIN_AHEAD_S) {
        q.chunk = Math.min(MAX_APPEND_BYTES, q.chunk * 2);
      }
      return true;
    } catch (err) {
      if (!isQuotaExceeded(err)) throw err;
    }
    q.hits++;
    host.check();
    const now = host.currentTime();
    const ahead = aheadOf(sb.buffered, now);
    // Stay below what fitted from now on, so the next chunks wait in `appendChunk` instead.
    q.cap = Math.min(q.cap, Math.max(MIN_AHEAD_S, ahead * QUOTA_CAP_FACTOR));
    // The first retry evicts tightly (behind the playhead, stale ranges ahead).
    if (attempt === 0) continue;
    const stale = host.staleAhead();
    if (stale) {
      await whenIdle(sb, () => sb.remove(stale[0], stale[1]));
      continue;
    }
    if (ahead < MIN_AHEAD_S && (await host.relieve())) continue;
    // Little ahead and nothing to free: a smaller piece may still fit in what is left.
    if (ahead < MIN_AHEAD_S && splittable && piece.byteLength > MIN_APPEND_BYTES) {
      q.chunk = Math.max(MIN_APPEND_BYTES, Math.floor(piece.byteLength / 2));
      return false;
    }
    // Starved: the playhead can't move on this buffer, at its end or (playing, decoders hold a few
    // frames back) close to it, and it hasn't moved since the first such hit.
    const starved = ahead < STARVED_AHEAD_S || (ahead < MIN_AHEAD_S && host.playing());
    if (starved && (starvedHits === 0 || Math.abs(now - starvedAt) < 0.1)) {
      if (starvedHits++ === 0) {
        starvedSince = host.now();
        starvedAt = now;
      }
      starvedKeep = ahead < STARVED_AHEAD_S ? -STARVED_AHEAD_S : 0;
      if (starvedHits >= MAX_STARVED_HITS && host.now() - starvedSince >= STARVED_TIMEOUT_MS) {
        throw new PlaybackError(
          'playback-failed',
          `the browser’s media buffer is too small to hold this video (${host.name}: ` +
            `${piece.byteLength} B append refused, buffered ${formatRanges(sb.buffered)} at ` +
            `${now.toFixed(1)} s, ${q.hits} quota hits)`,
        );
      }
    } else {
      starvedHits = 0;
    }
    await host.progress();
  }
}

/** `0.0–4.2, 30.0–40.0 s` (failure messages). */
export function formatRanges(ranges: Ranges): string {
  if (ranges.length === 0) return 'nothing';
  const parts: string[] = [];
  for (let i = 0; i < ranges.length; i++) {
    parts.push(`${ranges.start(i).toFixed(1)}–${ranges.end(i).toFixed(1)}`);
  }
  return `${parts.join(', ')} s`;
}

/** True if `data` starts with complete top-level boxes and one of them is `type`. */
export function hasTopLevelBox(data: Uint8Array, type: string): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let pos = 0; pos + 8 <= data.byteLength;) {
    const size = view.getUint32(pos);
    if (String.fromCharCode(...data.subarray(pos + 4, pos + 8)) === type) return true;
    if (size < 8) return false;
    pos += size;
  }
  return false;
}

/** WebKit's budget for a SourceBuffer without an init segment yet: the audio share of the limit. */
export const PRE_INIT_QUOTA_SHARE = 0.05;

/**
 * e2e test hook (`localStorage['webtor:sb-quota-bytes']`): makes `sb.appendBuffer` throw
 * `QuotaExceededError` like WebKit when the bytes it holds plus the append's would pass `quota`,
 * or `quota * PRE_INIT_QUOTA_SHARE` before an init segment (`moov`) went in. Bytes held are
 * estimated as buffered seconds × the average bytes per appended second.
 */
export function simulateQuota(sb: AppendBuffer, quota: number, onHit: () => void): void {
  const append = sb.appendBuffer.bind(sb);
  let bytes = 0;
  let seconds = 0;
  let initialized = false;
  sb.appendBuffer = (data) => {
    const before = totalBuffered(sb.buffered);
    const held = seconds > 0 ? before * (bytes / seconds) : 0;
    const limit = initialized ? quota : quota * PRE_INIT_QUOTA_SHARE;
    if (held + data.byteLength > limit) {
      onHit();
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    append(data);
    sb.addEventListener(
      'updateend',
      () => {
        if (!initialized && hasTopLevelBox(data, 'moov')) initialized = true;
        bytes += data.byteLength;
        seconds += Math.max(0, totalBuffered(sb.buffered) - before);
      },
      { once: true },
    );
  };
}
