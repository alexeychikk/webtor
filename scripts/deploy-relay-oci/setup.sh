#!/bin/bash
# webtor-relay-setup: runs as root on every boot of the Oracle Cloud VM (webtor-relay-setup.service),
# before webtor-relay and Caddy. scripts/deploy-relay-oci.sh embeds it in the instance's cloud-init.
# Idempotent: opens the firewall ports, works out the host name, writes the Caddyfile and the relay's
# public URL, and installs the latest webtor-relay release (checked against SHA256SUMS).
# Reads /etc/webtor-relay/deploy.conf: RELAY_REPO (owner/name), RELAY_HOST (empty = <ip>.sslip.io).
set -euo pipefail

CONF_DIR=/etc/webtor-relay
BIN=/usr/local/bin/webtor-relay
RELAY_USER=webtor-relay
RELAY_REPO=alexeychikk/webtor
RELAY_HOST=
# shellcheck source=/dev/null
. "$CONF_DIR/deploy.conf"

log() { printf 'webtor-relay-setup: %s\n' "$*"; }

# Oracle's Ubuntu images REJECT everything but SSH in iptables, independent of the security list.
open_ports() {
  local spec proto port
  for spec in tcp:80 tcp:443 tcp:42069 udp:42069; do
    proto=${spec%%:*} port=${spec##*:}
    if ! iptables -C INPUT -p "$proto" --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null; then
      iptables -I INPUT 1 -p "$proto" --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
      log "opened $port/$proto"
    fi
  done
  if command -v netfilter-persistent >/dev/null; then
    netfilter-persistent save >/dev/null 2>&1 || log "warning: netfilter-persistent save failed"
  fi
}

# The VM only knows its private address; the public one is NATed by Oracle's internet gateway.
public_ip() {
  local try url ip
  for try in 1 2 3 4 5 6; do
    for url in https://checkip.amazonaws.com https://api.ipify.org https://ifconfig.me/ip; do
      ip=$(curl -fsS --max-time 10 "$url" 2>/dev/null | tr -d '[:space:]') || continue
      if [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
        printf '%s\n' "$ip"
        return 0
      fi
    done
    sleep $((try * 5))
  done
  return 1
}

ensure_user() {
  if ! id "$RELAY_USER" >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/webtor-relay --no-create-home --shell /usr/sbin/nologin "$RELAY_USER"
  fi
}

write_proxy_config() {
  local host=$1 caddyfile=/etc/caddy/Caddyfile tmp
  # Not quoted: systemd EnvironmentFile syntax, the value has no spaces.
  printf 'WEBTOR_RELAY_PUBLIC_URL=https://%s\n' "$host" >"$CONF_DIR/public.env.new"
  mv "$CONF_DIR/public.env.new" "$CONF_DIR/public.env"

  mkdir -p /etc/caddy
  tmp=$(mktemp /etc/caddy/Caddyfile.XXXXXX)
  cat >"$tmp" <<CADDY
# Written by webtor-relay-setup on every boot; edit /etc/webtor-relay/deploy.conf instead.
$host {
	reverse_proxy 127.0.0.1:7881 {
		# Stream web seed responses as they come.
		flush_interval -1
	}
}
CADDY
  chmod 0644 "$tmp"
  if cmp -s "$tmp" "$caddyfile"; then
    rm -f "$tmp"
  else
    mv "$tmp" "$caddyfile"
    log "Caddyfile now serves $host"
    # --no-block: this unit is ordered before caddy.service, waiting here would deadlock at boot.
    systemctl --no-block try-reload-or-restart caddy.service || true
  fi
}

install_latest() {
  local arch asset base tmp want have
  arch=$(dpkg --print-architecture) # arm64 (VM.Standard.A1.Flex) or amd64 (VM.Standard.E2.1.Micro)
  asset=webtor-relay-linux-$arch
  base=https://github.com/$RELAY_REPO/releases/latest/download
  tmp=$WORK
  if ! curl -fsSL --retry 5 --retry-all-errors --max-time 60 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"; then
    if [[ -x $BIN ]]; then
      log "warning: can't reach $base, keeping the installed $("$BIN" -version)"
      return 0
    fi
    log "error: can't download $base/SHA256SUMS"
    return 1
  fi
  want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
  if [[ ! $want =~ ^[0-9a-f]{64}$ ]]; then
    log "error: no checksum for $asset in the latest release's SHA256SUMS"
    return 1
  fi
  have=$(sha256sum "$BIN" 2>/dev/null | cut -d' ' -f1 || true)
  if [[ $want == "$have" ]]; then
    log "up to date: $("$BIN" -version)"
    return 0
  fi
  curl -fsSL --retry 5 --retry-all-errors --max-time 300 -o "$tmp/$asset" "$base/$asset"
  (cd "$tmp" && printf '%s  %s\n' "$want" "$asset" | sha256sum --check --quiet --strict -)
  install -m 0755 "$tmp/$asset" "$BIN"
  log "installed $("$BIN" -version)"
  # No-op at boot (the relay starts after this unit); restarts a running relay on a manual run.
  systemctl --no-block try-restart webtor-relay.service || true
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
open_ports
ensure_user
host=$RELAY_HOST
if [[ -z $host ]]; then
  ip=$(public_ip) || {
    log "error: can't find this VM's public IP address"
    exit 1
  }
  host=${ip//./-}.sslip.io
fi
write_proxy_config "$host"
install_latest
log "relay host: $host"
