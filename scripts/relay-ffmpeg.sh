#!/usr/bin/env bash
# The static ffmpeg (with libx264) that webtor-relay's container images ship (ADR 0007 §3). One pin
# for relay/Dockerfile and the ko base image built by scripts/release-relay.sh.
#
# Usage: scripts/relay-ffmpeg.sh <amd64|arm64> <root>   lays out into <root>:
#          usr/local/bin/ffmpeg            on distroless's PATH, where the relay looks first
#          licenses/ffmpeg/GPLv3.txt       the build's licence (ffmpeg with libx264 is GPL)
#          licenses/ffmpeg/readme.txt      the build's own readme: every library and its version
#          licenses/ffmpeg/SOURCE.txt      where the binary and its exact source come from
#        scripts/relay-ffmpeg.sh --version prints the pinned ffmpeg version
# Downloads go to $FFMPEG_CACHE (default: a temporary directory) and are checked against the pins.
# Bumping the version: new URLs and checksums below, the base image tag in relay/.ko.yaml, and
# `scripts/release-relay.sh <version> image --dry-run` to test it.
set -euo pipefail

FFMPEG_VERSION=7.0.2
# John Van Sickle's static builds (https://johnvansickle.com/ffmpeg/, GPLv3). The current release
# lives under releases/ffmpeg-release-*; once superseded it moves to old-releases/ with its version.
sha256_of() {
  case $1 in
  amd64) echo abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67 ;;
  arm64) echo f4149bb2b0784e30e99bdda85471c9b5930d3402014e934a5098b41d0f7201b1 ;;
  esac
}

die() {
  echo "relay-ffmpeg: $*" >&2
  exit 1
}

if [[ ${1:-} == --version ]]; then
  echo "$FFMPEG_VERSION"
  exit 0
fi
arch=${1:-}
root=${2:-}
[[ $arch =~ ^(amd64|arm64)$ && -n $root ]] || die "usage: scripts/relay-ffmpeg.sh <amd64|arm64> <root> | --version"
want=$(sha256_of "$arch")
name=ffmpeg-$FFMPEG_VERSION-$arch-static
urls=(
  "https://johnvansickle.com/ffmpeg/old-releases/$name.tar.xz"
  "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-$arch-static.tar.xz"
)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cache=${FFMPEG_CACHE:-$tmp}
mkdir -p "$cache"
tarball=$cache/$name.tar.xz

sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

if [[ ! -f $tarball ]] || [[ $(sha256 "$tarball") != "$want" ]]; then
  ok=0
  for url in "${urls[@]}"; do
    echo "relay-ffmpeg: downloading $url" >&2
    if curl -fsSL --retry 3 -o "$tmp/download.tar.xz" "$url"; then
      if [[ $(sha256 "$tmp/download.tar.xz") == "$want" ]]; then
        mv "$tmp/download.tar.xz" "$tarball"
        ok=1
        break
      fi
      # The releases/ URL serves whatever is current: a newer build fails here, try the next URL.
      echo "relay-ffmpeg: $url is not ffmpeg $FFMPEG_VERSION ($arch): checksum differs" >&2
    fi
  done
  ((ok)) || die "no download of $name.tar.xz matched sha256 $want"
fi

tar -xJf "$tarball" -C "$tmp" "$name/ffmpeg" "$name/GPLv3.txt" "$name/readme.txt"
mkdir -p "$root/usr/local/bin" "$root/licenses/ffmpeg"
install -m 0755 "$tmp/$name/ffmpeg" "$root/usr/local/bin/ffmpeg"
install -m 0644 "$tmp/$name/GPLv3.txt" "$tmp/$name/readme.txt" "$root/licenses/ffmpeg/"
cat >"$root/licenses/ffmpeg/SOURCE.txt" <<EOF
/usr/local/bin/ffmpeg is FFmpeg $FFMPEG_VERSION, a static build by John Van Sickle with libx264 and
the other libraries listed in readme.txt. It is licensed under the GNU General Public License
version 3 (GPLv3.txt). It is a separate program: webtor-relay runs it as a child process and does
not link to it.

Binary:     $name.tar.xz (sha256 $want)
            https://johnvansickle.com/ffmpeg/ (current release) or
            https://johnvansickle.com/ffmpeg/old-releases/$name.tar.xz
FFmpeg:     https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz
            https://git.ffmpeg.org/gitweb/ffmpeg.git/tag/refs/tags/n$FFMPEG_VERSION
Libraries:  versions in readme.txt; build configuration: ffmpeg -version
EOF
echo "relay-ffmpeg: ffmpeg $FFMPEG_VERSION ($arch) in $root" >&2
