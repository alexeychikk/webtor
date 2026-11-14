/**
 * Drops piece requests nobody waits for any more (a file switch, a seek). WebTorrent 3.0.21 never
 * takes a sent request back when a stream's selection goes away, and a slow web seed gets one
 * piece request at a time (`getPiecePipelineLength`), so the new file's header waited behind the
 * old file's piece until the web seed's 60 s fetch timeout. Checked against webtorrent 3.0.21
 * (`WebConn.httpRequest`, bittorrent-protocol `Wire.cancel`).
 */
import type { Torrent } from 'webtorrent/dist/webtorrent.min.js';

/** A request in flight on a wire (bittorrent-protocol `Request`). */
export interface PieceRequest {
  piece: number;
  offset: number;
  length: number;
}

/** Piece ranges WebTorrent downloads (`torrent._selections`, inclusive `to`). */
export interface PieceSelection {
  from: number;
  to: number;
}

/** The requests for pieces outside every selection. */
export function unwantedRequests<R extends PieceRequest>(
  requests: readonly R[],
  selections: readonly PieceSelection[],
): R[] {
  return requests.filter(
    ({ piece }) => !selections.some(({ from, to }) => piece >= from && piece <= to),
  );
}

interface WireInternals {
  type?: string;
  destroyed?: boolean;
  requests: PieceRequest[];
  cancel(piece: number, offset: number, length: number): void;
}

type HttpRequest = (
  this: WireInternals,
  piece: number,
  offset: number,
  length: number,
  cb: (err: Error | null, data?: Uint8Array) => void,
) => Promise<void>;

interface WebSeedPrototype {
  httpRequest?: HttpRequest;
}

const requestKey = (piece: number, offset: number, length: number) =>
  `${piece}:${offset}:${length}`;

/** The abort controllers of each web seed's HTTP requests in flight, by `requestKey`. */
const webSeedFetches = new WeakMap<object, Map<string, AbortController>>();
const hookedPrototypes = new WeakSet<object>();
/** Set only while `WebConn.httpRequest` starts its fetches (synchronously, before any await). */
let startingSignal: AbortSignal | null = null;

/**
 * Wraps `scope.fetch` while `load` runs: the WebTorrent bundle keeps the `self.fetch` it found when
 * it was evaluated. The wrapper adds the web seed request's abort signal and is a plain pass-through
 * otherwise.
 */
export async function withAbortableFetch<T>(
  load: () => Promise<T>,
  scope: { fetch: typeof fetch } = globalThis,
): Promise<T> {
  const original = scope.fetch;
  if (typeof original !== 'function' || typeof AbortSignal.any !== 'function') return load();
  scope.fetch = (input, init) => {
    const signal = startingSignal;
    if (!signal) return original(input, init);
    const signals = init?.signal ? [init.signal, signal] : [signal];
    return original(input, { ...init, signal: AbortSignal.any(signals) });
  };
  try {
    return await load();
  } finally {
    scope.fetch = original;
  }
}

/**
 * Makes a web seed wire's HTTP requests abortable (`cancelUnwantedRequests`). Patches its class's
 * `httpRequest` once; other wires are left alone. An aborted request never calls back: the wire's
 * cancel already dropped it, and WebConn would answer the error with `donthave`, which keeps the
 * web seed off that piece for 10 s.
 */
export function trackWebSeed(wire: unknown): void {
  const w = wire as WireInternals;
  if (w.type !== 'webSeed') return;
  const proto = Object.getPrototypeOf(w) as WebSeedPrototype | null;
  const original = proto?.httpRequest;
  if (!proto || !original || hookedPrototypes.has(proto)) return;
  hookedPrototypes.add(proto);
  proto.httpRequest = function (piece, offset, length, cb) {
    let fetches = webSeedFetches.get(this);
    if (!fetches) webSeedFetches.set(this, (fetches = new Map()));
    const key = requestKey(piece, offset, length);
    const controller = new AbortController();
    fetches.set(key, controller);
    const done = (err: Error | null, data?: Uint8Array) => {
      if (fetches.get(key) === controller) fetches.delete(key);
      if (!controller.signal.aborted) cb(err, data);
    };
    startingSignal = controller.signal;
    try {
      return original.call(this, piece, offset, length, done);
    } finally {
      startingSignal = null;
    }
  };
}

/**
 * Cancels every request in flight for a piece no selection wants (no stream reads it any more) and
 * aborts a web seed's HTTP request for it, so the wire's slots go to the pieces that are waited
 * for. Returns how many requests went.
 */
export function cancelUnwantedRequests(torrent: Torrent): number {
  const internals = torrent as unknown as {
    _selections?: Iterable<PieceSelection>;
    wires: readonly WireInternals[];
  };
  if (torrent.destroyed || !internals._selections) return 0;
  const selections = [...internals._selections].map(({ from, to }) => ({ from, to }));
  let cancelled = 0;
  for (const wire of internals.wires) {
    if (wire.destroyed || !wire.requests?.length) continue;
    for (const { piece, offset, length } of unwantedRequests([...wire.requests], selections)) {
      wire.cancel(piece, offset, length);
      webSeedFetches
        .get(wire)
        ?.get(requestKey(piece, offset, length))
        ?.abort();
      cancelled++;
    }
  }
  return cancelled;
}
