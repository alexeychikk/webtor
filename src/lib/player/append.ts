/**
 * Appending to a SourceBuffer with back-pressure (docs/decisions/0003 "Back-pressure and quota").
 * DOM-free: `MsePlayer` supplies the playhead and the waits through `AppendHost`, the tests a fake
 * SourceBuffer (append.test.ts).
 *
 * `QuotaExceededError` is back-pressure, never a failure: Safari/iPadOS (`ManagedMediaSource`) give a
 * SourceBuffer far fewer bytes than the time target needs with a high-bitrate file. On a quota hit
 * the pipeline drops what it can behind the playhead, lowers its ahead target to what fitted, and
 * waits for playback to free room. Only a buffer that holds nothing at the playhead and can free
 * nothing anywhere fails (the browser can't hold even one fragment).
 */
import { bufferedAhead, evictionRange, quotaEvictionRange, type Ranges } from './buffer';
import { PlaybackError } from './errors';

/** Below this many seconds ahead a pipeline always appends (MMS `endstreaming` or a learned cap). */
export const MIN_AHEAD_S = 3;
/** A quota hit at `a` s ahead caps the pipeline's ahead target at `a * QUOTA_CAP_FACTOR`. */
export const QUOTA_CAP_FACTOR = 0.8;
/** Quota hits in a row with nothing at the playhead and nothing to free before giving up. */
export const MAX_STARVED_HITS = 5;
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
  /** Quota hits so far (the e2e reads the total, see `quotaHits`). */
  hits: number;
}

export function newQuotaState(): QuotaState {
  return { cap: Infinity, hits: 0 };
}

/** The pipeline side of `appendChunk`. */
export interface AppendHost {
  /** Configured ahead target (s), `BUFFER_AHEAD_S` or the e2e knob. */
  readonly target: number;
  currentTime(): number;
  /** Seconds of this pipeline's media ahead of the playhead (see `MsePlayer.appendedAhead`). */
  ahead(): number;
  /** False while a `ManagedMediaSource` asks to stop fetching (`endstreaming`). */
  streaming(): boolean;
  /** Resolves when the playhead moves, a seek starts, streaming restarts, or after about 1 s. */
  progress(): Promise<void>;
  /** Throws once this run is superseded (seek, restart, destroy). */
  check(): void;
  /**
   * Range under quota where `quotaEvictionRange` may cut: the last random-access point at or before
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

/** True when the pipeline may append now (back-pressure, quota cap, MMS streaming). */
export function mayAppend(ahead: number, target: number, cap: number, streaming: boolean): boolean {
  if (ahead < Math.min(MIN_AHEAD_S, target)) return true;
  return streaming && ahead <= Math.min(target, cap);
}

/**
 * Appends `data`, waiting while enough is buffered ahead and evicting what is far behind. A
 * `QuotaExceededError` makes it wait for playback (see the module comment), never fail, unless the
 * buffer is starved and nothing anywhere can be freed `MAX_STARVED_HITS` times in a row.
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
  let starved = 0;
  for (let attempt = 0; ; attempt++) {
    while (sb.updating) await settled(sb);
    host.check();
    const t = host.currentTime();
    // Once the quota was hit, room ahead matters more than the usual 30 s kept behind.
    const evict =
      attempt === 0 && q.hits === 0
        ? evictionRange(sb.buffered, t)
        : quotaEvictionRange(sb.buffered, t, (cut) => host.safeCut(cut));
    if (evict) {
      await whenIdle(sb, () => sb.remove(evict[0], evict[1]));
      host.check();
    }
    try {
      await whenIdle(sb, () => sb.appendBuffer(data));
      return;
    } catch (err) {
      if (!isQuotaExceeded(err)) throw err;
    }
    q.hits++;
    host.check();
    const ahead = bufferedAhead(sb.buffered, host.currentTime());
    // Stay below what fitted from now on, so the next chunks wait in the loop above instead.
    q.cap = Math.min(q.cap, Math.max(MIN_AHEAD_S, ahead * QUOTA_CAP_FACTOR));
    // The first retry evicts behind the playhead down to the safe minimum.
    if (attempt === 0) continue;
    const stale = host.staleAhead();
    if (stale) {
      await whenIdle(sb, () => sb.remove(stale[0], stale[1]));
      continue;
    }
    if (ahead < MIN_AHEAD_S && (await host.relieve())) continue;
    if (ahead < STARVED_AHEAD_S) {
      if (++starved >= MAX_STARVED_HITS) {
        throw new PlaybackError(
          'playback-failed',
          'the browser’s media buffer is too small to hold this video',
        );
      }
    } else {
      starved = 0;
    }
    await host.progress();
  }
}

/** Element-time duration of everything in `ranges`. */
export function totalBuffered(ranges: Ranges): number {
  let s = 0;
  for (let i = 0; i < ranges.length; i++) s += ranges.end(i) - ranges.start(i);
  return s;
}

/**
 * e2e test hook (`localStorage['webtor:sb-quota-bytes']`): makes `sb.appendBuffer` throw
 * `QuotaExceededError` like Safari once the bytes it holds would pass `quota`. Bytes held are
 * estimated as buffered seconds × the average bytes per appended second.
 */
export function simulateQuota(sb: AppendBuffer, quota: number, onHit: () => void): void {
  const append = sb.appendBuffer.bind(sb);
  let bytes = 0;
  let seconds = 0;
  sb.appendBuffer = (data) => {
    const before = totalBuffered(sb.buffered);
    const held = seconds > 0 ? before * (bytes / seconds) : 0;
    if (held > 0 && held + data.byteLength > quota) {
      onHit();
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    append(data);
    sb.addEventListener(
      'updateend',
      () => {
        bytes += data.byteLength;
        seconds += Math.max(0, totalBuffered(sb.buffered) - before);
      },
      { once: true },
    );
  };
}
