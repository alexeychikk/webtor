# relay/ — webtor-relay (Go)

Go module `github.com/alexeychikk/webtor/relay`; Go version comes from the root `mise.toml`. API
contract and rationale: `docs/decisions/0006-regular-peers-relay.md`. The TS side of the URL
contract is `src/lib/torrent/relay.ts`: change both together. Flags and behaviour: `README.md`
(keep its flag table in sync with `cmd/webtor-relay/main.go`).

- Checks: `gofmt -l .` (must print nothing), `go vet ./...`, `go test ./...`. Builds must stay
  `CGO_ENABLED=0` (static binaries for every OS).
- `internal/relay`: HTTP handlers over one `*torrent.Client`. The handler checks the first path
  segment against the token (constant time) and strips it, so API routes are `/v1/...` and request
  logging never sees the token. Everything else goes to `Options.App` (`internal/webapp`).
  CORS is `*` on the API only, because the token is the access control. Keep handlers thin and
  put decisions (path mapping, ranges, links) in pure functions with table tests.
- Every request takes a torrent with `acquire`/`existing` (counts it as active) and gives it back
  with `release`. Torrents with an active request are never dropped; the janitor drops idle ones.
- Storage: `relay.NewStorage` (per-infohash dir, hashed file names, in-memory piece completion), so
  deleting `TorrentDir` after a drop is always safe.
- Don't `slog.SetDefault` to a debug logger: anacrolix storage logs to the default logger, and its
  debug output (lines per piece read/write) slows streaming down several times.
- `watchStall` (per web seed request) re-requests pieces through `nudge` when neither the request
  nor the torrent got data for `stallCheck` (3 s). It toggles download off and on, the only public
  call that cancels the stuck requests (toggling upload or closing connections doesn't help);
  `progressReader` retries the "downloading disabled" read error that this causes meanwhile.
- The web seed path follows WebTorrent's `lib/webconn.js`: the bare URL for single-file torrents,
  `URL + "<name>/<path>"` (not percent-encoded) for multi-file ones. See `ResolveWebseedPath`.
- Tests that need a swarm use `internal/seedtest` (TCP-only loopback seeder, file or directory)
  with the magnet's `x.pe=`. Never depend on the public internet in tests; the platform sandbox only
  allows outbound TCP 80/443 (`scripts/measure.sh` is for real networks).
- Video conversion (`transcode.go`, ADR 0007 §2–3): one ffmpeg per job, reading the torrent file
  from a per-job loopback listener (`127.0.0.1:0`, random path), so the token never reaches argv.
  The job's lifetime is its request's: `CommandContext` on the request context (process group on
  Unix, `proc_unix.go`), the handler holds `existing`/`release`, `Server.jobs` keys jobs by
  torrent + file (same key replaces, others over `MaxJobs` get 429). A job ended by anything but a
  clean ffmpeg exit aborts the response (`http.ErrAbortHandler`), so the app never mistakes it for
  the end of the video. `watchJobIdle` kills a job without output for `IdleTimeout` and unblocks a
  Write stuck on a client that stopped reading. ffmpeg tests need `WEBTOR_RELAY_FFMPEG` or ffmpeg on
  `PATH` (skipped otherwise); a static build (e.g. johnvansickle.com) works in the sandbox.
  `testExtraInputArgs` (`-readrate 1`) keeps a 12 s fixture's job alive through a test.
- The library's logger goes through `QuietReadErrors`: it drops the Error-level read failures that
  normal streaming causes (cancelled web seed reads, the nudge). Extend it rather than raising the
  level when the library gets noisier.
- Release: `scripts/release-relay.sh` (root `CLAUDE.md`). Container defaults come from `-ldflags`
  (`main.defaultListen`, `main.defaultDataDir`) in both `.ko.yaml` and `Dockerfile`.
- `scripts/bench-webtorrent.mjs` measures loopback throughput through WebTorrent in Chromium (see
  the root Playwright setup).
- No GitHub Actions (root `CLAUDE.md`).
