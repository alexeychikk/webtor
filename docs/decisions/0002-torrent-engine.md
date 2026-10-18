# 0002 — Torrent engine: WebTorrent 3 in the page, WebRTC peers only

Date: 2026-10-18 · Status: accepted

## Decision

Use **WebTorrent 3.x** (`webtorrent@^3.0.21`) in the main thread, imported as its prebuilt ESM browser
bundle `webtorrent/dist/webtorrent.min.js` (default export). It needs no Node polyfills in Vite.
Typings for the subset we use live in `src/lib/torrent/webtorrent.d.ts`.

There is no alternative: a web page cannot open TCP/UDP sockets, so libtorrent-style engines can't
run in it, and the Direct Sockets API is limited to Chrome Isolated Web Apps. WebTorrent is the only
maintained BitTorrent-over-WebRTC implementation.

- **Peers:** only WebRTC peers — other browser tabs running WebTorrent, WebTorrent Desktop,
  `webtorrent-cli`, and libtorrent ≥ 2.0 _only when built with WebTorrent support_ (not the usual
  qBittorrent/Transmission/µTorrent builds). No DHT, no UDP/HTTP trackers, no PEX to TCP peers.
- **Discovery:** WebSocket trackers only: the magnet's own `ws(s)://` `tr=` entries plus
  `DEFAULT_WS_TRACKERS` (`src/lib/torrent/trackers.ts`).
- **Mitigations that need no server of ours:** BEP-19 web seeds (`ws=` in the magnet, `urlList` in a
  .torrent) over CORS-enabled HTTP; `xs=` (URL of the .torrent) so metadata arrives without any peer;
  accepting a `.torrent` file upload/URL (metadata without peers).
- **Storage:** WebTorrent's browser default chunk store (OPFS via `fsa-chunk-store`, memory fallback);
  add torrents with `destroyStoreOnDestroy: true` so OPFS is freed when the user leaves a torrent.
  WebTorrent picks OPFS whenever `createWritable` exists, even where writes then fail (Safari
  private browsing, Playwright's WebKit: `UnknownError`), so `client.ts` probes one OPFS write first
  and otherwise passes our `MemoryChunkStore` (`memory-store.ts`).
- **Piece selection:** keep `strategy: 'sequential'`; deselect the whole torrent after metadata and let
  the reads the media pipeline makes (`file.stream({start,end})`) drive priority; the selected video
  file is then `select()`ed at low priority for read-ahead.
- **No-peer UX:** never an endless spinner. Within 20 s with no metadata and no wires → show the
  `no-peers` message (`src/lib/player/errors.ts`) with live tracker/peer counts, keep searching in the
  background. Metadata but 0 B/s and 0 wires for 30 s → `stalled`.

## Evidence (2026-10-18)

- Scrape from our sandbox: the official Ubuntu 24.04.3 desktop ISO torrent (among the best-seeded
  torrents in existence) is **unknown** to `wss://tracker.webtorrent.dev` — zero WebRTC peers. The
  WebTorrent demo torrents (Sintel, Big Buck Bunny, Tears of Steel) show exactly 1 seeder each.
  `tracker.openwebtorrent.com` timed out; `tracker.btorrent.xyz` and `tracker.files.fm:7073` refused.
- Spike: WebTorrent 3.0.21 browser bundle in Chromium fetched metadata via `xs=` and data via `ws=` with
  zero peers; two Chromium pages also swarmed over WebRTC through a local `bittorrent-tracker`.

## Consequences

Most magnets copied from public torrent sites will find **no peers** and cannot play. This is a hard
limit of "no backend", not a bug, and the UI must say so plainly. webtor.io itself works because it
downloads on its own servers. A user-run gateway lifts the limit as an opt-in:
[0006](0006-regular-peers-relay.md).
