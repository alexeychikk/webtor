#!/usr/bin/env bash
# Releases webtor-relay by hand (no GitHub Actions, ADR 0005): builds the web app into the relay,
# cross-compiles static binaries, publishes them as GitHub release relay-v<version> and pushes the
# container image with ko (no Docker daemon needed).
#
# Usage: scripts/release-relay.sh <version> [all|binaries|image|build] [--dry-run]
#   all       (default) binaries, then image
#   binaries  build + `gh release create relay-v<version>` (marked latest)
#   image     push the base image $BASE_REPO:<ffmpeg version> (distroless + the static ffmpeg of
#             scripts/relay-ffmpeg.sh per platform, joined in one index, built with crane), then
#             ko build --push on it to $IMAGE_REPO, tags <version> and latest. Needs `ko login
#             ghcr.io` (or `docker login`/`crane auth login`) with a token that can write packages.
#   build     build the binaries into relay/dist/ only; publishes nothing
#   --dry-run (image only) the same, pushed to a throwaway registry on 127.0.0.1 instead
#             (`crane registry serve`); needs no login and no clean tree
# Run it from a clean `main` that is pushed (see CLAUDE.md). Needs pnpm, Go (mise.toml), gh and,
# for the image, ko and crane (`go install github.com/google/ko@latest
# github.com/google/go-containerregistry/cmd/crane@latest`) and GNU tar. On Linux, the binary and
# the image for this machine are smoke-tested: -version, /v1/info, the app's files; the image's
# relay must also report video conversion on (`transcode.available`) with its own ffmpeg.
set -euo pipefail
cd "$(dirname "$0")/.."

dry_run=false
args=()
for arg in "$@"; do
  if [[ $arg == --dry-run ]]; then dry_run=true; else args+=("$arg"); fi
done
version=${args[0]:-}
what=${args[1]:-all}
REMOTE=${REMOTE:-origin}
IMAGE_REPO=${IMAGE_REPO:-ghcr.io/alexeychikk/webtor-relay}
BASE_REPO=${BASE_REPO:-ghcr.io/alexeychikk/webtor-relay-base}
DISTROLESS=gcr.io/distroless/static-debian12:nonroot
TARGETS=(linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64)

die() {
  echo "release-relay: $*" >&2
  exit 1
}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] ||
  die "usage: scripts/release-relay.sh <version like 0.1.0> [all|binaries|image|build]"
[[ $what =~ ^(all|binaries|image|build)$ ]] || die "unknown step '$what' (all|binaries|image|build)"
! $dry_run || [[ $what == image ]] || die "--dry-run works with the image step only"
tag=relay-v$version
prerelease=false
[[ $version == *-* ]] && prerelease=true

if [[ $what != build ]] && ! $dry_run; then
  [[ -z $(git status --porcelain) ]] || die "working tree is dirty; commit or stash first"
  git fetch --quiet "$REMOTE"
  git branch -r --contains HEAD | grep -q " $REMOTE/" ||
    die "HEAD is not on $REMOTE; push it first (the release tag points at it)"
  branch=$(git rev-parse --abbrev-ref HEAD)
  [[ $branch == main ]] || echo "release-relay: warning: releasing from '$branch', not main" >&2
fi
if [[ $what == all || $what == image ]]; then
  for tool in ko crane; do
    command -v "$tool" >/dev/null || die "$tool not found (see the header of this script)"
  done
  ffmpeg_version=$(scripts/relay-ffmpeg.sh --version)
  grep -qx "defaultBaseImage: ghcr.io/alexeychikk/webtor-relay-base:$ffmpeg_version" relay/.ko.yaml ||
    die "relay/.ko.yaml's defaultBaseImage must be ghcr.io/alexeychikk/webtor-relay-base:$ffmpeg_version"
fi
if [[ $what == all || $what == binaries ]] && gh release view "$tag" >/dev/null 2>&1; then
  die "release $tag already exists (delete it with: gh release delete $tag --cleanup-tag)"
fi

# The web app the relay serves at "/" (go:embed of relay/internal/webapp/dist). Only the placeholder
# index.html is committed; put it back on exit.
webapp=relay/internal/webapp/dist
work=$(mktemp -d)
registry_pid=
cleanup() {
  [[ -z $registry_pid ]] || kill "$registry_pid" 2>/dev/null || true
  chmod -R u+w "$work" 2>/dev/null || true # the exported image has read-only directories
  rm -rf "$work"
  find "$webapp" -mindepth 1 -delete
  git checkout --quiet -- "$webapp"
}
trap cleanup EXIT
pnpm install --frozen-lockfile
pnpm build
find "$webapp" -mindepth 1 -delete
cp -R dist/. "$webapp/"
find "$webapp" -name '*.map' -delete # source maps only bloat the binary

ldflags="-s -w -X github.com/alexeychikk/webtor/relay/internal/relay.Version=$version"

