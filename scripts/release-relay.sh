#!/usr/bin/env bash
# Releases webtor-relay by hand (no GitHub Actions, ADR 0005): builds the web app into the relay,
# cross-compiles static binaries, publishes them as GitHub release relay-v<version> and pushes the
# container image with ko (no Docker daemon needed).
#
# Usage: scripts/release-relay.sh <version> [all|binaries|image|build]
#   all       (default) binaries, then image
#   binaries  build + `gh release create relay-v<version>` (marked latest)
#   image     ko build --push to $IMAGE_REPO, tags <version> and latest (needs `ko login ghcr.io`
#             or `docker login ghcr.io` with a token that can write packages)
#   build     build the binaries into relay/dist/ only; publishes nothing
# Run it from a clean `main` that is pushed (see CLAUDE.md). Needs pnpm, Go (mise.toml), gh and,
# for the image, ko (`go install github.com/google/ko@latest`).
set -euo pipefail
cd "$(dirname "$0")/.."

version=${1:-}
what=${2:-all}
REMOTE=${REMOTE:-origin}
IMAGE_REPO=${IMAGE_REPO:-ghcr.io/alexeychikk/webtor-relay}
TARGETS=(linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64)

die() {
  echo "release-relay: $*" >&2
  exit 1
}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] ||
  die "usage: scripts/release-relay.sh <version like 0.1.0> [all|binaries|image|build]"
[[ $what =~ ^(all|binaries|image|build)$ ]] || die "unknown step '$what' (all|binaries|image|build)"
tag=relay-v$version
prerelease=false
[[ $version == *-* ]] && prerelease=true

if [[ $what != build ]]; then
  [[ -z $(git status --porcelain) ]] || die "working tree is dirty; commit or stash first"
  git fetch --quiet "$REMOTE"
  [[ -n $(git branch -r --contains HEAD | grep " $REMOTE/") ]] ||
    die "HEAD is not on $REMOTE; push it first (the release tag points at it)"
  branch=$(git rev-parse --abbrev-ref HEAD)
  [[ $branch == main ]] || echo "release-relay: warning: releasing from '$branch', not main" >&2
fi
if [[ $what == all || $what == binaries ]] && gh release view "$tag" >/dev/null 2>&1; then
  die "release $tag already exists (delete it with: gh release delete $tag --cleanup-tag)"
fi

# The web app the relay serves at "/" (go:embed of relay/internal/webapp/dist). Only the placeholder
# index.html is committed; put it back on exit.
webapp=relay/internal/webapp/dist
restore_webapp() {
  find "$webapp" -mindepth 1 -delete
  git checkout --quiet -- "$webapp"
}
trap restore_webapp EXIT
pnpm install --frozen-lockfile
pnpm build
find "$webapp" -mindepth 1 -delete
cp -R dist/. "$webapp/"
find "$webapp" -name '*.map' -delete # source maps only bloat the binary

ldflags="-s -w -X github.com/alexeychikk/webtor/relay/internal/relay.Version=$version"

if [[ $what != image ]]; then
  out=relay/dist
  rm -rf "$out"
  mkdir -p "$out"
  for target in "${TARGETS[@]}"; do
    goos=${target%/*} goarch=${target#*/}
    name=webtor-relay-$goos-$goarch
    [[ $goos == windows ]] && name+=.exe
    echo "release-relay: building $name"
    (cd relay && CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch \
      go build -trimpath -ldflags "$ldflags" -o "dist/$name" ./cmd/webtor-relay)
  done
  (cd "$out" && sha256sum webtor-relay-* >SHA256SUMS)

  # Smoke test with the binary for this machine: -version, /v1/info, and every file of the app.
  host=relay/dist/webtor-relay-$(go env GOOS)-$(go env GOARCH)
  if [[ -x $host ]]; then
    got=$("$host" -version)
    [[ $got == "webtor-relay $version" ]] || die "$host -version printed '$got'"
    smoke=$(mktemp -d)
    port=${SMOKE_PORT:-17881}
    "$host" -listen "127.0.0.1:$port" -data-dir "$smoke" -token smoketoken -peer-port 0 -no-dht \
      -no-default-trackers >/dev/null 2>&1 &
    pid=$!
    base=http://127.0.0.1:$port
    for _ in $(seq 50); do curl -fs "$base/smoketoken/v1/info" >/dev/null && break || sleep 0.2; done
    info=$(curl -fs "$base/smoketoken/v1/info" || true)
    missing=$(cd "$webapp" && find . -type f | while read -r f; do
      curl -fs -o /dev/null "$base/${f#./}" || echo "${f#./}"
    done)
    kill "$pid" && wait "$pid" 2>/dev/null || true
    rm -rf "$smoke"
    [[ $info == *"\"version\":\"$version\""* ]] || die "/v1/info answered '$info'"
    [[ -z $missing ]] || die "the relay doesn't serve these app files: $missing"
    echo "release-relay: smoke test passed ($got, /v1/info, app files)"
  fi
fi

if [[ $what == all || $what == binaries ]]; then
  notes=$(
    cat <<EOF
Download the binary for your system, run it, and open the **Open** link it prints. Setup, macOS
and Windows warnings, flags and running it on a server:
[relay/README.md](https://github.com/alexeychikk/webtor/blob/$tag/relay/README.md).

| System | File |
| --- | --- |
| Windows | \`webtor-relay-windows-amd64.exe\` |
| macOS, Apple silicon | \`webtor-relay-darwin-arm64\` |
| macOS, Intel | \`webtor-relay-darwin-amd64\` |
| Linux x86-64 | \`webtor-relay-linux-amd64\` |
| Linux ARM64 | \`webtor-relay-linux-arm64\` |

Container image: \`$IMAGE_REPO:$version\` (linux/amd64, linux/arm64). Checksums: \`SHA256SUMS\`.
EOF
  )
  flags=(--latest)
  $prerelease && flags=(--prerelease --latest=false)
  gh release create "$tag" relay/dist/webtor-relay-* relay/dist/SHA256SUMS \
    --target "$(git rev-parse HEAD)" --title "webtor-relay $version" --notes "$notes" "${flags[@]}"
fi

if [[ $what == all || $what == image ]]; then
  command -v ko >/dev/null || die "ko not found (go install github.com/google/ko@latest)"
  tags=$version
  $prerelease || tags+=,latest
  (cd relay && RELAY_VERSION=$version KO_DOCKER_REPO=$IMAGE_REPO \
    ko build --bare --tags "$tags" --image-label "org.opencontainers.image.source=https://github.com/alexeychikk/webtor" \
    --image-label "org.opencontainers.image.version=$version" ./cmd/webtor-relay)
fi
