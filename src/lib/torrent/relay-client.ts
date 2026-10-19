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
  relayTranscodeErrorCode,
  type RelayFailure,
  type RelayInfo,
  type RelayStats,
} from './relay';

/** Longer than the relay's own 90 s metadata wait, so its 504 normally arrives first. */
export const METAINFO_TIMEOUT_MS = 120_000;
const INFO_TIMEOUT_MS = 8_000;
/**
 * The relay answers a transcode request once ffmpeg wrote its first bytes, which needs the start of
 * the file from the swarm first. The relay itself gives up (504) after its idle timeout.
 */
export const TRANSCODE_HEADERS_TIMEOUT_MS = 90_000;

export class RelayRequestError extends Error {
  constructor(readonly failure: RelayFailure) {
    super(`relay request failed: ${failure.kind}`);
    this.name = 'RelayRequestError';
  }
}

/**
 * GET `url` (POST `body` when given) with a deadline. Rejects with `RelayRequestError` for network failures, timeouts and
 * non-2xx answers; with the caller's `AbortError` when `signal` aborts.
 */
async function relayGet(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  { bodyTimeout = true, body }: { bodyTimeout?: boolean; body?: Uint8Array<ArrayBuffer> } = {},
): Promise<Response> {
  // `bodyTimeout: false`: the deadline covers the response headers only (a streamed body).
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException('relay timeout', 'TimeoutError')),
    timeoutMs,
  );
  let res: Response;
  try {
    res = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
      cache: 'no-store',
      // No Content-Type: the POST stays a CORS "simple" request.
      ...(body ? { method: 'POST', body } : {}),
    });
  } catch (err) {
    clearTimeout(timer);
    if (signal?.aborted) throw err;
    throw new RelayRequestError(
      deadline.signal.aborted ? { kind: 'timeout' } : { kind: 'network' },
    );
  }
  if (!bodyTimeout) clearTimeout(timer);
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
 * metadata. With `torrentFile` (a .torrent the user opened) it POSTs that to the bare metainfo
 * URL, so the relay needs no metadata from the swarm. Fails with a `relay-*` `PlaybackError`.
 */
export async function fetchRelayMetainfo(
  url: string,
  signal?: AbortSignal,
  torrentFile?: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  try {
    const res = await relayGet(url, METAINFO_TIMEOUT_MS, signal, { body: torrentFile });
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

/**
 * Starts the relay's H.264 conversion of a file (ADR 0007 §2) and returns the fragmented MP4 body.
 * Not reading it is the back-pressure: the relay's ffmpeg blocks on its pipe. Abort `signal` to end
 * the job (a seek or a closed file). Fails with a `relay-*` `PlaybackError`.
 */
export async function fetchRelayTranscode(
  url: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  try {
    const res = await relayGet(url, TRANSCODE_HEADERS_TIMEOUT_MS, signal, { bodyTimeout: false });
    if (!res.body) throw new RelayRequestError({ kind: 'bad-response' });
    return res.body;
  } catch (err) {
    if (err instanceof RelayRequestError) {
      throw new PlaybackError(relayTranscodeErrorCode(err.failure), relayErrorDetail(err.failure));
    }
    throw err;
  }
}
