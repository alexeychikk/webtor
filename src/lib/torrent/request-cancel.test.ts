import { describe, expect, it, vi } from 'vitest';
import type { Torrent } from 'webtorrent/dist/webtorrent.min.js';
import {
  cancelUnwantedRequests,
  trackWebSeed,
  unwantedRequests,
  withAbortableFetch,
  type PieceRequest,
} from './request-cancel';

const request = (piece: number, offset = 0, length = 16384): PieceRequest => ({
  piece,
  offset,
  length,
});

describe('unwantedRequests', () => {
  it('keeps requests inside any selection and returns the rest', () => {
    const requests = [request(0), request(5), request(9), request(20)];
    const selections = [
      { from: 0, to: 5 },
      { from: 18, to: 25 },
    ];
    expect(unwantedRequests(requests, selections)).toEqual([request(9)]);
  });

  it('returns every request when nothing is selected', () => {
    expect(unwantedRequests([request(1), request(2)], [])).toHaveLength(2);
  });
});

type Callback = (err: Error | null, data?: Uint8Array) => void;

class FakeWire {
  destroyed = false;
  requests: PieceRequest[] = [];
  readonly cancel = vi.fn((piece: number, offset: number, length: number) => {
    this.requests = this.requests.filter(
      (r) => !(r.piece === piece && r.offset === offset && r.length === length),
    );
  });
  constructor(readonly type: string) {}
}

/** A web seed whose `httpRequest` keeps the signal of the fetch it started and its callback. */
function webSeedClass(fetchSignals: (AbortSignal | undefined)[], callbacks: Callback[]) {
  class WebConn extends FakeWire {
    constructor() {
      super('webSeed');
    }
    async httpRequest(_piece: number, _offset: number, _length: number, cb: Callback) {
      callbacks.push(cb);
      fetchSignals.push(currentSignal());
    }
  }
  return WebConn;
}

let currentSignal: () => AbortSignal | undefined = () => undefined;

const torrentOf = (wires: FakeWire[], selections: { from: number; to: number }[]) =>
  ({ destroyed: false, wires, _selections: selections }) as unknown as Torrent;

describe('withAbortableFetch + trackWebSeed', () => {
  it("adds the web seed request's signal to the fetch it starts, and restores fetch after loading", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const scope = {
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init?.signal ?? undefined);
        return new Response();
      }) as unknown as typeof fetch,
    };
    const original = scope.fetch;
    let bundleFetch: typeof fetch = original;
    await withAbortableFetch(async () => {
      bundleFetch = scope.fetch;
    }, scope);
    expect(scope.fetch).toBe(original);
    expect(bundleFetch).not.toBe(original);

    await bundleFetch('http://seed/a');
    expect(seen[0]).toBeUndefined();

    const signals: (AbortSignal | undefined)[] = [];
    const callbacks: Callback[] = [];
    currentSignal = () => {
      void bundleFetch('http://seed/b');
      return seen.at(-1);
    };
    const WebConn = webSeedClass(signals, callbacks);
    const wire = new WebConn();
    trackWebSeed(wire);
    wire.requests = [request(3), request(7)];
    await wire.httpRequest(3, 0, 16384, () => {});
    await wire.httpRequest(7, 0, 16384, () => {});
    const [kept, dropped] = signals;
    expect(kept?.aborted).toBe(false);

    expect(cancelUnwantedRequests(torrentOf([wire], [{ from: 0, to: 5 }]))).toBe(1);
    expect(wire.cancel).toHaveBeenCalledWith(7, 0, 16384);
    expect(dropped?.aborted).toBe(true);
    expect(kept?.aborted).toBe(false);
    expect(wire.requests).toEqual([request(3)]);
  });

  it('never calls back an aborted request (WebConn would answer it with donthave)', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const callbacks: Callback[] = [];
    currentSignal = () => undefined;
    const WebConn = webSeedClass(signals, callbacks);
    const wire = new WebConn();
    trackWebSeed(wire);
    const answered = vi.fn();
    wire.requests = [request(9)];
    await wire.httpRequest(9, 0, 16384, answered);
    cancelUnwantedRequests(torrentOf([wire], []));
    callbacks[0]!(new Error('aborted'));
    expect(answered).not.toHaveBeenCalled();

    wire.requests = [request(2)];
    await wire.httpRequest(2, 0, 16384, answered);
    callbacks[1]!(new Error('timeout'));
    expect(answered).toHaveBeenCalledWith(new Error('timeout'), undefined);
  });

  it('patches a web seed class once and leaves peer wires alone', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const callbacks: Callback[] = [];
    const WebConn = webSeedClass(signals, callbacks);
    const first = new WebConn();
    trackWebSeed(first);
    const patched = WebConn.prototype.httpRequest;
    trackWebSeed(new WebConn());
    expect(WebConn.prototype.httpRequest).toBe(patched);

    const peer = new FakeWire('webrtc');
    trackWebSeed(peer);
    expect('httpRequest' in peer).toBe(false);
  });
});

describe('cancelUnwantedRequests', () => {
  it('cancels the requests outside every selection on every live wire', () => {
    const peer = new FakeWire('webrtc');
    peer.requests = [request(1), request(40, 16384)];
    const gone = new FakeWire('webrtc');
    gone.destroyed = true;
    gone.requests = [request(50)];
    const torrent = torrentOf([peer, gone], [{ from: 0, to: 10 }]);
    expect(cancelUnwantedRequests(torrent)).toBe(1);
    expect(peer.cancel).toHaveBeenCalledWith(40, 16384, 16384);
    expect(gone.cancel).not.toHaveBeenCalled();
    expect(cancelUnwantedRequests(torrent)).toBe(0);
  });

  it('does nothing on a destroyed torrent', () => {
    const peer = new FakeWire('webrtc');
    peer.requests = [request(1)];
    const torrent = { destroyed: true, wires: [peer], _selections: [] } as unknown as Torrent;
    expect(cancelUnwantedRequests(torrent)).toBe(0);
  });
});
