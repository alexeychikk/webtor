# 0006 — Regular BitTorrent peers through a user-run Go relay

Date: 2026-10-18 · Status: accepted (prototype in `relay/`) · Amends 0002

## Context

A page (JS or WebAssembly alike) can't open TCP/UDP sockets, so it only reaches WebRTC peers
(0002). Most swarms have none: the Ubuntu 26.04 desktop ISO has 623 seeders on
`https://torrent.ubuntu.com/announce` (scrape, 2026-10-18) and is unknown to
`wss://tracker.webtorrent.dev`. Porting a BitTorrent engine to wasm changes nothing without a
socket transport. Product decisions: the hosted site stays static and works without a relay;
reaching regular peers is opt-in through a relay **the user runs**; the relay is Go, in this repo.

## Options (status checked 2026-10-18)

| Option                                                                       | Verdict                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Full client in a Go relay, served to the page as `xs=` + BEP-19 web seed** | **Chosen.** One binary for the user's computer and a server. All discovery (DHT, UDP/HTTP trackers, PEX, uTP) is done by anacrolix/torrent. The page's pipeline is unchanged.                                                                                                       |
| Dumb WS↔TCP pipe, BitTorrent engine in the page                              | Rejected. The relay would still need DHT and UDP trackers, so it isn't dumb. WebTorrent's browser build has no hook for an outgoing non-WebRTC wire, so it means forking it or writing our own engine. Every peer connection crosses the relay anyway, so it saves no bandwidth.    |
| Relay joins the WebRTC swarm (anacrolix speaks WebTorrent via pion)          | Background only. It needs a public WSS tracker and working ICE/STUN, and users can't point the app at it deterministically.                                                                                                                                                         |
| Chrome Direct Sockets in an Isolated Web App                                 | Rejected. IWAs reach end users only on enterprise-managed ChromeOS, from a Google allowlist (Chrome 143+). Windows-managed support is planned for Chrome 161. Elsewhere it needs a dev-mode flag. We'd also need a JS engine over `TCPSocket`/`UDPSocket`, and WebTorrent has none. |
| Browser extension                                                            | Rejected. MV3 (Chrome/Firefox) has no socket API (`chrome.sockets` died with Chrome Apps). Native messaging only reaches a native helper, which is the local relay with more steps.                                                                                                 |
| Cloudflare Worker `connect()`                                                | Background only. Outbound TCP only: no UDP, so no DHT or UDP trackers, and nothing inbound. Per-request CPU limits don't fit hashing a video stream.                                                                                                                                |
| Node relay (webtorrent-hybrid / WebTorrent in Node)                          | Superseded by the Go decision.                                                                                                                                                                                                                                                      |

## Decision

**`relay/`** is a Go module (`github.com/alexeychikk/webtor/relay`, Go from `mise.toml`) building
**`webtor-relay`**. It wraps an anacrolix/torrent client with TCP, uTP, DHT, PEX, UDP/HTTP trackers
and a default public tracker list. WebRTC and seeding-after-done are off. API (`{base}` =
`scheme://host/<token>`; the token is the access control, CORS `*`):

- `GET {base}/v1/info` → `{name, version, api}`. Use it for "test connection".
- `GET {base}/v1/torrents/{ih}/metainfo?<magnet query>` adds the torrent (`tr=` of every scheme,
  `dn=`, `x.pe=`, `ws=`) and waits up to 90 s for the info dict. It answers with a .torrent that
  holds only `info`, or 504 when the swarm gave no metadata. With `-max-torrents` (default 3)
  torrents busy it answers 429 `{error, maxTorrents}` (the app shows `relay-busy`); a torrent idle
  for a minute is evicted instead.
- `POST {base}/v1/torrents/{ih}/metainfo` with a .torrent as the body (no Content-Type, so CORS
  needs no preflight beyond Private Network Access) adds the torrent from it at once and answers
  like GET. The app uses it for an opened .torrent that needs relay video conversion (0007).
- `GET {base}/v1/torrents/{ih}/files` → `[{index, path, length, webseedPath}]`.
- `GET {base}/v1/torrents/{ih}/stats` → swarm peers/seeders, bytes, and (api 3) rates: from the
  swarm, to peers, served to the browser, plus the readahead and upload cap in force. This is what the UI shows,
  because WebTorrent only sees one wire, the web seed.
