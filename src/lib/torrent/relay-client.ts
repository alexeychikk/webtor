/**
 * Fetch glue for webtor-relay (docs/decisions/0006). Decisions (error codes, parsing) are the pure
 * helpers in `relay.ts`; this file only talks HTTP.
 */
import { PlaybackError } from '../player/errors';
import {
  parseRelayInfo,
  parseRelayStats,
  relayErrorCode,
  relayErrorDetail,
  type RelayFailure,
  type RelayInfo,
  type RelayStats,
} from './relay';

/** Longer than the relay's own 90 s metadata wait, so its 504 normally arrives first. */
export const METAINFO_TIMEOUT_MS = 120_000;
const INFO_TIMEOUT_MS = 8_000;

export class RelayRequestError extends Error {
  constructor(readonly failure: RelayFailure) {
    super(`relay request failed: ${failure.kind}`);
    this.name = 'RelayRequestError';
  }
}

/**
 * GET `url` with a deadline. Rejects with `RelayRequestError` for network failures, timeouts and
 * non-2xx answers; with the caller's `AbortError` when `signal` aborts.
 */
async function relayGet(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      cache: 'no-store',
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new RelayRequestError(deadline.aborted ? { kind: 'timeout' } : { kind: 'network' });
  }
  if (!res.ok) {
    let message: string | undefined;
    try {
      const body: unknown = await res.json();
      const error = (body as { error?: unknown } | null)?.error;
      if (typeof error === 'string') message = error;
    } catch {
      // Not JSON (e.g. Go's plain-text 404 for a wrong token).
    }
    throw new RelayRequestError({ kind: 'http', status: res.status, message });
  }
  return res;
}

/**
 * Asks the relay to join the swarm and returns the .torrent (info dict only) once it has the
 * metadata. Fails with a `relay-*` `PlaybackError`.
 */
export async function fetchRelayMetainfo(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  try {
    const res = await relayGet(url, METAINFO_TIMEOUT_MS, signal);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // A bencoded dictionary starts with `d`.
    if (bytes[0] !== 0x64) throw new RelayRequestError({ kind: 'bad-response' });
    return bytes;
  } catch (err) {
    if (err instanceof RelayRequestError) {
      throw new PlaybackError(relayErrorCode(err.failure), relayErrorDetail(err.failure));
    }
    throw err;
  }
}

/** "Test connection": `GET {base}/v1/info`. Rejects with `RelayRequestError`. */
export async function fetchRelayInfo(infoUrl: string): Promise<RelayInfo> {
  const res = await relayGet(infoUrl, INFO_TIMEOUT_MS);
  let info: RelayInfo | null = null;
  try {
    info = parseRelayInfo(await res.json());
  } catch {
    // fall through
  }
  if (!info) throw new RelayRequestError({ kind: 'bad-response' });
  return info;
}

/** Swarm stats for the UI; `null` on any failure (stats are best effort). */
export async function fetchRelayStats(
  statsUrl: string,
  signal?: AbortSignal,
): Promise<RelayStats | null> {
  try {
    const res = await relayGet(statsUrl, INFO_TIMEOUT_MS, signal);
    return parseRelayStats(await res.json());
  } catch {
    return null;
  }
}
