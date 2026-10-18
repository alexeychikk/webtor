# webtor-relay

Lets the webtor web app download from **regular** BitTorrent peers (qBittorrent, Transmission,
libtorrent… over TCP/uTP, found via DHT, UDP/HTTP trackers and PEX), which a browser can't reach
on its own. It is a full BitTorrent client ([anacrolix/torrent](https://github.com/anacrolix/torrent))
that the app uses as a metadata source and an HTTP web seed. Why and how:
[`docs/decisions/0006-regular-peers-relay.md`](../docs/decisions/0006-regular-peers-relay.md).

```sh
go run ./cmd/webtor-relay          # from relay/; prints the relay URL and an "Open" link
```

Paste the printed **relay URL** (`http://127.0.0.1:7881/<token>`) into the app, or open the link.
The token is the password: anyone with the URL can use your relay.

**Privacy:** the relay sees every torrent you open and every byte of it, and swarm peers and trackers
see the relay's IP address. When it runs on your computer, that is your own IP, just as with any
torrent client.

| Flag                              | Env                       | Default                         |
| --------------------------------- | ------------------------- | ------------------------------- |
| `-listen`                         | `WEBTOR_RELAY_LISTEN`     | `127.0.0.1:7881`                |
| `-public-url`                     | `WEBTOR_RELAY_PUBLIC_URL` | `http://<listen>`               |
| `-token`                          | `WEBTOR_RELAY_TOKEN`      | generated, saved in data dir    |
| `-data-dir`                       | `WEBTOR_RELAY_DATA_DIR`   | `<user cache dir>/webtor-relay` |
| `-peer-port`                      |                           | `42069` (`0` = random)          |
| `-no-default-trackers`, `-no-dht` |                           | off                             |

## Development

```sh
gofmt -l . && go vet ./... && go test ./...
go run ./cmd/tcp-seeder <file>     # TCP-only loopback seeder; prints a magnet with x.pe=
scripts/measure.sh [magnet]        # real-swarm metadata time, seek latency, throughput
```

`internal/relay` holds the HTTP API, `internal/seedtest` a regular (TCP-only) seeder for tests.