- `GET|HEAD {base}/v1/torrents/{ih}/webseed/[<name>/<path>]` returns file bytes with `Range`
  (`http.ServeContent` over an anacrolix `Reader`). The reader is responsive (the page re-hashes)
  and reads ahead to the end of the requested range. Past that end the relay raises the piece
  priority of a readahead window (see Throughput). `ResolveWebseedPath` copes with WebTorrent not percent-encoding `#`/`?` in file
  names (a `#` loses the rest of the path: the relay matches the unique file it can still be).
  anacrolix sometimes leaves a seeder connection interested and unchoked but sending no requests
  (about 1 cold 200 MB run in 10 on loopback), until the readers go away when the browser times
  out after 60 s. So a read that gets no data for 3 s toggles the torrent's data download off and
  on, which cancels every request; readers retry the error this causes. Stalls then last 3–6 s.
- Anything outside `/<token>/` is the web app embedded in the binary (`GET /` → `index.html`).
- Torrents idle for 10 min are dropped and their pieces deleted, as at shutdown and startup. Nothing
  survives a restart. The token is generated once and kept in the data dir. Logs never contain it.

**The app** keeps WebTorrent. With a relay configured, it fetches `metainfo` itself, so it controls
the timeout, retries and error codes. It then calls `client.add(torrentBytes, {announce: <ws
trackers>, urlList: [{base}/v1/torrents/{ih}/webseed/]})`. WebTorrent verifies every piece, keeps
using WebRTC peers too, and `ByteSource` → Mediabunny → MSE is untouched.

**Where the relay runs:**

1. **Primary: on the user's computer.** Download one binary and run it; it prints the relay URL and
   an "Open" link (`…#relay=<url>`) that configures the app in one click. Chrome (142+; loopback
   prompt split out in 145, WebSockets covered from 147) and Firefox (153+) show a one-time Local
   Network Access prompt for `http://127.0.0.1` from the HTTPS site. Neither treats loopback as
   mixed content. **Safari blocks `http://127.0.0.1` from HTTPS pages** (WebKit 171934), so the relay
   also serves the built web app at `/`. Opening `http://127.0.0.1:7881/#relay=…` is then
   same-origin: no prompt and no mixed content, in every browser.
2. **Secondary: a server the user owns.** Docker image + Dockerfile, behind HTTPS: an HTTPS page can't
   call a remote `http://` relay, so Caddy or the host's TLS goes in front, and `-public-url` names
   it. Free PaaS tiers don't fit in 2026. Render free has 5 GB/month of bandwidth and sleeps after
   15 min. Koyeb needs a card, has 0.1 vCPU and allows one instance. Hugging Face Docker Spaces are
   paid and egress only on 80/443/8080. Torrent traffic is also against most PaaS ToS. Document a
   VPS (e.g. Oracle Cloud Always Free) instead of a one-click button.

**Privacy copy (setup UI and relay output):** the relay sees every byte and every torrent you open;
swarm peers and trackers see the relay's IP address, which is your home IP when it runs locally,
just as with qBittorrent. Keep the relay URL secret: it is the password.

## Evidence (2026-10-18, arm64 sandbox, Chromium 156 headless)

- `relay/internal/relay/server_test.go`: a TCP-only anacrolix seeder on loopback (no DHT, trackers or
  WebRTC) is reached through the relay. Metainfo hash, a `Range` read and the full 8 MiB file all
  match.
- Unmodified WebTorrent 3.0.21 browser bundle with a magnet whose only sources are `xs=`/`ws=` on the
  relay, a 200 MB file and 1 MiB pieces, from the `tcp-seeder` tool:
  - metadata in 12–19 ms;
  - a cold 4 MiB read from mid-file (a seek) in ~0.24 s;
  - full download at **~44 MB/s with a cold relay** (8–10 MB/s before the reader was made
    responsive), **~78 MB/s once the relay has the data**;
  - `curl` straight from the relay: 83 MB/s cold.
- **Public swarm not measurable here:** this sandbox's egress is TCP 80/443 only. UDP to DHT
  routers and trackers times out, and TCP to peer ports is refused. The relay therefore found 0 peers
  for Ubuntu 26.04 and returned 504 after 90 s, as designed. `relay/scripts/measure.sh` reproduces
  the public measurement (metadata time, seek latency, 64 MiB throughput) on a normal network.
- Static cross-builds (`CGO_ENABLED=0`) for linux, windows/amd64 and darwin/arm64 work (~30 MB).

## Throughput (2026-10-24)

A user's relay on Oracle's E2.1.Micro streamed at no more than ~5 MB/s. Four candidates, measured
with `relay/scripts/bench-webtorrent.mjs` (WebTorrent 3.0.21 in Chromium, 100 MB from the loopback
`tcp-seeder`, delay proxies for RTT; MB/s cold relay / warm relay):

