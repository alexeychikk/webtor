# webtor-relay

Lets the webtor web app download from **regular** BitTorrent peers (qBittorrent, Transmission,
libtorrent… over TCP/uTP, found via DHT, UDP/HTTP trackers and PEX), which a browser can't reach
on its own. It is a full BitTorrent client ([anacrolix/torrent](https://github.com/anacrolix/torrent))
that the app uses as a metadata source and an HTTP web seed. Why and how:
[`docs/decisions/0006-regular-peers-relay.md`](../docs/decisions/0006-regular-peers-relay.md).

## Run on your computer

Download the file for your system from the
[latest release](https://github.com/alexeychikk/webtor/releases/latest) (one file, nothing to
install; `SHA256SUMS` has the checksums):

| System               | File                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Windows              | [`webtor-relay-windows-amd64.exe`](https://github.com/alexeychikk/webtor/releases/latest/download/webtor-relay-windows-amd64.exe) |
| macOS, Apple silicon | [`webtor-relay-darwin-arm64`](https://github.com/alexeychikk/webtor/releases/latest/download/webtor-relay-darwin-arm64)           |
| macOS, Intel         | [`webtor-relay-darwin-amd64`](https://github.com/alexeychikk/webtor/releases/latest/download/webtor-relay-darwin-amd64)           |
| Linux x86-64         | [`webtor-relay-linux-amd64`](https://github.com/alexeychikk/webtor/releases/latest/download/webtor-relay-linux-amd64)             |
| Linux ARM64          | [`webtor-relay-linux-arm64`](https://github.com/alexeychikk/webtor/releases/latest/download/webtor-relay-linux-arm64)             |

- **Windows:** double-click the `.exe`. The binary isn't signed, so SmartScreen says "Windows
  protected your PC": click **More info → Run anyway**. Allow the firewall prompt so peers can
  connect to you.
- **macOS:** in Terminal, make it executable and remove the download quarantine (it isn't signed or
  notarized, so Gatekeeper would refuse to open it), then run it:
  ```sh
  cd ~/Downloads
  chmod +x webtor-relay-darwin-arm64
  xattr -d com.apple.quarantine webtor-relay-darwin-arm64
  ./webtor-relay-darwin-arm64
  ```
- **Linux:** `chmod +x webtor-relay-linux-amd64 && ./webtor-relay-linux-amd64`.

Keep the window open while you watch; Ctrl-C stops it. From source: `go run ./cmd/webtor-relay`
in `relay/`. `-version` prints the version.

**Video conversion** (DivX/Xvid AVIs, which browsers can't decode) needs
[ffmpeg](https://ffmpeg.org/) with libx264, which the binary doesn't include. Everything else works
without it. Install it, then restart the relay; it prints `Video conversion: on (ffmpeg …)`:

- **Windows:** `winget install ffmpeg` (or a "full"/"essentials" build from
  [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)). Opening a new window picks up the new `PATH`;
  `ffmpeg.exe` next to the relay's `.exe` works too.
- **macOS:** `brew install ffmpeg`.
- **Linux:** `sudo apt install ffmpeg` (Debian, Ubuntu), `sudo pacman -S ffmpeg` (Arch). On Fedora,
  take ffmpeg from RPM Fusion: Fedora's own `ffmpeg-free` has no libx264. A static build
  ([johnvansickle.com](https://johnvansickle.com/ffmpeg/)) works anywhere.

The relay looks for it with `-ffmpeg <path>`, then on `PATH`, then next to its own binary.

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

Peers find you faster when port `42069` (TCP and UDP, `-peer-port`) is reachable from the internet
(router port forwarding or UPnP). The relay works without it, with fewer peers.

## Run on a server

### Oracle Cloud in one click

`scripts/deploy-relay-oci.sh` puts the relay on an [Oracle Cloud](https://www.oracle.com/cloud/free/)
VM with HTTPS (Always Free unless you allow a paid one), using only Oracle's API (no SSH). The repository's **Deploy relay to Oracle Cloud** workflow runs it with your repository
secrets.

1. **API key.** In the OCI Console: Profile (top right) → **My profile** → **API keys** → **Add API
   key** → **Generate API key pair** → **Download private key** → **Add**. The configuration snippet
   it shows has `user`, `fingerprint`, `tenancy` and `region`.
2. **Secrets.** In the repository's Settings → Secrets and variables → Actions, add:

   | Secret                 | Value                                                                                      |
   | ---------------------- | ------------------------------------------------------------------------------------------ |
   | `OCI_TENANCY_OCID`     | `tenancy` from the snippet                                                                 |
   | `OCI_USER_OCID`        | `user`                                                                                     |
   | `OCI_FINGERPRINT`      | `fingerprint`                                                                              |
   | `OCI_REGION`           | `region`: your **home** region, e.g. `eu-frankfurt-1` (Always Free runs only there)        |
   | `OCI_PRIVATE_KEY`      | the whole downloaded `.pem` file                                                           |
   | `RELAY_TOKEN`          | the relay's password, 32+ characters of `A-Z a-z 0-9 . _ ~ -` (`openssl rand -hex 24`)     |
   | `OCI_COMPARTMENT_OCID` | optional: a compartment for it (default: the tenancy's root)                               |
   | `OCI_SSH_PUBLIC_KEY`   | optional: your SSH public key, to log in as `ubuntu@<ip>` (opens port 22; shut without it) |

3. **Run it.** Actions → **Deploy relay to Oracle Cloud** → **Run workflow** with `deploy`. It takes
   10–20 minutes and ends with the relay's address, the token masked:
   `https://<ip-with-dashes>.sslip.io/<your RELAY_TOKEN>`. Paste that URL, with your token, into the
   app's relay setting, or open `https://<ip-with-dashes>.sslip.io/` (the app served by the relay)
   and paste it there.

On your computer instead: install the [OCI CLI](https://docs.oracle.com/iaas/Content/API/SDKDocs/cliinstall.htm)
(`pipx install oci-cli`) and `jq`, export the same variables (`OCI_PRIVATE_KEY="$(cat key.pem)"`)
and run `scripts/deploy-relay-oci.sh`. `--dry-run` prints what it would do without credentials,
`--print-cloud-init` the VM's setup.

What it creates, all named `webtor-relay`: a VCN with a public subnet, internet gateway, route table
and a security list that opens `80`, `443` and `42069` (TCP and UDP), a reserved public IP, and one VM
on the newest Ubuntu LTS. At boot the VM opens the same ports in its own firewall, installs the latest
release's `webtor-relay-linux-<arch>` (checked against `SHA256SUMS`) as a systemd service on
`127.0.0.1:7881`, and Caddy gets a Let's Encrypt certificate for `<ip-with-dashes>.sslip.io` (a public
DNS name that resolves to the IP in it).

The VM's shape sets the relay's speed: Oracle caps each VM's internet bandwidth by shape
([shapes](https://docs.oracle.com/iaas/Content/Compute/References/computeshapes.htm),
[prices](https://www.oracle.com/cloud/price-list/), checked 2026-10): the script tries them in this order.

| Shape                                 | Internet bandwidth  | Cost (a month of 730 h)                                                                       |
| ------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| `VM.Standard.A1.Flex`, ARM64          | 1 Gbit/s per OCPU   | free up to 2 OCPUs and 12 GB (the default), past it about $14 per OCPU with its 6 GB          |
| `VM.Standard.E4.Flex`, AMD64, 1 OCPU  | 1 Gbit/s            | about $23, only with `allow_paid` when A1 has no capacity                                     |
| `VM.Standard.E5.Flex`, AMD64, 1 OCPU  | 1 Gbit/s            | about $28, only with `allow_paid` when E4 isn't offered or has no capacity either             |
| `VM.Standard.E2.1.Micro`, AMD64, 1 GB | 50 Mbit/s (~6 MB/s) | free; the fallback without `allow_paid`, too slow for HD video and too small to convert video |

- **A1 size:** a repository _variable_ `RELAY_OCPUS` (1–4, default 2; 6 GB of memory per OCPU). Over
  2 it is billed and needs `allow_paid`.
- **No A1 capacity** ("Out of host capacity" in every availability domain) is common on free accounts
  and rarer on Pay As You Go. Without `allow_paid` the script then takes the Micro, and when neither
  is free, run it again later. With `allow_paid` it takes the paid AMD shape instead of the Micro and
  logs its bandwidth and price before launching it.
- **Pay As You Go:** Always Free resources stay free on a Pay As You Go account, and the first 10 TB of
  outbound data a month is free. Only what goes past the allowances is billed: a paid shape, A1 past 2
  OCPUs, storage past 200 GB. The script creates nothing billed without `allow_paid`.
- **Upgrade a slow relay** (e.g. one on the Micro): Actions → **Deploy relay to Oracle Cloud** → **Run
  workflow** with `deploy` and `upgrade` checked (`allow_paid` too only if A1 has no capacity). The
  new VM starts next to the old one, takes over the reserved IP once it answers over HTTPS, and only
  then is the old VM terminated (if anything fails, the old VM keeps running). The VCN is kept. A
  plain `deploy` on a slower VM says what `upgrade` would gain and leaves it alone.
- **Stable URL:** the reserved public IP (Oracle doesn't charge for public IPs) stays with the
  relay through upgrades, so its URL stays the same. A relay created before the script reserved IPs
  has an ephemeral one, which can't be kept: its first upgrade prints the new relay URL, and the app's
  relay setting must be updated once. Without a reserved IP (the tenancy's limit is reached) every
  upgrade does that. If a new relay's first setup takes longer than the run waits, the VM keeps
  its launch address for now; run `deploy` again and it moves the reserved IP there (the run prints
  the final URL).
- **Update:** run `deploy` again. It reuses everything and reboots the VM, which installs the latest
  release. A new `RELAY_TOKEN` or SSH key applies only to a new VM: run `destroy`, then `deploy`.
- **Video conversion:** the VM installs Ubuntu's `ffmpeg` (with libx264). It is on with 2 GB of memory
  or more, with libx264's faster `superfast` preset below 4 CPUs (A1 has one CPU per OCPU, so the
  default 2 OCPUs use it; the AMD shapes have two per OCPU). On the 1 GB `E2.1.Micro` it is off: too
  little memory and CPU to convert in realtime. A VM created before video conversion existed has no
  ffmpeg: run `destroy`, then `deploy`, or `deploy` with `upgrade` from a Micro, to get it (`deploy`
  alone only updates the relay, and says so).
- **Your own domain:** add a repository _variable_ `RELAY_HOST` (e.g. `relay.example.com`) before
  the VM is created (or `destroy` first). The run prints the VM's IP: point the name's DNS A record
  at it. Caddy gets the certificate once the name resolves; run `deploy` again to wait for it. An
  upgrade that changes the address (the first one, or one without a reserved IP) checks the new VM
  on its own IP, retires the old one and prints the IP the A record must move to: the relay is back
  at the same URL once the record points there.
- **Remove:** run the workflow with `destroy`; it deletes everything it created, the reserved IP too.
- **Checks before launching:** that `OCI_REGION` is the home region (Always Free exists only there),
  that the tenancy's other instances leave room in the free allowance (A1: 2 OCPUs and 12 GB in total;
  two E2.1.Micro), and that its boot and block volumes leave room for the VM's 50 GB boot volume (200
  GB in total, both VMs' volumes counted during an upgrade). It stops with a message otherwise, unless
  `allow_paid` accepts the cost, which it logs.
- Oracle's terms apply to what you download through it, and swarm peers see the VM's IP address.

### Any server with Docker

The page is served over HTTPS, so it can only use a remote relay over HTTPS: put a TLS proxy in
front and tell the relay its public address with `-public-url`. Any VPS with Docker works, for
example Oracle Cloud's Always Free tier (an ARM64 VM; the image is built for `linux/arm64` and
`linux/amd64`). Free PaaS tiers don't fit: bandwidth caps, sleeping instances and terms of service
that forbid BitTorrent (see ADR 0006).

The image `ghcr.io/alexeychikk/webtor-relay` (tags `latest` and the version) is distroless and runs
as a non-root user. It includes a static ffmpeg with libx264, so video conversion is on (see
[ffmpeg's licence](#ffmpeg-licence)); `-no-transcode` turns it off, e.g. on a single small CPU. It listens on `0.0.0.0:7881` and keeps its token in
`/home/nonroot/webtor-relay`, so mount a volume at `/home/nonroot` to keep the relay URL across
restarts. Open the peer port in the VM's firewall (on Oracle Cloud also in the subnet's security
list): `42069/tcp` and `42069/udp`, plus `80` and `443` for Caddy.

```sh
docker network create webtor
docker run -d --name webtor-relay --restart unless-stopped --network webtor \
  -p 42069:42069 -p 42069:42069/udp -v webtor-relay:/home/nonroot \
  ghcr.io/alexeychikk/webtor-relay -public-url https://relay.example.com
docker logs webtor-relay   # prints the Open link and the Relay URL
```

Caddy gets and renews the certificate itself. Point a DNS name at the server, then:

```sh
docker run -d --name caddy --restart unless-stopped --network webtor \
  -p 80:80 -p 443:443 -v caddy-data:/data \
  caddy caddy reverse-proxy --from relay.example.com --to webtor-relay:7881
```

Paste the printed Relay URL (`https://relay.example.com/<token>`) into the app's relay setting, or
open the printed "Or open" link. Port 7881 isn't published, so the relay is reachable only through
Caddy. To build the image yourself: `docker build -f relay/Dockerfile -t webtor-relay .` from the
repository root.

The server's IP address is what swarm peers and trackers see, and its provider's terms apply to
what you download through it.

### ffmpeg licence

The container image ships ffmpeg 7.0.2 as a static build by John Van Sickle
([johnvansickle.com/ffmpeg](https://johnvansickle.com/ffmpeg/)), which includes libx264 and is
licensed under the **GNU GPL version 3**. It is a separate program that the relay starts as a child
process; webtor-relay doesn't link to it. The image holds its licence, its library versions and
where its exact source is in `/licenses/ffmpeg/` (`GPLv3.txt`, `readme.txt`, `SOURCE.txt`; read them
with `docker cp webtor-relay:/licenses/ffmpeg .`). The pinned version and checksums are in
[`scripts/relay-ffmpeg.sh`](../scripts/relay-ffmpeg.sh). The release binaries contain no ffmpeg.

## Behaviour

- At most `-max-torrents` torrents are open at once. Opening one more answers HTTP 429 with
  `{"error": "…", "maxTorrents": N}`, unless an open one has had no request for a minute: that one is
  dropped to make room.
- A metainfo request waits up to `-metadata-timeout` for the swarm, then answers 504. A `POST` of a
  .torrent file to the same URL adds the torrent from that file at once (the app does this for a
  .torrent you opened).
- A torrent with no request for `-idle-timeout` is dropped. A request in progress (a metainfo wait,
  a web seed read) always keeps its torrent.
- Downloaded data lives in `<data-dir>/pieces/<infohash>/` only while the torrent is open. It is
  deleted when the torrent is dropped, at shutdown and at startup.
- The relay uploads to peers while a torrent is open (`-no-upload` turns that off) and never seeds
  after.
- Each web seed request downloads its whole range with top priority, plus `-readahead` bytes after
  it, so WebTorrent's next piece is usually already there. A seek moves both. A read that gets no
  data for 3 s makes the relay re-request the torrent's pieces (works around an anacrolix
  stall that otherwise lasts until WebTorrent's 60 s timeout).
- The BitTorrent library logs at warning level and above. Read errors that are part of normal
  streaming (a seek aborts a web seed read, the stall workaround above) are left out, so an
  `error` line on stderr is worth a look.
- SIGINT/SIGTERM shut down gracefully: in-flight requests get 3 s, then torrents are dropped and
  their data deleted. A second Ctrl-C kills the process.
- **Video conversion** (optional, needs ffmpeg with libx264). Browsers can't decode DivX/Xvid, so
  the app asks the relay to convert the video track: `GET {relay URL}/v1/torrents/<infohash>/transcode/<file
index>?start=<seconds>` streams fragmented MP4 (H.264 High, CRF 23, keyframe every 2 s, no audio:
  the browser handles audio and subtitles itself) starting at `start`. The relay looks for ffmpeg at
  `-ffmpeg`, then on `PATH`, then next to its own binary, and prints `Video conversion: on (…)` or
  `off` at startup (installing it: [Run on your computer](#run-on-your-computer); the container image
  and the Oracle Cloud VM come with it). Video taller than `-transcode-max-height` is scaled
  down (never up). At most `-max-transcodes` conversions run at once: a request for the same file
  (a seek) replaces its conversion, one for another file gets 429 `{"error": "transcode-busy",
"maxTranscodes": N}`. Without ffmpeg it answers 503 `transcode-unavailable`, and 422
  `transcode-failed` (with ffmpeg's last error lines in `detail`) when ffmpeg can't read the file.
  ffmpeg converts only as fast as the browser reads, stops when the request ends, and is killed when
  its output hasn't moved for 10 minutes (a paused tab). `/v1/info` reports it as
  `transcode: {available, ffmpeg, maxHeight, preset, maxTranscodes}`. On 4 ARM cores `veryfast` at
  720p converts 2–3× faster than realtime; on a slower machine lower `-transcode-max-height` or pick
  a faster preset.
- Multi-file torrents work, but WebTorrent puts file names into web seed URLs without
  percent-encoding them. A `?` is recovered from the query string. A `#` truncates the URL, so the
  relay picks the only file that continues the truncated path with `#` and is long enough for the
  requested range. Files whose paths differ only after a `#` can be ambiguous (404). Percent-encoded
  paths always work.

## Flags

Every flag can also be set by its environment variable (handy in Docker).

| Flag                    | Env                                 | Default                                                               |
| ----------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `-listen`               | `WEBTOR_RELAY_LISTEN`               | `127.0.0.1:7881` (image: `0.0.0.0:7881`)                              |
| `-public-url`           | `WEBTOR_RELAY_PUBLIC_URL`           | `http://<listen>`                                                     |
| `-token`                | `WEBTOR_RELAY_TOKEN`                | generated, saved in data dir                                          |
| `-data-dir`             | `WEBTOR_RELAY_DATA_DIR`             | `<user cache dir>/webtor-relay` (image: `/home/nonroot/webtor-relay`) |
| `-peer-port`            | `WEBTOR_RELAY_PEER_PORT`            | `42069` (`0` = random)                                                |
| `-max-torrents`         | `WEBTOR_RELAY_MAX_TORRENTS`         | `3`                                                                   |
| `-metadata-timeout`     | `WEBTOR_RELAY_METADATA_TIMEOUT`     | `90s`                                                                 |
| `-idle-timeout`         | `WEBTOR_RELAY_IDLE_TIMEOUT`         | `10m`                                                                 |
| `-readahead`            | `WEBTOR_RELAY_READAHEAD`            | `33554432` (32 MiB)                                                   |
| `-no-upload`            | `WEBTOR_RELAY_NO_UPLOAD`            | off                                                                   |
| `-no-default-trackers`  | `WEBTOR_RELAY_NO_DEFAULT_TRACKERS`  | off                                                                   |
| `-no-dht`               | `WEBTOR_RELAY_NO_DHT`               | off                                                                   |
| `-ffmpeg`               | `WEBTOR_RELAY_FFMPEG`               | `ffmpeg` on `PATH`, then next to the relay binary                     |
| `-no-transcode`         | `WEBTOR_RELAY_NO_TRANSCODE`         | off (video conversion on when ffmpeg is found)                        |
| `-max-transcodes`       | `WEBTOR_RELAY_MAX_TRANSCODES`       | `1`                                                                   |
| `-transcode-preset`     | `WEBTOR_RELAY_TRANSCODE_PRESET`     | `veryfast` (libx264: `ultrafast` … `veryslow`)                        |
| `-transcode-max-height` | `WEBTOR_RELAY_TRANSCODE_MAX_HEIGHT` | `720`                                                                 |
| `-debug`                | `WEBTOR_RELAY_DEBUG`                | off (logs every API request)                                          |
| `-version`              |                                     | print the version and exit                                            |

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
`pnpm build` → `dist/`) into `internal/webapp/dist/` before `go build`: run
`scripts/release-relay.sh <version> build` (from the repository root) for release binaries in
`relay/dist/`. Releasing is described in the root `CLAUDE.md`.
