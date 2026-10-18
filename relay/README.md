# webtor-relay

Lets the webtor web app download from **regular** BitTorrent peers (qBittorrent, Transmission,
libtorrent… over TCP/uTP, found via DHT, UDP/HTTP trackers and PEX), which a browser can't reach
on its own. It is a full BitTorrent client ([anacrolix/torrent](https://github.com/anacrolix/torrent))
that the app uses as a metadata source and an HTTP web seed. Why and how:
[`docs/decisions/0006-regular-peers-relay.md`](../docs/decisions/0006-regular-peers-relay.md).

```sh
go run ./cmd/webtor-relay          # from relay/
```

It prints three links:

- **Open** `http://127.0.0.1:7881/#relay=…`: the app served by the relay itself, already
  configured. Same-origin, so it works in every browser, Safari included.
- **Relay URL** `http://127.0.0.1:7881/<token>`: paste it into the app's relay setting.
- **Or open** the hosted app with the same setting (Chrome and Firefox ask once for local network
  access; Safari can't reach a local relay from an HTTPS page).

The token is the password: anyone with the relay URL can use your relay. The startup banner on
stdout is the only place it is printed; logs (stderr) never contain it.

**Privacy:** the relay sees every torrent you open and every byte of it, and swarm peers and trackers
see the relay's IP address. When it runs on your computer, that is your own IP, just as with any
torrent client.

## Behaviour

- At most `-max-torrents` torrents are open at once. Opening one more answers HTTP 429 with
  `{"error": "…", "maxTorrents": N}`, unless an open one has had no request for a minute: that one is
  dropped to make room.
- A metainfo request waits up to `-metadata-timeout` for the swarm, then answers 504.
- A torrent with no request for `-idle-timeout` is dropped. A request in progress (a metainfo wait,
  a web seed read) always keeps its torrent.
- Downloaded data lives in `<data-dir>/pieces/<infohash>/` only while the torrent is open. It is
  deleted when the torrent is dropped, at shutdown and at startup.
- The relay uploads to peers while a torrent is open (`-no-upload` turns that off) and never seeds
  after.
- Each web seed request downloads its whole range with top priority, plus `-readahead` bytes after
  it, so WebTorrent's next piece is usually already there. A seek moves both. A read that gets no
  data for 3 s makes the relay re-request the torrent's pieces (works around an anacrolix
  stall that otherwise lasts until WebTorrent's 60 s timeout). anacrolix then logs one harmless
  `read failed ... torrent data downloading disabled` error.
- SIGINT/SIGTERM shut down gracefully: in-flight requests get 3 s, then torrents are dropped and
  their data deleted. A second Ctrl-C kills the process.
- Multi-file torrents work, but WebTorrent puts file names into web seed URLs without
  percent-encoding them. A `?` is recovered from the query string. A `#` truncates the URL, so the
  relay picks the only file that continues the truncated path with `#` and is long enough for the
  requested range. Files whose paths differ only after a `#` can be ambiguous (404). Percent-encoded
  paths always work.

## Flags

Every flag can also be set by its environment variable (handy in Docker).

| Flag                   | Env                                | Default                         |
| ---------------------- | ---------------------------------- | ------------------------------- |
| `-listen`              | `WEBTOR_RELAY_LISTEN`              | `127.0.0.1:7881`                |
| `-public-url`          | `WEBTOR_RELAY_PUBLIC_URL`          | `http://<listen>`               |
| `-token`               | `WEBTOR_RELAY_TOKEN`               | generated, saved in data dir    |
| `-data-dir`            | `WEBTOR_RELAY_DATA_DIR`            | `<user cache dir>/webtor-relay` |
| `-peer-port`           | `WEBTOR_RELAY_PEER_PORT`           | `42069` (`0` = random)          |
| `-max-torrents`        | `WEBTOR_RELAY_MAX_TORRENTS`        | `3`                             |
| `-metadata-timeout`    | `WEBTOR_RELAY_METADATA_TIMEOUT`    | `90s`                           |
| `-idle-timeout`        | `WEBTOR_RELAY_IDLE_TIMEOUT`        | `10m`                           |
| `-readahead`           | `WEBTOR_RELAY_READAHEAD`           | `33554432` (32 MiB)             |
| `-no-upload`           | `WEBTOR_RELAY_NO_UPLOAD`           | off                             |
| `-no-default-trackers` | `WEBTOR_RELAY_NO_DEFAULT_TRACKERS` | off                             |
| `-no-dht`              | `WEBTOR_RELAY_NO_DHT`              | off                             |
| `-debug`               | `WEBTOR_RELAY_DEBUG`               | off (logs every API request)    |

## Development

```sh
gofmt -l . && go vet ./... && go test ./...
go run ./cmd/tcp-seeder <file-or-dir>   # TCP-only loopback seeder; prints a magnet with x.pe=
scripts/measure.sh [magnet]             # real-swarm metadata time, seek latency, throughput
node scripts/bench-webtorrent.mjs [MB]  # loopback throughput through WebTorrent in Chromium
```

`internal/relay` holds the HTTP API, `internal/seedtest` a regular (TCP-only) seeder for tests and
`internal/webapp` the app served at `/` (`go:embed` of `internal/webapp/dist`). Only a placeholder
`index.html` that links to the hosted site is committed. A release copies the built app (root
`pnpm build` → `dist/`) into `internal/webapp/dist/` before `go build`.