| page↔relay RTT | relay↔swarm RTT | piece   | before (main) | after                                   |
| -------------- | --------------- | ------- | ------------- | --------------------------------------- |
| 0 ms           | 0 ms            | 1 MiB   | 32.8 / 39.6   | 32.9 / 60.2                             |
| 100 ms         | 0 ms            | 256 KiB | 6.2 / 7.4     | 8.9 / 12.0                              |
| 100 ms         | 0 ms            | 1 MiB   | 19.2 / 22.4   | 34.3 / 39.7                             |
| 100 ms         | 0 ms            | 4 MiB   | 41.4 / 45.4   | 48.0 / 53.1                             |
| 0 ms           | 100 ms          | 1 MiB   | 11.3 / 54.7   | 30.4 / 54.8                             |
| 50 ms          | 100 ms          | 1 MiB   | 8.7 / 30.7    | 19.7 / 29.5 (23.5 / 37.2 with 16 conns) |

"Before" is WebTorrent's default `maxWebConns` 4. "After" uses 16, as the app now does, in the
rows with page RTT. The swarm-RTT rows keep 4, to show the readahead fix on its own.

1. **The E2.1.Micro network cap: the ceiling.** Oracle caps the shape at 50 Mbit/s, ~6 MB/s, about
   5.5 MB/s of payload after TCP/TLS, which is the reported number. No relay change goes past it. A
   4K remux needs 6–12 MB/s, so the Micro can't stream one. A1 gets 1 Gbit/s per OCPU. The deploy
   script says so when it falls back to the Micro, and the README does too.
2. **Upload to peers: shares that ceiling.** Serving the browser and uploading to peers are both
   egress on the same capped VNIC, and anacrolix uploaded without limit to every peer it unchoked.
   Now `-max-upload-rate` defaults to 1 MiB/s (a token bucket, `ClientConfig.UploadRateLimiter`),
   and the Micro runs with `WEBTOR_RELAY_NO_UPLOAD=1`. `/stats` shows `uploadRate` next to
   `servedRate`, so the share is visible.
3. **The 32 MiB readahead: worse than small, it did nothing.** The prefetch was an anacrolix
   `Reader` seeked to the end of the served range and never read. anacrolix only wants the
   readahead of a reader that is reading (`piecesUncached` sets it to 0 otherwise, and `Seek` resets
   that), so beyond each web seed request the relay fetched nothing until the browser asked. With
   the swarm 100 ms away a cold relay ran at 11.3 MB/s against 54.7 MB/s warm. Now the relay raises
   the priority of a window of pieces past each request (`DownloadPieces`, cancelling what falls
   behind on a seek, `nextWindow`). The window is 30 s of what the relay serves (rate over 5 s),
   at least `-readahead` (32 MiB) and at most `-max-readahead` (512 MiB). It lives on disk, and
   pieces leave with the torrent when it goes idle. Cold went to 30.4 MB/s; a seek costs at most
   the old window's not-yet-downloaded pieces, which are cancelled.
4. **Web seed latency and concurrency.** WebTorrent fetches one whole piece per request and keeps
   `min(1 + ceil(speed·1 s / pieceLength), maxWebConns)` requests in flight, `maxWebConns` 4 by
   default. At 100 ms RTT with 256 KiB pieces that is ~1 MiB per round trip: 6.2 MB/s. The app now
   adds relay torrents with `maxWebConns` 16 (`RELAY_WEB_CONNS`, `src/lib/torrent/client.ts`):
   +40–80 % at 50–100 ms. Over HTTPS the relay speaks HTTP/2 (Caddy), so 16 streams share one
   connection. Over plain HTTP Chromium opens at most 6 per host, which the bench above hits.
   Small pieces stay slow at high RTT; nothing on the relay's side changes piece size.

## Consequences

- Without a relay nothing changes. The no-peers message gains "Connect a relay".
- With a relay, any healthy public torrent should start. Speed is bounded by the swarm and the
  user's uplink, not by the web seed path.
- The relay is an open door to whoever has the URL: token in the path, nothing else. Rate limits,
  multiple users and accounts are non-goals.
- Disk: the relay holds the pieces of what is being watched (plus up to `-max-readahead`) until the
  torrent goes idle.
- On a capped host (the E2.1.Micro) the host, not the relay, sets the speed. `/stats` and the
  app's stats panel ("From swarm", "To peers", "To you") tell which side limits it.
- Releases are manual like the site (0005): binaries via `gh release`, image to GHCR, no GitHub
  Actions.
