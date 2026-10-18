#!/usr/bin/env bash
# Measures the relay route against a real swarm: metadata time, cold range latency, throughput.
#   relay/scripts/measure.sh [magnet]      (default: Ubuntu 26.04 desktop ISO; needs go, curl, jq)
# Run it on a normal network: the platform sandbox only allows outbound TCP 80/443.
set -euo pipefail
cd "$(dirname "$0")/.."
MAGNET=${1:-'magnet:?xt=urn:btih:dafc8c076ca2f3ed376eeae7c76a0d6be2415c45&dn=ubuntu-26.04-desktop-amd64.iso&tr=https%3A%2F%2Ftorrent.ubuntu.com%2Fannounce'}
PORT=${PORT:-7899}
TOKEN=measure-$RANDOM$RANDOM
DATA=$(mktemp -d)
go build -o "$DATA/webtor-relay" ./cmd/webtor-relay
"$DATA/webtor-relay" -listen 127.0.0.1:$PORT -token "$TOKEN" -data-dir "$DATA" -peer-port 0 >"$DATA/relay.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "$DATA"' EXIT
for _ in $(seq 50); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/$TOKEN/v1/info" && break; sleep 0.2; done

IH=$(sed -E 's/.*xt=urn:btih:([0-9a-fA-F]{40}).*/\1/' <<<"$MAGNET" | tr A-F a-f)
BASE=http://127.0.0.1:$PORT/$TOKEN/v1/torrents/$IH
QUERY=${MAGNET#magnet:?}
echo "info hash $IH"
curl -sf -o /dev/null -w 'metadata:   %{time_total} s\n' "$BASE/metainfo?$QUERY" ||
  { echo "no metadata within 90 s; swarm stats:"; curl -s "$BASE/stats"; echo; cat "$DATA/relay.log"; exit 1; }
FILE=$(curl -sf "$BASE/files" | jq -c 'max_by(.length)')
echo "file:       $(jq -r .path <<<"$FILE") ($(jq -r .length <<<"$FILE") bytes)"
URL="$BASE/webseed/$(jq -r '.webseedPath | @uri' <<<"$FILE" | sed 's/%2F/\//g')"
LEN=$(jq -r .length <<<"$FILE")
MID=$((LEN / 2))
curl -sf -o /dev/null -r "$MID-$((MID + 1048575))" -w 'seek 1 MiB:  first byte %{time_starttransfer} s, done %{time_total} s\n' "$URL"
curl -sf -o /dev/null -r "0-$((64 << 20))" -w 'first 64 MiB: %{time_total} s, %{speed_download} B/s\n' "$URL"
curl -sf "$BASE/stats" | jq -c .
