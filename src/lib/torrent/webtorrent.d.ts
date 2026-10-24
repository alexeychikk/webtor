/**
 * Minimal typings for the subset of the WebTorrent 3 browser API this app uses.
 * Import the prebuilt ESM browser bundle — it needs no Node polyfills in Vite:
 *   import WebTorrent from 'webtorrent/dist/webtorrent.min.js';
 * Extend these declarations when you use more of the API; check behaviour in node_modules/webtorrent/lib.
 */
declare module 'webtorrent/dist/webtorrent.min.js' {
  interface Emitter {
    off(event: string, cb: (...args: any[]) => void): this;
    once(event: string, cb: (...args: any[]) => void): this;
  }

  export interface FileRange {
    /** First byte, inclusive. */
    start?: number;
    /**
     * Last byte, INCLUSIVE. Gotcha: `end: 0` is treated as "to end of file" (falsy check in
     * lib/file.js) — never pass 0; read [0, 1] and slice instead.
     */
    end?: number;
  }

  export interface TorrentFile {
    readonly name: string;
    readonly path: string;
    readonly length: number;
    /** Byte offset of this file inside the torrent's concatenated payload. */
    readonly offset: number;
    readonly downloaded: number;
    readonly progress: number;
    readonly done: boolean;
    select(priority?: number): void;
    deselect(): void;
    /** Web stream over a byte range; reading prioritises (and waits for) the covering pieces. */
    stream(opts?: FileRange): ReadableStream<Uint8Array>;
    arrayBuffer(opts?: FileRange): Promise<ArrayBuffer>;
    blob(opts?: FileRange): Promise<Blob>;
    [Symbol.asyncIterator](opts?: FileRange): AsyncIterator<Uint8Array>;
  }

  export interface Torrent extends Emitter {
    readonly infoHash: string;
    readonly magnetURI: string;
    readonly name: string;
    readonly files: TorrentFile[];
    readonly length: number;
    readonly ready: boolean;
    /** Set at the start of `destroy()` (which empties `files`); a second `destroy()` never calls back. */
    readonly destroyed: boolean;
    /** Every connection, web seeds included (`type: 'webSeed'`); `numPeers` is its length. */
    readonly wires: ReadonlyArray<{ readonly type?: string }>;
    readonly numPeers: number;
    readonly downloadSpeed: number;
    readonly uploadSpeed: number;
    /** Payload bytes received so far (all pieces, finished or not). */
    readonly downloaded: number;
    readonly progress: number;
    readonly pieceLength: number;
    /** Verified pieces (`get(i)`); null until the torrent's info is known. */
    readonly bitfield: { get(index: number): boolean } | null;
    /** Lowest priority selection; `deselect(0, pieces.length - 1)` stops the default "download everything". */
    select(start: number, end: number, priority?: number): void;
    deselect(start: number, end: number): void;
    /** Mark pieces as highest priority (fetched first, possibly from several peers). */
    critical(start: number, end: number): void;
    addWebSeed(url: string): void;
    destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void;
    on(event: 'infoHash' | 'metadata' | 'ready' | 'done' | 'trackerAnnounce', cb: () => void): this;
    on(event: 'warning' | 'error', cb: (err: Error | string) => void): this;
    /** Fired periodically per discovery source ('tracker', 'dht', …) that currently yields 0 peers. */
    on(event: 'noPeers', cb: (source: string) => void): this;
    on(event: 'wire', cb: (wire: unknown, addr?: string) => void): this;
    on(event: 'download' | 'upload', cb: (bytes: number) => void): this;
  }

  export interface AddOptions {
    /** Extra trackers merged with the magnet's own `tr=` list. */
    announce?: string[];
    /** Extra BEP-19 web seeds merged with the magnet's `ws=` list. */
    urlList?: string[];
    /** 'sequential' (default) or 'rarest'. */
    strategy?: 'sequential' | 'rarest';
    /** Free the OPFS / memory chunk store when the torrent is destroyed. */
    destroyStoreOnDestroy?: boolean;
    deselect?: boolean;
    /** Chunk store constructor (abstract-chunk-store); default OPFS where `createWritable` exists. */
    store?: new (chunkLength: number, opts: { length?: number }) => unknown;
    /** Pieces cached in memory in front of the store (default 20; 0 = none). */
    storeCacheSlots?: number;
    /**
     * Piece requests in flight per web seed (default 4). WebTorrent asks a web seed for whole
     * pieces, one HTTP request each; fewer requests in flight than the round trip needs cap it.
     */
    maxWebConns?: number;
  }

  export interface ClientOptions {
    dht?: boolean;
    lsd?: boolean;
    utPex?: boolean;
    tracker?: boolean | Record<string, unknown>;
    maxConns?: number;
  }

  export default class WebTorrent {
    on(event: 'error' | 'warning', cb: (err: Error | string) => void): this;
    static readonly WEBRTC_SUPPORT: boolean;
    constructor(opts?: ClientOptions);
    readonly torrents: Torrent[];
    add(
      torrentId: string | Uint8Array | Blob,
      opts?: AddOptions,
      ontorrent?: (t: Torrent) => void,
    ): Torrent;
    seed(
      input: File | Blob | File[],
      opts?: AddOptions & { name?: string },
      onseed?: (t: Torrent) => void,
    ): Torrent;
    get(torrentId: string): Promise<Torrent | null>;
    remove(
      torrentId: string | Torrent,
      opts?: { destroyStore?: boolean },
      cb?: (err?: Error) => void,
    ): Promise<void>;
    destroy(cb?: (err?: Error) => void): void;
  }
}
