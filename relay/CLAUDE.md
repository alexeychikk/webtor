# relay/ — webtor-relay (Go)

Go module `github.com/alexeychikk/webtor/relay`; Go version comes from the root `mise.toml`. API
contract and rationale: `docs/decisions/0006-regular-peers-relay.md`. The TS side of the URL
contract is `src/lib/torrent/relay.ts`: change both together.

- Checks: `gofmt -l .` (must print nothing), `go vet ./...`, `go test ./...`. Builds must stay
  `CGO_ENABLED=0` (static binaries for every OS).
- `internal/relay`: HTTP handlers over one `*torrent.Client`. Every URL starts with `/<token>/v1/`.
  CORS is `*`, because the token is the access control. Keep handlers thin and put decisions
  (path mapping, limits) in pure functions with table tests (`paths.go`).
- The web seed path follows WebTorrent's `lib/webconn.js`: the bare URL for single-file torrents,
  `URL + "<name>/<path>"` (not percent-encoded) for multi-file ones.
- Tests that need a swarm use `internal/seedtest` (TCP-only loopback seeder) with the magnet's
  `x.pe=`. Never depend on the public internet in tests; the platform sandbox only allows outbound
  TCP 80/443 (`scripts/measure.sh` is for real networks).
- No GitHub Actions (root `CLAUDE.md`).