# smoke <binary> <PATH for it> <yes|any: video conversion must be on>: -version, /v1/info and every
# file of the app.
smoke() {
  local bin=$1 path=$2 transcode=$3 got data port base info missing pid
  got=$(PATH=$path "$bin" -version)
  [[ $got == "webtor-relay $version" ]] || die "$bin -version printed '$got'"
  data=$(mktemp -d "$work/smoke.XXXXXX")
  port=${SMOKE_PORT:-17881}
  PATH=$path "$bin" -listen "127.0.0.1:$port" -data-dir "$data" -token smoketoken -peer-port 0 \
    -no-dht -no-default-trackers >"$data.log" 2>&1 &
  pid=$!
  base=http://127.0.0.1:$port
  for _ in $(seq 50); do
    if curl -fs "$base/smoketoken/v1/info" >/dev/null; then break; fi
    sleep 0.2
  done
  info=$(curl -fs "$base/smoketoken/v1/info" || true)
  missing=$(cd "$webapp" && find . -type f | while read -r f; do
    curl -fs -o /dev/null "$base/${f#./}" || echo "${f#./}"
  done)
  kill "$pid" && wait "$pid" 2>/dev/null || true
  [[ $info == *"\"version\":\"$version\""* ]] || die "/v1/info of $bin answered '$info' ($(cat "$data.log"))"
  [[ -z $missing ]] || die "$bin doesn't serve these app files: $missing"
  got+=", $(grep -o '"api":[0-9]*' <<<"$info" || echo 'no "api"')"
  if [[ $info == *'"transcode":{"available":true'* ]]; then
    got+=", video conversion on"
  elif [[ $transcode == yes ]]; then
    die "$bin reports video conversion off: $info ($(grep -i conversion "$data.log"))"
  else
    got+=", video conversion off (no ffmpeg here)"
  fi
  echo "release-relay: smoke test passed: $got, /v1/info, app files"
}

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

  host=relay/dist/webtor-relay-$(go env GOOS)-$(go env GOARCH)
  [[ ! -x $host ]] || smoke "$host" "$PATH" any
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
  if $dry_run; then
    registry=127.0.0.1:${REGISTRY_PORT:-17882}
    crane registry serve --address "$registry" >"$work/registry.log" 2>&1 &
    registry_pid=$!
    for _ in $(seq 50); do
      if curl -fs "http://$registry/v2/" >/dev/null; then break; fi
      sleep 0.2
    done
    curl -fs "http://$registry/v2/" >/dev/null || die "crane registry serve didn't start: $(cat "$work/registry.log")"
    BASE_REPO=$registry/webtor-relay-base
    IMAGE_REPO=$registry/webtor-relay
    echo "release-relay: dry run: pushing to the throwaway registry $registry"
  fi

  # The base: distroless + one ffmpeg layer per platform (ko can't add per-platform files), rebuilt
  # on every release so that distroless updates come along.
  base_tag=$BASE_REPO:$ffmpeg_version
  manifests=()
  for arch in amd64 arm64; do
    scripts/relay-ffmpeg.sh "$arch" "$work/ffmpeg-$arch"
    tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 --mode=u+w,go-w \
      -C "$work/ffmpeg-$arch" -czf "$work/ffmpeg-$arch.tar.gz" usr licenses
    crane --platform "linux/$arch" append --set-base-image-annotations -b "$DISTROLESS" \
      -f "$work/ffmpeg-$arch.tar.gz" -t "$base_tag-linux-$arch"
    manifests+=(-m "$base_tag-linux-$arch")
  done
  crane index append "${manifests[@]}" -t "$base_tag"
  base_ref=$BASE_REPO@$(crane digest "$base_tag")
  echo "release-relay: base image $base_tag ($base_ref)"

  tags=$version
  $prerelease || tags+=,latest
  (cd relay && RELAY_VERSION=$version KO_DOCKER_REPO=$IMAGE_REPO KO_DEFAULTBASEIMAGE=$base_ref \
    ko build --bare --tags "$tags" --image-label "org.opencontainers.image.source=https://github.com/alexeychikk/webtor" \
    --image-label "org.opencontainers.image.version=$version" ./cmd/webtor-relay)

  # Smoke test of the image for this machine: its files, its PATH, its ffmpeg (no container runtime
  # needed; the relay and ffmpeg are static).
  goarch=$(go env GOARCH)
  if [[ $(uname -s) == Linux && $goarch =~ ^(amd64|arm64)$ ]]; then
    rootfs=$work/rootfs
    mkdir -p "$rootfs"
    crane --platform "linux/$goarch" export "$IMAGE_REPO:$version" - |
      tar -x --delay-directory-restore -C "$rootfs"
    config=$(crane --platform "linux/$goarch" config "$IMAGE_REPO:$version")
    entrypoint=$(sed -n 's/.*"Entrypoint":\["\([^"]*\)".*/\1/p' <<<"$config")
    image_path=$(sed -n 's/.*"PATH=\([^"]*\)".*/\1/p' <<<"$config")
    [[ -n $entrypoint && -n $image_path ]] || die "no Entrypoint or PATH in the image config: $config"
    [[ -f $rootfs/licenses/ffmpeg/SOURCE.txt && -f $rootfs/licenses/ffmpeg/GPLv3.txt ]] ||
      die "the image has no /licenses/ffmpeg/"
    # The image's PATH, every entry inside the exported file system.
    smoke "$rootfs$entrypoint" "$rootfs${image_path//:/:$rootfs}" yes
  fi
fi
