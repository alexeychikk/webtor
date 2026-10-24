#!/usr/bin/env bash
# Deploys webtor-relay to an Oracle Cloud (OCI) VM, or removes it again, through the OCI API only (the
# OCI CLI, over HTTPS): no SSH. The VM is set up by cloud-init: firewall, the latest webtor-relay
# release (checked against SHA256SUMS) as a systemd service, and Caddy for HTTPS with Let's Encrypt
# at <public-ip-with-dashes>.sslip.io (or RELAY_HOST). Everything it creates is named webtor-relay
# and tagged managed-by=webtor-relay; a re-run reuses it and never makes duplicates. A re-run on an
# existing VM reboots it, which installs the latest release. See relay/README.md.
#
# Shapes, fastest free one first: VM.Standard.A1.Flex with RELAY_OCPUS (1 Gbit/s per OCPU), else
# VM.Standard.E2.1.Micro (50 Mbit/s to the internet), both Always Free. With RELAY_ALLOW_PAID=1 a
# paid AMD shape (VM.Standard.E4.Flex, else E5.Flex: 1 OCPU, 1 Gbit/s) replaces the Micro, and an A1
# beyond the free allowance is allowed; the cost is logged before the launch. A new VM gets the
# reserved public IP webtor-relay, so its relay URL survives a new VM (when the account can reserve one).
#
# Usage: scripts/deploy-relay-oci.sh [--deploy [--upgrade] | --destroy] [--dry-run]
#        scripts/deploy-relay-oci.sh --print-cloud-init      # rendered user-data, token masked
#   --upgrade   replace an existing VM that is slower than what the settings launch now (the Micro,
#               or an A1 with fewer OCPUs): the new VM starts next to it, takes over its address once
#               it answers, and only then is the old one terminated.
#
# Environment (the workflow .github/workflows/deploy-relay-oci.yml maps repo secrets of these names):
#   OCI_TENANCY_OCID OCI_USER_OCID OCI_FINGERPRINT OCI_REGION   API signing key details (required)
#   OCI_PRIVATE_KEY        PEM of the API signing key, e.g. "$(cat ~/Downloads/key.pem)" (required)
#   RELAY_TOKEN            relay password, >= 32 chars of A-Z a-z 0-9 . _ ~ - (required for deploy)
#   OCI_COMPARTMENT_OCID   compartment for everything (default: the tenancy's root compartment)
#   OCI_SSH_PUBLIC_KEY     authorize this key for ssh ubuntu@<ip> and open 22/tcp (default: no SSH)
#   RELAY_HOST             your own DNS name (A record → the VM's IP) instead of <ip>.sslip.io
#   RELAY_OCPUS            OCPUs of the A1 VM, 1-4, 6 GB of memory each (default 2: free, 2 Gbit/s)
#   RELAY_ALLOW_PAID       1 = may launch a paid shape (see above); default: Always Free only
#   RELAY_REPO             GitHub repo whose latest release is installed (default alexeychikk/webtor)
#   RELAY_WAIT_SECONDS     how long to wait for https://<host>/ to answer (default 900)
#                          (a new VM that misses it is kept; the next run gives it the reserved IP)
# --dry-run needs none of them: it prints the OCI calls it would make (with stand-in responses, as if
# nothing existed yet) and the rendered cloud-init. The token is never printed: output shows
# <RELAY_TOKEN> instead. Dry-run knobs: DRY_RUN_NO_A1=1 simulates "Out of host capacity" for the A1
# shape, DRY_RUN_NOT_HOME=1 a region that isn't the home region, DRY_RUN_USED_GB=<n>[,<n>...]
# volumes of these sizes that aren't attached to anything (a boot volume, then block volumes) next
# to the existing VM's own 50 GB boot volume, DRY_RUN_EXISTING_SHAPE=<shape> (and DRY_RUN_EXISTING_OCPUS=<n>) an existing
# relay VM (DRY_RUN_EXISTING_RESERVED=1: holding the reserved public IP; =free: launched for it, but
# it is still unassigned, as after a first deploy that timed out), DRY_RUN_NO_RESERVED_IP=1
# an account that can't reserve a public IP, DRY_RUN_FAIL_MOVE=1 a failing move of the reserved IP
# to the new VM (an upgrade rolls back), DRY_RUN_FAIL_WAIT=1 a failing state read of the new VM while
# it boots (an upgrade rolls back), DRY_RUN_NO_ANSWER=1 a relay that doesn't answer in time.
set -euo pipefail
# Plain bash 3.2 (macOS) works: no empty-array expansions under set -u, no GNU-only tools.
cd "$(dirname "$0")/.."

NAME=webtor-relay
TAGS='{"managed-by":"webtor-relay"}'
FILES=scripts/deploy-relay-oci
VCN_CIDR=10.0.0.0/16
SUBNET_CIDR=10.0.0.0/24
A1_SHAPE=VM.Standard.A1.Flex
A1_MEMORY_PER_OCPU_GB=6
MICRO_SHAPE=VM.Standard.E2.1.Micro
# Internet bandwidth: the Micro gets 50 Mbit/s (Always Free page), the flex shapes 1 Gbit/s per
# OCPU (https://docs.oracle.com/iaas/Content/Compute/References/computeshapes.htm).
MICRO_MBPS=50
FLEX_MBPS_PER_OCPU=1000
# Paid fallback with RELAY_ALLOW_PAID=1, cheapest first: AMD (amd64), 1 OCPU = 2 vCPUs, 1 Gbit/s.
PAID_SHAPES="VM.Standard.E4.Flex VM.Standard.E5.Flex"
PAID_OCPUS=1
PAID_MEMORY_GB=4
# Pay As You Go list prices in USD (https://www.oracle.com/cloud/price-list/, checked 2026-10-24):
# per OCPU-hour and per GB-hour of memory; block volume storage + 10 VPUs (balanced) per GB-month.
PRICE_LIST_URL=https://www.oracle.com/cloud/price-list/
HOURS_PER_MONTH=730
BLOCK_GB_MONTH_USD=0.0425
# 50 GB is the smallest boot volume size the API takes (the Console's 46.6/47 GB default is the
# image's own size); a fixed size keeps the storage check below exact.
BOOT_VOLUME_GB=50
# Always Free allowances (per tenancy, home region only): two E2.1.Micro, 200 GB of boot and block
# volumes together, and A1 hours: the Always Free page gives 1,500 OCPU-hours + 9,000 GB-hours a
# month (= 2 OCPUs + 12 GB around the clock); the price list still bills only past 3,000 + 18,000.
# The check takes the lower figure. A month of 744 h at 2 OCPUs leaves 12 OCPU-hours, which covers
# the hour or so an upgrade runs the old A1 next to the new one.
FREE_A1_OCPUS=2
FREE_A1_MEMORY_GB=12
FREE_MICRO_COUNT=2
FREE_STORAGE_GB=200

action=deploy
dry_run=0
upgrade=0
for arg in "$@"; do
  case $arg in
  --deploy) action=deploy ;;
  --upgrade) upgrade=1 ;;
  --destroy) action=destroy ;;
  --print-cloud-init) action=print-cloud-init ;;
  --dry-run) dry_run=1 ;;
  -h | --help)
    sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "deploy-relay-oci: unknown argument $arg (see --help)" >&2
    exit 2
    ;;
  esac
done
if ((upgrade)) && [[ $action != deploy ]]; then
  echo "deploy-relay-oci: --upgrade goes with --deploy" >&2
  exit 2
fi

log() { printf '%s\n' "$*" >&2; }
# fd 4 = the script's stderr, for the logged OCI calls: callers capture the CLI's own stderr.
exec 4>&2
sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }
die() {
  log "deploy-relay-oci: error: $*"
  exit 1
}
mask() {
  local s
  s=$(cat)
  if [[ -n ${RELAY_TOKEN:-} ]]; then
    s=${s//"$RELAY_TOKEN"/<RELAY_TOKEN>}
  fi
  printf '%s\n' "$s"
}

# --- inputs -------------------------------------------------------------------------------------

check_inputs() {
  local v missing=()
  local required=(OCI_TENANCY_OCID OCI_USER_OCID OCI_FINGERPRINT OCI_PRIVATE_KEY OCI_REGION)
  if [[ $action != destroy ]]; then
    required+=(RELAY_TOKEN)
  fi
  for v in "${required[@]}"; do
    if [[ -z ${!v:-} ]]; then
      missing+=("$v")
    fi
  done
  if ((${#missing[@]})); then
    if ((dry_run)) || [[ $action == print-cloud-init ]]; then
      # Stand-ins so a dry run works without credentials. The token stand-in is masked like a real one.
      OCI_TENANCY_OCID=${OCI_TENANCY_OCID:-ocid1.tenancy.oc1..dryrun}
      OCI_USER_OCID=${OCI_USER_OCID:-ocid1.user.oc1..dryrun}
      OCI_FINGERPRINT=${OCI_FINGERPRINT:-00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00}
      OCI_REGION=${OCI_REGION:-eu-frankfurt-1}
      RELAY_TOKEN=${RELAY_TOKEN:-dry-run-token-0123456789abcdefghijklmnopqrstuvwxyz}
      log "(dry run: stand-ins for ${missing[*]})"
    else
      die "missing ${missing[*]} (see --help or relay/README.md)"
    fi
  fi
  COMPARTMENT=${OCI_COMPARTMENT_OCID:-$OCI_TENANCY_OCID}
  RELAY_REPO=${RELAY_REPO:-alexeychikk/webtor}
  RELAY_HOST=${RELAY_HOST:-}
  RELAY_WAIT_SECONDS=${RELAY_WAIT_SECONDS:-900}
  OCI_SSH_PUBLIC_KEY=${OCI_SSH_PUBLIC_KEY:-}
  RELAY_OCPUS=${RELAY_OCPUS:-2}
  RELAY_ALLOW_PAID=${RELAY_ALLOW_PAID:-0}

  [[ $OCI_TENANCY_OCID == ocid1.tenancy.* ]] || die "OCI_TENANCY_OCID must start with ocid1.tenancy."
  [[ $OCI_USER_OCID == ocid1.user.* ]] || die "OCI_USER_OCID must start with ocid1.user."
  [[ $COMPARTMENT == ocid1.* ]] || die "OCI_COMPARTMENT_OCID must start with ocid1."
  [[ $OCI_REGION =~ ^[a-z]+(-[a-z0-9]+)+$ ]] || die "OCI_REGION must be a region identifier like eu-frankfurt-1"
  [[ $OCI_FINGERPRINT =~ ^([0-9a-f]{2}:){15}[0-9a-f]{2}$ ]] || die "OCI_FINGERPRINT must look like 12:ab:…:ef (16 hex pairs)"
  if [[ $action != destroy ]] && [[ ! $RELAY_TOKEN =~ ^[A-Za-z0-9._~-]{32,}$ ]]; then
    die "RELAY_TOKEN must be at least 32 characters of A-Z a-z 0-9 . _ ~ - (e.g. openssl rand -hex 24)"
  fi
  if [[ -n $RELAY_HOST ]] && [[ ! $RELAY_HOST =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$ ]]; then
    die "RELAY_HOST must be a lower-case DNS name like relay.example.com"
  fi
  if [[ -n $OCI_SSH_PUBLIC_KEY ]] && [[ ! $OCI_SSH_PUBLIC_KEY =~ ^(ssh-|ecdsa-|sk-) ]]; then
    die "OCI_SSH_PUBLIC_KEY must be an OpenSSH public key (ssh-ed25519 AAAA…)"
  fi
  [[ $RELAY_REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "RELAY_REPO must be owner/name"
  [[ $RELAY_WAIT_SECONDS =~ ^[0-9]+$ ]] || die "RELAY_WAIT_SECONDS must be a number"
  [[ $RELAY_OCPUS =~ ^[1-4]$ ]] || die "RELAY_OCPUS must be 1, 2, 3 or 4"
  [[ $RELAY_ALLOW_PAID =~ ^[01]$ ]] || die "RELAY_ALLOW_PAID must be 1 (allow a paid shape) or 0"
  if [[ $action == deploy ]] && ((RELAY_OCPUS > FREE_A1_OCPUS && !RELAY_ALLOW_PAID)); then
    die "RELAY_OCPUS=$RELAY_OCPUS: an A1 with over $FREE_A1_OCPUS OCPUs is billed (Always Free covers $FREE_A1_OCPUS OCPUs and $FREE_A1_MEMORY_GB GB). Set RELAY_ALLOW_PAID=1 (the workflow's allow_paid) to accept the cost, or RELAY_OCPUS=$FREE_A1_OCPUS to stay free."
  fi
  A1_OCPUS=$RELAY_OCPUS
  A1_MEMORY_GB=$((RELAY_OCPUS * A1_MEMORY_PER_OCPU_GB))
}

# --- cloud-init ---------------------------------------------------------------------------------

indent() { sed 's/^/      /'; }

render_cloud_init() {
  cat <<EOF
#cloud-config
# webtor-relay on Oracle Cloud, rendered by scripts/deploy-relay-oci.sh. webtor-relay-setup runs on
# every boot: firewall ports, host name, Caddyfile, video conversion settings, latest release. A
# reboot updates the relay. ffmpeg (Ubuntu's, with libx264) is for the relay's video conversion.
package_update: true
packages:
  - caddy
  - curl
  - ffmpeg
write_files:
  - path: /etc/webtor-relay/deploy.conf
    permissions: "0644"
    content: |
      RELAY_REPO=$RELAY_REPO
      RELAY_HOST=$RELAY_HOST
  - path: /etc/webtor-relay/token.env
    permissions: "0600"
    content: |
      WEBTOR_RELAY_TOKEN=$RELAY_TOKEN
  - path: /usr/local/sbin/webtor-relay-setup
    permissions: "0755"
    content: |
$(indent <"$FILES/setup.sh")
  - path: /etc/systemd/system/webtor-relay-setup.service
    permissions: "0644"
    content: |
$(indent <"$FILES/webtor-relay-setup.service")
  - path: /etc/systemd/system/webtor-relay.service
    permissions: "0644"
    content: |
$(indent <"$FILES/webtor-relay.service")
runcmd:
  - [systemctl, daemon-reload]
  - [systemctl, enable, webtor-relay-setup.service, webtor-relay.service]
  - [systemctl, start, webtor-relay-setup.service]
  - [systemctl, start, --no-block, webtor-relay.service]
EOF
}

# --- OCI CLI ------------------------------------------------------------------------------------

WORK=$(mktemp -d)
# An upgrade that fails after the launch (a die anywhere) must not leave the new VM next to the old one.
on_exit() {
  local rc=$?
  set +e
  if [[ -n ${PENDING_NEW:-} ]]; then
    log "deploy-relay-oci: error: the upgrade failed (see above): rolling back, the old VM keeps serving."
  fi
  rollback
  rm -rf "$WORK"
  exit $rc
}
trap on_exit EXIT

setup_oci() {
  if ((dry_run)); then
    return
  fi
  command -v oci >/dev/null || die "the OCI CLI is not installed: pipx install oci-cli (or pip install oci-cli)"
  command -v jq >/dev/null || die "jq is not installed"
  (
    umask 077
    # Keys downloaded from the OCI Console end with an extra "OCI_API_KEY" line: keep the PEM block only.
    # A secret pasted with literal \n instead of line breaks works too.
    printf '%b\n' "$OCI_PRIVATE_KEY" | sed -n '/-----BEGIN/,/-----END/p' >"$WORK/key.pem"
    cat >"$WORK/config" <<EOF
[DEFAULT]
user=$OCI_USER_OCID
fingerprint=$OCI_FINGERPRINT
tenancy=$OCI_TENANCY_OCID
region=$OCI_REGION
key_file=$WORK/key.pem
EOF
  )
  [[ -s $WORK/key.pem ]] || die "OCI_PRIVATE_KEY is not a PEM private key (-----BEGIN PRIVATE KEY----- …)"
  export OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING=True
}

# oci_ <args>: runs the OCI CLI (JSON on stdout) and logs the call. Arguments never hold secrets:
# the token travels in the user-data file only. In a dry run it answers with stand-in JSON.
oci_() {
  log "+ oci $*" 2>&4
  if ((dry_run)); then
    fake_oci "$@"
    return $? # explicit: a bare return in a trap handler (rollback) returns the status before the trap
  fi
  oci --config-file "$WORK/config" --output json "$@"
}

# Stand-in ids: the existing VM (DRY_RUN_EXISTING_SHAPE) and the one a launch creates.
DRY_OLD=ocid1.instance.oc1.dryrun-existing
DRY_NEW=ocid1.instance.oc1.dryrun-new

fake_oci() {
  local cmd="$1 $2 $3" id
  id="ocid1.${2//-/}.oc1.dryrun"
  case $cmd in
  "iam availability-domain list")
    echo '{"data":[{"name":"Xxxx:EU-FRANKFURT-1-AD-1"},{"name":"Xxxx:EU-FRANKFURT-1-AD-2"}]}'
    ;;
  "compute shape list")
    jq -n --arg a "$A1_SHAPE" --arg m "$MICRO_SHAPE" '{data: ([$a, $m, "VM.Standard.E4.Flex",
      "VM.Standard.E5.Flex", "VM.Standard3.Flex"] | map({shape: .}))}'
    ;;
  "compute image list")
    jq -n '{data: [
      {id: "ocid1.image.oc1.dryrun-2204", "display-name": "Canonical-Ubuntu-22.04-2026.09.01-0", "operating-system-version": "22.04", "time-created": "2026-09-01"},
      {id: "ocid1.image.oc1.dryrun-2404-min", "display-name": "Canonical-Ubuntu-24.04-Minimal-2026.09.01-0", "operating-system-version": "24.04 Minimal", "time-created": "2026-09-01"},
      {id: "ocid1.image.oc1.dryrun-2404", "display-name": "Canonical-Ubuntu-24.04-2026.09.01-0", "operating-system-version": "24.04", "time-created": "2026-09-01"},
      {id: "ocid1.image.oc1.dryrun-2510", "display-name": "Canonical-Ubuntu-25.10-2026.09.01-0", "operating-system-version": "25.10", "time-created": "2026-09-01"}]}'
    ;;
  "compute instance launch")
    if [[ ${DRY_RUN_NO_A1:-} == 1 && " $* " == *" $A1_SHAPE "* ]]; then
      echo 'ServiceError: {"code": "InternalError", "message": "Out of host capacity.", "status": 500}' >&2
      return 1
    fi
    echo "{\"data\":{\"id\":\"$DRY_NEW\",\"lifecycle-state\":\"PROVISIONING\"}}"
    ;;
  "compute instance list")
    if [[ $action == destroy ]] || [[ -n ${DRY_RUN_EXISTING_SHAPE:-} ]]; then
      echo "{\"data\":[{\"id\":\"$DRY_OLD\",\"lifecycle-state\":\"RUNNING\",\"freeform-tags\":$TAGS}]}"
    fi
    ;;
  "iam region-subscription list")
    local home=$OCI_REGION
    if [[ ${DRY_RUN_NOT_HOME:-} == 1 ]]; then
      home=us-ashburn-1
    fi
    jq -n --arg r "$OCI_REGION" --arg h "$home" \
      '{data: ([$h, $r] | unique | map({"region-name": ., "is-home-region": (. == $h)}))}'
    ;;
  "compute instance get")
    if [[ " $* " == *" $DRY_OLD "* ]]; then
      local shape=${DRY_RUN_EXISTING_SHAPE:-$MICRO_SHAPE} ocpus=${DRY_RUN_EXISTING_OCPUS:-1}
      jq -n --arg s "$shape" --argjson o "$ocpus" --argjson t "$TAGS" '{data: {"lifecycle-state": "RUNNING",
        "display-name": "webtor-relay", "compartment-id": "ocid1.tenancy.oc1..dryrun",
        "availability-domain": "Xxxx:EU-FRANKFURT-1-AD-1",
        shape: $s, "shape-config": {ocpus: $o, "memory-in-gbs": (if $s | test("Micro") then 1 else $o * 6 end)},
        "freeform-tags": ($t + {config: "dryrun"} + (if env.DRY_RUN_EXISTING_RESERVED // "" | . == "" then {}
          else {"reserved-ip": "want"} end))}}'
    elif [[ ${DRY_RUN_FAIL_WAIT:-} == 1 && " $* " == *" $DRY_NEW "* ]]; then
      echo 'ServiceError: {"code": "InternalError", "message": "Simulated failure.", "status": 500}' >&2
      return 1
    else
      echo '{"data":{"lifecycle-state":"RUNNING"}}'
    fi
    ;;
  "compute instance list-vnics")
    if [[ " $* " == *" $DRY_OLD "* && ${DRY_RUN_EXISTING_RESERVED:-} == 1 ]]; then
      echo '{"data":[{"id":"ocid1.vnic.oc1.dryrun-existing","is-primary":true,"public-ip":"203.0.113.20"}]}'
    elif [[ " $* " == *" $DRY_OLD "* && ${DRY_RUN_EXISTING_RESERVED:-} == free ]]; then
      echo '{"data":[{"id":"ocid1.vnic.oc1.dryrun-existing","is-primary":true,"public-ip":"198.51.100.7"}]}'
    elif [[ " $* " == *" $DRY_OLD "* ]]; then
      echo '{"data":[{"id":"ocid1.vnic.oc1.dryrun-existing","is-primary":true,"public-ip":"198.51.100.7"}]}'
    else
      echo '{"data":[{"id":"ocid1.vnic.oc1.dryrun-new","is-primary":true,"public-ip":"203.0.113.10"}]}'
    fi
    ;;
  "network private-ip list")
    echo "{\"data\":[{\"id\":\"ocid1.privateip.oc1.dryrun-${5##*-}\",\"is-primary\":true}]}"
    ;;
  "network public-ip create")
    if [[ ${DRY_RUN_NO_RESERVED_IP:-} == 1 ]]; then
      echo 'ServiceError: {"code": "LimitExceeded", "message": "The following service limits were exceeded: reserved-public-ip-count.", "status": 400}' >&2
      return 1
    fi
    echo '{"data":{"id":"ocid1.publicip.oc1.dryrun-reserved","ip-address":"203.0.113.20","lifecycle-state":"AVAILABLE"}}'
    ;;
  "network public-ip list")
    if [[ $action == destroy || ${DRY_RUN_EXISTING_RESERVED:-} == 1 ]]; then
      jq -n --argjson t "$TAGS" '{data: [{id: "ocid1.publicip.oc1.dryrun-reserved", "ip-address": "203.0.113.20",
        "lifecycle-state": "ASSIGNED", "display-name": "webtor-relay", "freeform-tags": $t,
        "assigned-entity-id": "ocid1.privateip.oc1.dryrun-existing"}]}'
    elif [[ ${DRY_RUN_EXISTING_RESERVED:-} == free ]]; then
      jq -n --argjson t "$TAGS" '{data: [{id: "ocid1.publicip.oc1.dryrun-reserved", "ip-address": "203.0.113.20",
        "lifecycle-state": "AVAILABLE", "display-name": "webtor-relay", "freeform-tags": $t}]}'
    fi
    ;;
  "network public-ip update")
    if [[ ${DRY_RUN_FAIL_MOVE:-} == 1 && " $* " == *" ocid1.privateip.oc1.dryrun-new "* ]]; then
      echo 'ServiceError: {"code": "InternalError", "message": "dry run: the move fails", "status": 500}' >&2
      return 1
    fi
    echo '{"data":{"id":"ocid1.publicip.oc1.dryrun-reserved","lifecycle-state":"ASSIGNED"}}'
    ;;
  "network public-ip get")
    if [[ " $* " == *" ocid1.privateip.oc1.dryrun-existing "* && ${DRY_RUN_EXISTING_RESERVED:-} == 1 ]]; then
      echo '{"data":{"id":"ocid1.publicip.oc1.dryrun-reserved","ip-address":"203.0.113.20","lifetime":"RESERVED"}}'
      return 0
    fi
    echo '{"data":{"id":"ocid1.publicip.oc1.dryrun-ephemeral","ip-address":"203.0.113.10","lifetime":"EPHEMERAL"}}'
    ;;
  "bv boot-volume get" | "bv volume get")
    # The existing VM's own boot volume, else the n-th size of DRY_RUN_USED_GB.
    if [[ $5 == *-existing ]]; then
      jq -n --argjson s $BOOT_VOLUME_GB '{data: {"display-name": "webtor-relay (Boot Volume)", "size-in-gbs": $s}}'
    else
      local n=${5##*-}
      jq -n --arg k "$2" --arg n "$n" --argjson s "$(cut -d, -f"$n" <<<"$DRY_RUN_USED_GB")" \
        '{data: {"display-name": (if $k == "boot-volume" then "old-vm-\($n) (Boot Volume)" else "data-\($n)" end),
          "size-in-gbs": $s}}'
    fi
    ;;
  "compute boot-volume-attachment list")
    if [[ " $* " == *" $DRY_OLD "* ]]; then
      echo '{"data":[{"boot-volume-id":"ocid1.bootvolume.oc1.dryrun-existing","lifecycle-state":"ATTACHED"}]}'
    fi
    ;;
  "compute volume-attachment list") ;;
  "search resource structured-search")
    if [[ " $* " == *" query bootvolume, volume "* ]]; then
      jq -n --arg used "${DRY_RUN_USED_GB:-}" --arg old "${DRY_RUN_EXISTING_SHAPE:-}" '{data: {items: (
        (if $old == "" then [] else [{identifier: "ocid1.bootvolume.oc1.dryrun-existing", "resource-type": "BootVolume"}] end)
        + ($used | if . == "" then [] else split(",") end | to_entries | map(if .key == 0
          then {identifier: "ocid1.bootvolume.oc1.dryrun-\(.key + 1)", "resource-type": "BootVolume"}
          else {identifier: "ocid1.volume.oc1.dryrun-\(.key + 1)", "resource-type": "Volume"} end)))}}'
    elif [[ -n ${DRY_RUN_EXISTING_SHAPE:-} ]]; then
      echo "{\"data\":{\"items\":[{\"identifier\":\"$DRY_OLD\",\"resource-type\":\"Instance\"}]}}"
    else
      echo '{"data":{"items":[]}}'
    fi
    ;;
  *" list")
    # Deploy: nothing exists yet. Destroy: one of each, so the delete calls show.
    if [[ $action == destroy ]]; then
      echo "{\"data\":[{\"id\":\"$id\",\"lifecycle-state\":\"AVAILABLE\",\"display-name\":\"$NAME\",\"freeform-tags\":$TAGS}]}"
    fi
    ;;
  *) echo "{\"data\":{\"id\":\"$id\",\"lifecycle-state\":\"AVAILABLE\"}}" ;;
  esac
}

# JSON on stdin → the ids of live resources we created (the CLI prints nothing for an empty list).
managed_ids() {
  jq -r '.data[]? | select(.["freeform-tags"]["managed-by"] == "webtor-relay")
    | select(.["lifecycle-state"] | IN("TERMINATED", "TERMINATING") | not) | .id'
}
first_line() { sed -n 1p; } # reads all input: head would SIGPIPE jq under pipefail
data_id() { jq -r '.data.id'; }

# --- network ------------------------------------------------------------------------------------

find_vcn() {
  oci_ network vcn list --compartment-id "$COMPARTMENT" --display-name "$NAME" --all | managed_ids | first_line
}

ensure_network() {
  local id
  VCN_ID=$(find_vcn)
  if [[ -n $VCN_ID ]]; then
    log "VCN: reusing $VCN_ID"
  else
    VCN_ID=$(oci_ network vcn create --compartment-id "$COMPARTMENT" --display-name "$NAME" \
      --cidr-blocks "[\"$VCN_CIDR\"]" --dns-label webtorrelay --freeform-tags "$TAGS" \
      --wait-for-state AVAILABLE | data_id)
    log "VCN: created $VCN_ID"
  fi

  IGW_ID=$(oci_ network internet-gateway list --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" \
    --display-name "$NAME" --all | managed_ids | first_line)
  if [[ -n $IGW_ID ]]; then
    log "Internet gateway: reusing $IGW_ID"
  else
    IGW_ID=$(oci_ network internet-gateway create --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" \
      --display-name "$NAME" --is-enabled true --freeform-tags "$TAGS" --wait-for-state AVAILABLE | data_id)
    log "Internet gateway: created $IGW_ID"
  fi

  local routes="[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW_ID\"}]"
  RT_ID=$(oci_ network route-table list --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" \
    --display-name "$NAME" --all | managed_ids | first_line)
  if [[ -n $RT_ID ]]; then
    oci_ network route-table update --rt-id "$RT_ID" --route-rules "$routes" --force >/dev/null
    log "Route table: reusing $RT_ID (rules refreshed)"
  else
    RT_ID=$(oci_ network route-table create --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" \
      --display-name "$NAME" --route-rules "$routes" --freeform-tags "$TAGS" --wait-for-state AVAILABLE | data_id)
    log "Route table: created $RT_ID"
  fi

  local ingress egress
  ingress=$(ingress_rules)
  egress='[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]'
  SL_ID=$(oci_ network security-list list --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" \
    --display-name "$NAME" --all | managed_ids | first_line)
  if [[ -n $SL_ID ]]; then
    oci_ network security-list update --security-list-id "$SL_ID" --ingress-security-rules "$ingress" \
      --egress-security-rules "$egress" --force >/dev/null
    log "Security list: reusing $SL_ID (rules refreshed)"
  else
    SL_ID=$(oci_ network security-list create --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" \
      --display-name "$NAME" --ingress-security-rules "$ingress" --egress-security-rules "$egress" \
      --freeform-tags "$TAGS" --wait-for-state AVAILABLE | data_id)
    log "Security list: created $SL_ID"
  fi

  SUBNET_ID=$(oci_ network subnet list --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" \
    --display-name "$NAME" --all | managed_ids | first_line)
  if [[ -n $SUBNET_ID ]]; then
    log "Subnet: reusing $SUBNET_ID"
  else
    id=$(oci_ network subnet create --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" --display-name "$NAME" \
      --cidr-block "$SUBNET_CIDR" --dns-label relay --route-table-id "$RT_ID" --security-list-ids "[\"$SL_ID\"]" \
      --prohibit-public-ip-on-vnic false --freeform-tags "$TAGS" --wait-for-state AVAILABLE | data_id)
    SUBNET_ID=$id
    log "Subnet: created $SUBNET_ID (public)"
  fi
}

# 80/443 for Caddy (Let's Encrypt needs 80), 42069 TCP+UDP for BitTorrent peers, ICMP 3/4 for path
# MTU discovery (OCI's default), 22 only with an SSH key.
ingress_rules() {
  local tcp_ports=(80 443 42069)
  if [[ -n $OCI_SSH_PUBLIC_KEY ]]; then
    tcp_ports+=(22)
  fi
  local rules=() p
  for p in "${tcp_ports[@]}"; do
    rules+=("{\"source\":\"0.0.0.0/0\",\"protocol\":\"6\",\"isStateless\":false,\"tcpOptions\":{\"destinationPortRange\":{\"min\":$p,\"max\":$p}}}")
  done
  rules+=('{"source":"0.0.0.0/0","protocol":"17","isStateless":false,"udpOptions":{"destinationPortRange":{"min":42069,"max":42069}}}')
  rules+=('{"source":"0.0.0.0/0","protocol":"1","isStateless":false,"icmpOptions":{"type":3,"code":4}}')
  local IFS=,
  printf '[%s]\n' "${rules[*]}"
}

# --- instance -----------------------------------------------------------------------------------

find_instances() {
  oci_ compute instance list --compartment-id "$COMPARTMENT" --display-name "$NAME" --all | managed_ids
}

instance_state() {
  oci_ compute instance get --instance-id "$1" | jq -r '.data["lifecycle-state"]'
}

# wait_instance <id> <state>: 0 when it gets there, 1 when it terminated instead (failed launch).
wait_instance() {
  local id=$1 want=$2 state deadline=$((SECONDS + 1200))
  while :; do
    state=$(instance_state "$id") || die "can't read the state of instance $id"
    if [[ $state == "$want" ]]; then
      return 0
    elif [[ $state == TERMINATED || $state == TERMINATING ]]; then
      return 1
    elif ((SECONDS > deadline)); then
      die "instance $id is still $state after 20 minutes"
    fi
    log "  instance is $state, waiting for $want…"
    sleep 15
  done
}

terminate_instance() {
  oci_ compute instance terminate --instance-id "$1" --preserve-boot-volume false --force \
    --wait-for-state TERMINATED --max-wait-seconds 1200 >/dev/null
}

# Newest Ubuntu LTS (even year, .04) image that runs on the shape, not Minimal and not GPU.
latest_ubuntu_lts() {
  oci_ compute image list --compartment-id "$COMPARTMENT" --operating-system "Canonical Ubuntu" \
    --shape "$1" --lifecycle-state AVAILABLE --sort-by TIMECREATED --sort-order DESC --all |
    jq -r '[.data[]? | select(.["operating-system-version"] | test("^[0-9]+\\.04$"))
      | select((.["operating-system-version"] | split(".")[0] | tonumber) % 2 == 0)
      | select(.["display-name"] | test("Minimal|GPU"; "i") | not)]
      | sort_by((.["operating-system-version"] | split(".")[0] | tonumber), .["time-created"])
      | last // empty | "\(.id) \(.["display-name"])"'
}

# mbps_of <shape> <ocpus>: internet bandwidth in Mbit/s (0: a shape this script doesn't launch).
mbps_of() {
  case $1 in
  "$MICRO_SHAPE") echo "$MICRO_MBPS" ;;
  "$A1_SHAPE" | VM.Standard.E[0-9]*.Flex)
    awk -v o="$2" -v p="$FLEX_MBPS_PER_OCPU" 'BEGIN { printf "%d\n", o * p }'
    ;;
  *) echo 0 ;;
  esac
}
# describe <shape> <ocpus> <memory-GB>: "shape, 2 OCPU, 12 GB, 2 Gbit/s" (the Micro: its fixed size).
describe() {
  case $1 in
  "$MICRO_SHAPE") echo "$1, 1/8 OCPU, 1 GB, $(rate "$MICRO_MBPS")" ;;
  *) echo "$1, $2 OCPU, $3 GB, $(rate "$(mbps_of "$1" "$2")")" ;;
  esac
}
rate() { awk -v m="$1" 'BEGIN { if (m >= 1000) printf "%g Gbit/s\n", m / 1000; else printf "%d Mbit/s\n", m }'; }

# What a launch tries, in order, as "shape OCPUs memory-GB" lines.
candidates() {
  local s
  echo "$A1_SHAPE $A1_OCPUS $A1_MEMORY_GB"
  if ((RELAY_ALLOW_PAID)); then
    for s in $PAID_SHAPES; do
      echo "$s $PAID_OCPUS $PAID_MEMORY_GB"
    done
  else
    echo "$MICRO_SHAPE 1 1"
  fi
}

# fits_free_tier <shape> <ocpus> <memory-GB> [<instance to leave out>]: does one more instance of
# this shape fit the Always Free allowance next to the tenancy's other instances (any compartment,
# stopped ones included; an upgrade leaves out the VM it replaces)? A Pay As You Go account would be
# billed beyond it. Sets A1_USED_OCPUS and A1_USED_MEMORY_GB.
fits_free_tier() {
  local shape=$1 ocpus=$2 mem=$3 skip=${4:-} ids id info micros=0
  A1_USED_OCPUS=0 A1_USED_MEMORY_GB=0
  if [[ $shape != "$A1_SHAPE" && $shape != "$MICRO_SHAPE" ]]; then
    return 1
  fi
  ids=$(oci_ search resource structured-search \
    --query-text "query instance resources where lifecycleState != 'TERMINATED' && lifecycleState != 'TERMINATING'" |
    jq -r '.data.items[]?.identifier') ||
    die "can't list the tenancy's instances to check the Always Free allowance (the user needs permission to inspect instances)"
  for id in $ids; do
    [[ $id != "$skip" ]] || continue
    info=$(oci_ compute instance get --instance-id "$id" |
      jq -r '[.data.shape, (.data["shape-config"].ocpus // 0), (.data["shape-config"]["memory-in-gbs"] // 0)] | @tsv') ||
      die "can't read instance $id to check the Always Free allowance"
    case $info in
    "$A1_SHAPE"*)
      A1_USED_OCPUS=$(awk -v a="$A1_USED_OCPUS" -v b="$(cut -f2 <<<"$info")" 'BEGIN { print a + b }')
      A1_USED_MEMORY_GB=$(awk -v a="$A1_USED_MEMORY_GB" -v b="$(cut -f3 <<<"$info")" 'BEGIN { print a + b }')
      ;;
    "$MICRO_SHAPE"*) micros=$((micros + 1)) ;;
    esac
  done
  if [[ $shape == "$A1_SHAPE" ]]; then
    if awk -v o="$A1_USED_OCPUS" -v m="$A1_USED_MEMORY_GB" -v fo=$FREE_A1_OCPUS -v fm=$FREE_A1_MEMORY_GB \
      -v no="$ocpus" -v nm="$mem" 'BEGIN { exit !(o + no <= fo && m + nm <= fm) }'; then
      return 0
    fi
    log "Other instances use $A1_USED_OCPUS of $FREE_A1_OCPUS free A1 OCPUs and $A1_USED_MEMORY_GB of $FREE_A1_MEMORY_GB GB; $ocpus OCPUs and $mem GB more would not be free."
    return 1
  fi
  if ((micros < FREE_MICRO_COUNT)); then
    return 0
  fi
  log "The tenancy already has $micros $MICRO_SHAPE instances (Always Free allows $FREE_MICRO_COUNT)."
  return 1
}

# monthly_usd <shape> <ocpus> <memory-GB>: list price of a month of it, whole dollars. A1: only the
# part past the free allowance, given what fits_free_tier found the other instances use.
monthly_usd() {
  local ocpu_h gb_h
  case $1 in
  "$A1_SHAPE") ocpu_h=0.01 gb_h=0.0015 ;;
  VM.Standard.E4.Flex) ocpu_h=0.025 gb_h=0.0015 ;;
  VM.Standard.E5.Flex) ocpu_h=0.03 gb_h=0.002 ;;
  *) die "no price for $1" ;;
  esac
  awk -v s="$1" -v a1="$A1_SHAPE" -v o="$2" -v m="$3" -v uo="$A1_USED_OCPUS" -v um="$A1_USED_MEMORY_GB" \
    -v fo=$FREE_A1_OCPUS -v fm=$FREE_A1_MEMORY_GB -v po="$ocpu_h" -v pm="$gb_h" -v h=$HOURS_PER_MONTH '
    function over(new, used, free, x) { x = used + new - free; return x < 0 ? 0 : (x > new ? new : x) }
    BEGIN { if (s == a1) { o = over(o, uo, fo); m = over(m, um, fm) }; printf "%.0f\n", (o * po + m * pm) * h }'
}

# volume_attachments [<old VM id>]: one line "<volume id>\t<instance name> (<state>)\t<1 if it is the
# old VM's boot volume, else 0>" per boot or block volume attached to one of the tenancy's instances.
# Best effort: a lookup that fails is logged and printed as a line "-" (attachments unknown).
volume_attachments() {
  local old=${1:-} ids id info name state comp ad vol mine
  ids=$(oci_ search resource structured-search \
    --query-text "query instance resources where lifecycleState != 'TERMINATED' && lifecycleState != 'TERMINATING'" |
    jq -r '.data.items[]?.identifier') || {
    log "warning: can't list the tenancy's instances to tell what the volumes are attached to"
    echo -
    ids=""
  }
  if [[ -n $old ]] && ! grep -qxF "$old" <<<"$ids"; then
    ids=$(printf '%s\n%s' "$ids" "$old")
  fi
  for id in $ids; do
    # No empty fields: read would merge adjacent tabs.
    info=$(oci_ compute instance get --instance-id "$id" | jq -r '[.data["display-name"] // "?",
      .data["lifecycle-state"] // "?", .data["compartment-id"] // "-", .data["availability-domain"] // "-"] | @tsv') || {
      log "warning: can't read instance $id to tell which volumes it has"
      echo -
      continue
    }
    IFS=$'\t' read -r name state comp ad <<<"$info"
    mine=0
    [[ $id != "$old" ]] || mine=1
    vol=$(oci_ compute boot-volume-attachment list --compartment-id "$comp" --availability-domain "$ad" \
      --instance-id "$id" --all |
      jq -r '.data[]? | select(.["lifecycle-state"] | IN("ATTACHING", "ATTACHED")) | .["boot-volume-id"]') || {
      log "warning: can't list the boot volume of instance $name"
      echo -
    }
    for vol in $vol; do
      printf '%s\t%s (%s)\t%s\n' "$vol" "$name" "$state" "$mine"
    done
    vol=$(oci_ compute volume-attachment list --compartment-id "$comp" --instance-id "$id" --all |
      jq -r '.data[]? | select(.["lifecycle-state"] | IN("ATTACHING", "ATTACHED")) | .["volume-id"]') || {
      log "warning: can't list the block volumes of instance $name"
      echo -
    }
    for vol in $vol; do
      printf '%s\t%s (%s)\t0\n' "$vol" "$name" "$state"
    done
  done
}

# check_free_storage [<old VM id>]: Always Free covers 200 GB of boot and block volumes in total,
# across the tenancy (detached and preserved boot volumes included). Past it, a new boot volume is
# billed: allowed with RELAY_ALLOW_PAID=1 (logged), else it dies. An upgrade is judged on the total
# once it has terminated the old VM with its boot volume: the overlap while both exist (about an hour)
# is billed by the hour, a few cents at most, so it is only logged. Every counted volume is listed
# with what it is attached to, so the user can tell which leftover to delete.
check_free_storage() {
  local old=${1:-} items attached id type kind info size name att where used=0 old_boot=0 unknown=0
  local list="" unattached="" peak after over cost
  items=$(oci_ search resource structured-search \
    --query-text "query bootvolume, volume resources where lifecycleState != 'TERMINATED' && lifecycleState != 'TERMINATING'" |
    jq -r '.data.items[]? | "\(.identifier) \(.["resource-type"])"') ||
    die "can't list the tenancy's volumes to check the Always Free storage (the user needs permission to inspect volumes)"
  attached=""
  if [[ -n $items ]]; then
    attached=$(volume_attachments "$old")
  fi
  if grep -qx -- - <<<"$attached"; then
    unknown=1
  fi
  while read -r id type; do
    [[ -n $id ]] || continue
    case $type in
    BootVolume)
      kind=boot
      info=$(oci_ bv boot-volume get --boot-volume-id "$id")
      ;;
    *)
      kind=block
      info=$(oci_ bv volume get --volume-id "$id")
      ;;
    esac || die "can't read volume $id to check the Always Free storage"
    size=$(jq -r '.data["size-in-gbs"] // empty' <<<"$info")
    name=$(jq -r '.data["display-name"] // empty' <<<"$info")
    [[ $size =~ ^[0-9]+$ ]] || die "volume $id has no size (got '$size')"
    [[ -n $name ]] || name=$id
    used=$((used + size))
    att=$(awk -F'\t' -v v="$id" '$1 == v { print $2 "\t" $3; exit }' <<<"$attached")
    if [[ -n $att ]]; then
      where="attached to ${att%%$'\t'*}"
      if [[ ${att#*$'\t'} == 1 ]]; then
        where="$where: terminated by this upgrade"
        old_boot=$((old_boot + size))
      fi
    elif ((unknown)); then
      where="attachment unknown"
    else
      where="not attached"
      unattached="$unattached; $name: $size GB $kind volume"
    fi
    list="$list"$'\n'"  - $name: $kind volume, $size GB, $where"
  done <<<"$items"
  log "Storage: the tenancy's boot and block volumes take $used of the $FREE_STORAGE_GB GB Always Free storage:${list:- none}"
  if [[ -n $old ]] && ((old_boot == 0)); then
    log "Storage: the old VM's boot volume wasn't found among them; counting every volume as staying."
  fi
  peak=$((used + BOOT_VOLUME_GB))
  after=$((peak - old_boot))
  if ((after <= FREE_STORAGE_GB)); then
    if ((peak <= FREE_STORAGE_GB)); then
      log "Storage: the relay's $BOOT_VOLUME_GB GB boot volume makes it $peak GB, within the free storage$( ((old_boot)) && printf ' (%s GB once the upgrade terminates the old VM)' "$after")."
    else
      over=$((peak - FREE_STORAGE_GB))
      cost=$(awk -v g=$over -v p=$BLOCK_GB_MONTH_USD -v h=$HOURS_PER_MONTH 'BEGIN { printf "%.3f", g * p / h }')
      log "Storage: the relay's $BOOT_VOLUME_GB GB boot volume makes it $peak GB while the old VM still exists: $over GB over the free storage, briefly, until the upgrade terminates the old VM (then $after GB, free). That overlap is billed by the hour: about \$$cost an hour, cents at most ($PRICE_LIST_URL)."
    fi
    return 0
  fi
  over=$((after - FREE_STORAGE_GB))
  cost=$(awk -v g=$over -v p=$BLOCK_GB_MONTH_USD 'BEGIN { printf "%.2f", g * p }')
  local what="the relay's $BOOT_VOLUME_GB GB boot volume would make it $after GB"
  if ((old_boot)); then
    what="even after the upgrade terminates the old VM's $old_boot GB boot volume, $what"
  fi
  if ((RELAY_ALLOW_PAID)); then
    log "Storage: $what, $over GB over the $FREE_STORAGE_GB GB Always Free storage. That part is billed: about \$$cost a month, by the hour ($PRICE_LIST_URL)."
    return 0
  fi
  local fix="Free up space (delete volumes you don't need in the OCI Console: Storage → Boot Volumes / Block Volumes)"
  if [[ -n $unattached ]]; then
    fix="Not attached to anything: ${unattached#; }. Delete the ones you don't need in the OCI Console (Storage → Boot Volumes / Block Volumes)"
  elif ((!unknown)); then
    fix="Every volume is attached to an instance: free up space (delete instances or volumes you don't need in the OCI Console)"
  fi
  die "$what, $over GB over the $FREE_STORAGE_GB GB Always Free storage, which is billed (about \$$cost a month). $fix, or set RELAY_ALLOW_PAID=1 to accept the cost."
}

# launch_instance <user-data> <config tag> [<VM it replaces> <its Mbit/s>]: launches the first
# candidate shape that is faster than the VM it replaces, offered in the region, free (or
# RELAY_ALLOW_PAID=1), and has capacity in some availability domain. Sets INSTANCE_ID, LAUNCHED.
launch_instance() {
  local user_data=$1 config_tag=$2 old=${3:-} min_mbps=${4:-0} tags shape ocpus mem mbps paid image image_name
  local ad out err ads offered cands ssh_args=()
  # reserved-ip: this VM is meant to hold the reserved public IP (VMs from before it keep their address).
  tags=$(jq -c --arg c "$config_tag" '. + {"config": $c, "reserved-ip": "want"}' <<<"$TAGS")
  if [[ -n $OCI_SSH_PUBLIC_KEY ]]; then
    printf '%s\n' "$OCI_SSH_PUBLIC_KEY" >"$WORK/ssh.pub"
    ssh_args=(--ssh-authorized-keys-file "$WORK/ssh.pub")
  fi
  ads=$(oci_ iam availability-domain list --compartment-id "$OCI_TENANCY_OCID" | jq -r '.data[].name')
  [[ -n $ads ]] || die "no availability domains in $OCI_REGION"
  offered=$(oci_ compute shape list --compartment-id "$COMPARTMENT" --all | jq -r '.data[]?.shape' | sort -u)
  check_free_storage "$old"

  cands=$(candidates)
  # fd 3: the loop body runs commands that could read stdin.
  while read -r shape ocpus mem <&3; do
    local shape_args=()
    paid=0
    mbps=$(mbps_of "$shape" "$ocpus")
    if ((mbps <= min_mbps)); then
      log "Skipping $shape: $(rate "$mbps") is not faster than the VM it would replace."
      continue
    fi
    if ! grep -qxF "$shape" <<<"$offered"; then
      log "Skipping $shape: not offered in $OCI_REGION."
      continue
    fi
    if [[ $shape == "$MICRO_SHAPE" ]]; then
      log "Falling back to $MICRO_SHAPE (Always Free, amd64, 1 GB RAM): the relay runs, but Oracle caps"
      log "its internet bandwidth at $(rate "$MICRO_MBPS") (about 6 MB/s): enough for 1080p, too slow for high-bitrate"
      log "(4K) files. RELAY_ALLOW_PAID=1 takes a 1 Gbit/s paid shape instead; once Oracle has A1 capacity,"
      log "re-run with --upgrade (or destroy, then deploy) to move to A1."
    else
      shape_args=(--shape-config "{\"ocpus\":$ocpus,\"memoryInGBs\":$mem}")
    fi
    if ! fits_free_tier "$shape" "$ocpus" "$mem" "$old"; then
      if ((!RELAY_ALLOW_PAID)); then
        log "Skipping $shape: it would not be free (RELAY_ALLOW_PAID=1 allows it)."
        continue
      fi
      paid=1
    fi
    read -r image image_name < <(latest_ubuntu_lts "$shape") || true
    if [[ -z ${image:-} ]]; then
      log "No Ubuntu LTS image for $shape in $OCI_REGION, skipping it."
      continue
    fi
    log "Image for $shape: $image_name"
    if ((paid)); then
      log "Paid shape: $(describe "$shape" "$ocpus" "$mem") to the internet: about \$$(monthly_usd "$shape" "$ocpus" "$mem") a month at"
      log "  list price, billed per second while it runs ($PRICE_LIST_URL). Outbound data is free up to 10 TB a month."
    else
      log "Always Free shape: $(describe "$shape" "$ocpus" "$mem") to the internet."
    fi
    for ad in $ads; do
      log "Launching $shape in $ad…"
      if out=$(oci_ compute instance launch --compartment-id "$COMPARTMENT" --availability-domain "$ad" \
        --display-name "$NAME" --hostname-label "$NAME" --shape "$shape" ${shape_args[@]+"${shape_args[@]}"} \
        --image-id "$image" --boot-volume-size-in-gbs "$BOOT_VOLUME_GB" --subnet-id "$SUBNET_ID" \
        --assign-public-ip true --user-data-file "$user_data" ${ssh_args[@]+"${ssh_args[@]}"} \
        --freeform-tags "$tags" 2>"$WORK/err"); then
        INSTANCE_ID=$(data_id <<<"$out")
        [[ -n $INSTANCE_ID && $INSTANCE_ID != null ]] || die "the launch returned no instance id"
        # From here an upgrade owns the new VM: a die while it boots (wait_instance) rolls it back.
        if [[ -n $old ]]; then
          PENDING_NEW=$INSTANCE_ID
        fi
        if wait_instance "$INSTANCE_ID" RUNNING; then
          LAUNCHED=$(describe "$shape" "$ocpus" "$mem")
          ((!paid)) || LAUNCHED="$LAUNCHED, paid"
          log "Instance: created $INSTANCE_ID ($LAUNCHED)"
          return 0
        fi
        log "  the launch in $ad failed (instance terminated), trying the next one."
        PENDING_NEW=""
        continue
      fi
      err=$(mask <"$WORK/err")
      if grep -qiE 'out of (host )?capacity' <<<"$err"; then
        log "  Out of host capacity in $ad."
      elif grep -qiE 'LimitExceeded|QuotaExceeded' <<<"$err"; then
        # E2.1.Micro (and on some accounts A1) limits are per availability domain: try the next one.
        log "  $err"
        log "  The service limit for $shape is reached in $ad."
      else
        log "$err"
        die "launching the instance failed"
      fi
    done
  done 3<<<"$cands"
  local paid_hint=""
  if ((!RELAY_ALLOW_PAID)); then
    paid_hint=", or allow a paid 1 Gbit/s shape with RELAY_ALLOW_PAID=1 (the workflow's allow_paid)"
  fi
  if [[ -n $old ]]; then
    die "no faster shape could be launched in $OCI_REGION right now. The current relay VM keeps running unchanged. Oracle frees capacity over time: run the upgrade again later$paid_hint."
  fi
  die "no capacity for a relay VM in any availability domain of $OCI_REGION right now. Oracle frees capacity over time: run the deploy again later (the network is kept, a re-run only retries the instance)$paid_hint."
}

public_ip_of() {
  local ip deadline=$((SECONDS + 300))
  while :; do
    # Called as $(public_ip_of …): set -e is off in there (bash), so check the call itself.
    ip=$(oci_ compute instance list-vnics --instance-id "$1" | jq -r '[.data[]?["public-ip"] // empty][0] // empty') ||
      die "can't read the VNICs of instance $1"
    if [[ -n $ip ]]; then
      printf '%s\n' "$ip"
      return 0
    fi
    ((SECONDS < deadline)) || die "the instance has no public IP address after 5 minutes"
    sleep 10
  done
}

# Reboot (or start) an existing instance: webtor-relay-setup then installs the latest release.
restart_instance() {
  local id=$1 state
  state=$(instance_state "$id")
  case $state in
  RUNNING)
    log "Rebooting $id to install the latest release…"
    oci_ compute instance action --instance-id "$id" --action SOFTRESET >/dev/null
    ;;
  STOPPED)
    log "Starting the stopped instance $id…"
    oci_ compute instance action --instance-id "$id" --action START >/dev/null
    ;;
  STOPPING)
    wait_instance "$id" STOPPED || die "instance $id terminated"
    oci_ compute instance action --instance-id "$id" --action START >/dev/null
    ;;
  *) log "Instance $id is $state." ;;
  esac
  REBOOTED=1
  wait_instance "$id" RUNNING || die "instance $id terminated"
}

# --- reserved public IP -------------------------------------------------------------------------

# A reserved public IP outlives instances, so the <ip>.sslip.io relay URL (or RELAY_HOST's A record)
# stays when a new VM replaces the old one. Oracle doesn't charge for public IPs (no price list
# entry); Pay As You Go allows 50 per region. Sets RESERVED_ID, RESERVED_IP and RESERVED_AT (the
# private IP it is assigned to, or -). RESERVED_ID stays empty when the account can't reserve one.
ensure_reserved_ip() {
  local found
  RESERVED_ID="" RESERVED_IP="" RESERVED_AT=-
  found=$(oci_ network public-ip list --compartment-id "$COMPARTMENT" --scope REGION --lifetime RESERVED --all |
    jq -r '[.data[]? | select(.["freeform-tags"]["managed-by"] == "webtor-relay")
      | select(.["lifecycle-state"] | IN("TERMINATED", "TERMINATING") | not)][0] // empty
      | "\(.id) \(.["ip-address"]) \(.["assigned-entity-id"] // .["private-ip-id"] // "-")"') ||
    die "can't list the reserved public IPs"
  if [[ -n $found ]]; then
    read -r RESERVED_ID RESERVED_IP RESERVED_AT <<<"$found"
    log "Reserved public IP: reusing $RESERVED_IP"
    return 0
  fi
  if ! found=$(oci_ network public-ip create --compartment-id "$COMPARTMENT" --lifetime RESERVED \
    --display-name "$NAME" --freeform-tags "$TAGS" --wait-for-state AVAILABLE 2>"$WORK/err"); then
    mask <"$WORK/err" >&2
    log "Can't reserve a public IP: the new VM keeps the address it launched with, so the relay URL"
    log "changes whenever a new VM replaces it."
    return 0
  fi
  RESERVED_ID=$(data_id <<<"$found")
  RESERVED_IP=$(jq -r '.data["ip-address"]' <<<"$found")
  log "Reserved public IP: created $RESERVED_IP"
}

primary_private_ip() {
  local vnic ip
  vnic=$(oci_ compute instance list-vnics --instance-id "$1" | jq -r '[.data[]? | select(.["is-primary"])][0].id // empty')
  [[ -n $vnic ]] || die "instance $1 has no primary VNIC"
  ip=$(oci_ network private-ip list --vnic-id "$vnic" --all | jq -r '[.data[]? | select(.["is-primary"])][0].id // empty')
  [[ -n $ip ]] || die "instance $1 has no primary private IP"
  printf '%s\n' "$ip"
}

# move_reserved_ip <private IP id>: assigns the reserved IP there (taking it from where it was).
# A private IP holds one public IP, so the ephemeral one a VM launched with goes first.
move_reserved_ip() {
  local eph
  # None assigned: the CLI fails with NotFound.
  if eph=$(oci_ network public-ip get --private-ip-id "$1" 2>/dev/null); then
    eph=$(jq -r 'select(.data.lifetime == "EPHEMERAL") | .data.id' <<<"$eph")
  else
    eph=
  fi
  if [[ -n $eph ]]; then
    oci_ network public-ip delete --public-ip-id "$eph" --force --wait-for-state TERMINATED >/dev/null
  fi
  oci_ network public-ip update --public-ip-id "$RESERVED_ID" --private-ip-id "$1" \
    --wait-for-state ASSIGNED >/dev/null
}

# claim_reserved_ip <instance id> <its public IP>: a VM launched for the reserved public IP that
# doesn't hold it yet (its first deploy timed out before the move) takes it now, if it is free. The
# caller reboots the VM afterwards, so that its setup serves the new address. Sets CLAIMED (the IP).
claim_reserved_ip() {
  local id=$1 ip=$2 priv
  ensure_reserved_ip
  [[ -n $RESERVED_ID && $RESERVED_IP != "$ip" ]] || return 0
  if [[ $RESERVED_AT != - ]]; then
    log "The reserved public IP $RESERVED_IP is assigned to something else: this VM keeps $ip."
    return 0
  fi
  log "Moving the reserved public IP $RESERVED_IP to this VM (it still has its launch address $ip)…"
  priv=$(primary_private_ip "$id")
  move_reserved_ip "$priv"
  CLAIMED=$RESERVED_IP
}

# --- relay checks -------------------------------------------------------------------------------

# curl that keeps the URL (it may hold the token) out of the process list and logs.
curl_url() {
  local url=$1
  shift
  printf 'url = "%s"\n' "$url" | curl -fsS --max-time 15 "$@" -K -
}

relay_host() { printf '%s\n' "${RELAY_HOST:-${1//./-}.sslip.io}"; }

# wait_relay <host> [<ip>]: does the relay answer at https://<host>/? With an ip, at that address
# (curl --resolve), not wherever DNS points. A probe: safe to call in a condition (no set -e needed).
wait_relay() {
  local host=$1 deadline=$((SECONDS + RELAY_WAIT_SECONDS)) next_note=0 at=()
  if [[ -n ${2:-} ]]; then
    at=(--resolve "$host:443:$2")
  fi
  if ((dry_run)); then
    log "(dry run: would wait up to ${RELAY_WAIT_SECONDS}s for https://$host/${2:+ on $2} to answer)"
    if [[ ${DRY_RUN_NO_ANSWER:-} == 1 ]]; then
      log "The relay did not answer at https://$host/ within ${RELAY_WAIT_SECONDS}s (dry run: DRY_RUN_NO_ANSWER)."
      return 1
    fi
    return 0
  fi
  if ((${REBOOTED:-0})); then
    # Don't take the old relay's last answers for the new one: wait (up to 3 min) until it goes down.
    local down=$((SECONDS + 180))
    while ((SECONDS < down)) && curl_url "https://$host/" ${at[@]+"${at[@]}"} -o /dev/null 2>/dev/null; do
      sleep 5
    done
  fi
  log "Waiting for https://$host/ (first boot installs packages and gets a certificate: 5–10 min)…"
  until curl_url "https://$host/" ${at[@]+"${at[@]}"} -o /dev/null 2>/dev/null; do
    if ((SECONDS > deadline)); then
      log "The relay did not answer at https://$host/ within ${RELAY_WAIT_SECONDS}s."
      log "The VM may still be setting up: run the deploy again in a few minutes (it reboots the VM),"
      log "or look at the boot log: OCI Console → Compute → Instances → $NAME → Console connection,"
      log "or with an SSH key: ssh ubuntu@<ip> sudo journalctl -u webtor-relay-setup -u webtor-relay -u caddy"
      return 1
    fi
    if ((SECONDS >= next_note)); then
      log "  not yet ($(((deadline - SECONDS) / 60)) min left)"
      next_note=$((SECONDS + 60))
    fi
    sleep 10
  done
  local info
  if info=$(curl_url "https://$host/$RELAY_TOKEN/v1/info" ${at[@]+"${at[@]}"} 2>/dev/null); then
    log "Relay answers: $(jq -r '"\(.name) \(.version)"' <<<"$info" 2>/dev/null || echo ok)"
  else
    log "warning: the relay answers but rejects RELAY_TOKEN: it was created with another token."
    log "Run the destroy action, then deploy again, to use the current RELAY_TOKEN."
  fi
}

# wait_setup <ip>: has a new VM finished its first-boot setup? With sslip.io: its relay answers on
# its own address. With RELAY_HOST (DNS still points at the old address, so no certificate yet):
# Caddy on port 80 redirects that name to HTTPS, which it does once setup wrote the Caddyfile.
# A probe, like wait_relay.
wait_setup() {
  local ip=$1 deadline=$((SECONDS + RELAY_WAIT_SECONDS)) code
  if [[ -z $RELAY_HOST ]]; then
    wait_relay "$(relay_host "$ip")" "$ip"
    return $?
  fi
  if ((dry_run)); then
    log "(dry run: would wait up to ${RELAY_WAIT_SECONDS}s for http://$RELAY_HOST/ on $ip to redirect to HTTPS)"
    if [[ ${DRY_RUN_NO_ANSWER:-} == 1 ]]; then
      log "The new VM did not set up $RELAY_HOST within ${RELAY_WAIT_SECONDS}s (dry run: DRY_RUN_NO_ANSWER)."
      return 1
    fi
    return 0
  fi
  log "Waiting for the new VM ($ip) to serve $RELAY_HOST (first boot: 5–10 min)…"
  while :; do
    code=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code} %{redirect_url}' \
      --resolve "$RELAY_HOST:80:$ip" "http://$RELAY_HOST/" 2>/dev/null || true)
    if [[ $code == 30[178]" https://$RELAY_HOST"* ]]; then
      return 0
    fi
    if ((SECONDS > deadline)); then
      log "The new VM did not set up $RELAY_HOST within ${RELAY_WAIT_SECONDS}s."
      return 1
    fi
    sleep 10
  done
}

# --- actions ------------------------------------------------------------------------------------

# Always Free resources exist only in the tenancy's home region: anywhere else the VM would be billed.
check_home_region() {
  local regions home
  regions=$(oci_ iam region-subscription list --tenancy-id "$OCI_TENANCY_OCID") ||
    die "can't read the tenancy's region subscriptions to check the home region"
  home=$(jq -r '.data[]? | select(.["is-home-region"] == true) | .["region-name"]' <<<"$regions")
  [[ -n $home ]] || die "can't tell the tenancy's home region"
  if [[ $home != "$OCI_REGION" ]]; then
    die "OCI_REGION is $OCI_REGION, but the tenancy's home region is $home. Always Free resources exist only in the home region: set OCI_REGION=$home."
  fi
  log "Region: $OCI_REGION (home region)"
}

# bring_up [<old VM id> <its Mbit/s> <its public IP>]: launches a new VM and makes it the relay. It
# first answers on the address it launched with; then (when the account has a reserved public IP) it
# takes over the reserved one and reboots, so its setup serves that. With an old VM, the old one is
# terminated only once the new one answers; until then any failure (abandon, or a die: the EXIT trap)
# terminates the new one and gives the reserved IP back to the old one (rollback). Sets HOST, UP (1:
# the relay answers) and DNS_MOVE (the address RELAY_HOST's A record must move to, if it must).
# Call it as a plain command, never in a condition or with && / ||: bash ignores set -e in a
# function called there, and everything it calls would carry on after a failure.
bring_up() {
  local old=${1:-} old_mbps=${2:-0} old_ip=${3:-} ip final priv
  UP=0
  # With an old VM, launch_instance sets PENDING_NEW as soon as the new VM exists.
  launch_instance "$WORK/user-data" "$CONFIG_TAG" "$old" "$old_mbps"
  ip=$(public_ip_of "$INSTANCE_ID")
  log "Public IP of the new VM: $ip"
  # The summary needs a host even when the setup doesn't finish in time (a fresh deploy keeps the VM).
  HOST=$(relay_host "$ip")
  ensure_reserved_ip
  final=$ip
  if [[ -n $RESERVED_ID ]]; then
    if [[ -n $old && $RESERVED_AT != - ]]; then
      GIVE_BACK=$RESERVED_AT
    fi
    log "Waiting for the new VM's setup on its own address before it takes over $RESERVED_IP…"
    if ! wait_setup "$ip"; then
      if [[ -z $old ]]; then
        # Kept (nothing to roll back to): the next run's claim_reserved_ip moves the reserved IP to it.
        LATER_IP=$RESERVED_IP
      fi
      abandon
      return 0
    fi
    log "Moving the reserved public IP $RESERVED_IP to the new VM…"
    priv=$(primary_private_ip "$INSTANCE_ID")
    MOVED=1
    move_reserved_ip "$priv"
    log "Rebooting the new VM so that its setup serves $RESERVED_IP…"
    oci_ compute instance action --instance-id "$INSTANCE_ID" --action SOFTRESET >/dev/null
    REBOOTED=1
    wait_instance "$INSTANCE_ID" RUNNING || die "the new instance $INSTANCE_ID terminated"
    final=$RESERVED_IP
  fi
  HOST=$(relay_host "$final")
  if [[ -n $RELAY_HOST && -n $old && $final != "$old_ip" ]]; then
    # RELAY_HOST's A record still points at the old VM, which would answer the check, and the new VM
    # can't get a certificate before the record moves: check the new VM's setup on its own address.
    log "RELAY_HOST's A record points at the old VM ($old_ip): checking the new VM on $final instead."
    if ! wait_setup "$final"; then
      abandon
      return 0
    fi
    DNS_MOVE=$final
  else
    dns_note "$final"
    if ! wait_relay "$HOST" "$final"; then
      abandon
      return 0
    fi
  fi
  retire "$old"
  UP=1
}

dns_note() {
  if [[ -n $RELAY_HOST ]]; then
    log "RELAY_HOST is $RELAY_HOST: its DNS A record must point at $1 for the certificate."
  fi
}

# The upgrade worked: the old VM goes (and with it its boot volume and allowance). From here on a
# failure keeps the new VM.
retire() {
  [[ -n ${1:-} ]] || return 0
  PENDING_NEW=""
  log "Terminating the old VM $1 ($OLD_DESC) and its boot volume…"
  terminate_instance "$1" ||
    die "the new relay serves, but terminating the old VM $1 failed: terminate it in the OCI Console (Compute → Instances), or the next run may pick either VM"
  log "Old VM terminated."
}

# The new VM doesn't answer: with an old VM, that one keeps serving and the new one goes.
abandon() {
  [[ -n ${PENDING_NEW:-} ]] || return 0
  log "The new VM did not come up. The old VM keeps serving."
  rollback
}

# Undoes an unfinished upgrade (abandon, and the EXIT trap after a die): the reserved IP goes back to
# the old VM if it had it, and the new VM is terminated. Best effort: each step reports its failure.
rollback() {
  [[ -n ${PENDING_NEW:-} ]] || return 0
  local id=$PENDING_NEW
  PENDING_NEW=""
  if ((${MOVED:-0})) && [[ -n ${GIVE_BACK:-} ]]; then
    log "Giving the reserved public IP $RESERVED_IP back to the old VM…"
    if ! move_reserved_ip "$GIVE_BACK"; then
      log "warning: giving the reserved public IP back failed: in the OCI Console, assign $RESERVED_IP"
      log "  to the old VM's primary VNIC (Networking → Reserved public IPs), or run the upgrade again."
    fi
  fi
  log "Terminating the new VM $id…"
  if ! terminate_instance "$id"; then
    log "warning: terminating the new VM $id failed: terminate it in the OCI Console (Compute → Instances)."
  fi
}

deploy() {
  render_cloud_init >"$WORK/user-data"
  if ((dry_run)); then
    log "--- cloud-init user-data (token masked) ---"
    mask <"$WORK/user-data" >&2
    log "--- end of user-data ---"
  fi
  local ids best_mbps ready=0 upgraded=0 old_ip="" old_host=""
  # Fingerprint of everything that only applies at launch, to tell when a re-run can't apply it.
  CONFIG_TAG=$({ cat "$WORK/user-data"; printf '%s\n' "$OCI_SSH_PUBLIC_KEY"; } | sha256 | cut -c1-16)
  # The fastest VM the settings launch: the A1 with RELAY_OCPUS (paid shapes get 1 OCPU, 1 Gbit/s).
  best_mbps=$(mbps_of "$A1_SHAPE" "$A1_OCPUS")

  check_home_region
  ensure_network
  ids=$(find_instances)
  OLD_ID=$(first_line <<<"$ids")
  if [[ -z $OLD_ID ]]; then
    bring_up
    ready=$UP
  else
    if (($(wc -l <<<"$ids") > 1)); then
      log "warning: several $NAME instances exist, using $OLD_ID"
    fi
    local info tag shape ocpus mem old_mbps
    info=$(oci_ compute instance get --instance-id "$OLD_ID")
    tag=$(jq -r '.data["freeform-tags"].config // empty' <<<"$info")
    shape=$(jq -r '.data.shape // empty' <<<"$info")
    ocpus=$(jq -r '.data["shape-config"].ocpus // 0' <<<"$info")
    mem=$(jq -r '.data["shape-config"]["memory-in-gbs"] // 0' <<<"$info")
    old_mbps=$(mbps_of "$shape" "$ocpus")
    OLD_DESC=$(describe "$shape" "$ocpus" "$mem")
    [[ $old_mbps != 0 ]] || OLD_DESC="$shape"
    log "Instance: found $OLD_ID ($OLD_DESC)"
    if ((old_mbps > 0 && old_mbps < best_mbps)); then
      if ((upgrade)); then
        log "Upgrade: replacing it with a faster VM (up to $(rate "$best_mbps"): $A1_SHAPE with $A1_OCPUS OCPUs$( ((RELAY_ALLOW_PAID)) && printf ', else a paid 1 Gbit/s shape'))."
        old_ip=$(public_ip_of "$OLD_ID")
        old_host=$(relay_host "$old_ip")
        upgraded=1
        bring_up "$OLD_ID" "$old_mbps" "$old_ip"
        ready=$UP
        if ((!ready)); then
          die "the upgrade did not finish; the old relay keeps serving at https://$old_host/. Run it again later."
        fi
      else
        log "Upgrade available: deploy --upgrade (the workflow's \"upgrade\" box) replaces this $(rate "$old_mbps")"
        log "VM with $A1_SHAPE, $A1_OCPUS OCPUs ($(rate "$best_mbps")) without downtime: the new VM"
        log "starts next to it and takes over once it answers. The relay URL changes once, unless this VM"
        log "already has the reserved public IP $NAME; later upgrades keep it."
      fi
    elif ((upgrade)); then
      log "Nothing to upgrade: this VM is not slower than what the settings launch ($(rate "$best_mbps"))."
    fi
    if ((!upgraded)); then
      INSTANCE_ID=$OLD_ID
      log "Instance: reusing $INSTANCE_ID"
      if [[ $tag != "$CONFIG_TAG" ]]; then
        log "Note: RELAY_TOKEN, RELAY_HOST, OCI_SSH_PUBLIC_KEY or the VM setup (e.g. ffmpeg for video"
        log "conversion) changed since this instance was created. Those apply only to a new instance:"
        log "run destroy, then deploy, to apply them."
      fi
      local ip
      ip=$(public_ip_of "$INSTANCE_ID")
      if [[ $(jq -r '.data["freeform-tags"]["reserved-ip"] // empty' <<<"$info") == want ]]; then
        claim_reserved_ip "$INSTANCE_ID" "$ip"
      fi
      restart_instance "$INSTANCE_ID"
      if [[ -n ${CLAIMED:-} ]]; then
        old_host=$(relay_host "$ip")
        ip=$CLAIMED
      fi
      HOST=$(relay_host "$ip")
      log "Public IP: $ip"
      if [[ -n ${CLAIMED:-} && -n $RELAY_HOST ]]; then
        # The A record still points at the launch address: no certificate before it moves.
        DNS_MOVE=$ip
        if wait_setup "$ip"; then
          ready=1
        fi
      else
        dns_note "$ip"
        if wait_relay "$HOST" "$ip"; then
          ready=1
        fi
      fi
    fi
  fi

  local summary changed=""
  if [[ -n $old_host && $old_host != "$HOST" ]]; then
    changed="
The relay URL CHANGED (it was https://$old_host/<your RELAY_TOKEN>): paste the new one into the
app's relay setting on every device that uses it."
  fi
  if [[ -n ${DNS_MOVE:-} ]]; then
    changed="
Move the DNS A record of $RELAY_HOST to $DNS_MOVE NOW: the relay answers at
https://$RELAY_HOST/ (same relay URL) only once the record points there and the VM got its
certificate (Caddy keeps retrying; a few minutes after the DNS change)."
  fi
  if [[ -n ${LATER_IP:-} ]]; then
    local later
    later="The relay URL then becomes https://$(relay_host "$LATER_IP")/<your RELAY_TOKEN>."
    [[ -z $RELAY_HOST ]] || later="Then point the DNS A record of $RELAY_HOST at $LATER_IP."
    changed="$changed
The VM is kept, but its setup did not finish in time. Run the deploy again in a few minutes: it
moves the reserved public IP $LATER_IP to the VM and reboots it.
$later"
  fi
  summary=$(
    cat <<EOF
Host:      $HOST${LAUNCHED:+
VM:        $LAUNCHED}
Relay URL: https://$HOST/<your RELAY_TOKEN>
Open https://$HOST/ (the app, served by the relay) or the hosted app, and paste the relay URL
into its relay setting (the "Relay" button).$changed
EOF
  )
  printf '\n%s\n' "$summary"
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
    local fence='```'
    printf '### webtor-relay on Oracle Cloud\n\n%s\n%s\n%s\n' "$fence" "$summary" "$fence" | mask >>"$GITHUB_STEP_SUMMARY"
  fi
  ((ready)) || exit 1
}

# delete_retry <description> <oci args…>: a subnet stays in use a little while after its instance is gone.
delete_retry() {
  local what=$1 try
  shift
  for try in 1 2 3 4 5 6 7 8 9 10; do
    if oci_ "$@" --force --wait-for-state TERMINATED >/dev/null; then
      log "Deleted $what"
      return 0
    fi
    log "  $what is still in use, retrying in 30 s ($try/10)…"
    sleep 30
  done
  die "could not delete $what"
}

destroy() {
  local id vcn
  for id in $(find_instances); do
    log "Terminating instance $id (and its boot volume)…"
    terminate_instance "$id"
  done
  for id in $(oci_ network public-ip list --compartment-id "$COMPARTMENT" --scope REGION --lifetime RESERVED --all | managed_ids); do
    oci_ network public-ip delete --public-ip-id "$id" --force --wait-for-state TERMINATED >/dev/null
    log "Deleted the reserved public IP $id"
  done
  vcn=$(find_vcn)
  if [[ -z $vcn ]]; then
    log "No $NAME VCN in this compartment: nothing else to delete."
    return 0
  fi
  # The VCN's default route table and security list go with the VCN and can't be deleted on their own.
  local defaults
  defaults=$(oci_ network vcn get --vcn-id "$vcn" | jq -r '.data["default-route-table-id"], .data["default-security-list-id"]')
  local kind
  for kind in subnet route-table security-list internet-gateway; do
    local id_flag
    case $kind in
    subnet) id_flag=--subnet-id ;;
    route-table) id_flag=--rt-id ;;
    security-list) id_flag=--security-list-id ;;
    internet-gateway) id_flag=--ig-id ;;
    esac
    for id in $(oci_ network "$kind" list --compartment-id "$COMPARTMENT" --vcn-id "$vcn" --all | managed_ids); do
      if grep -qxF "$id" <<<"$defaults"; then
        continue
      fi
      delete_retry "$kind $id" network "$kind" delete "$id_flag" "$id"
    done
  done
  delete_retry "VCN $vcn" network vcn delete --vcn-id "$vcn"
  log "Everything $NAME created is gone."
}

check_inputs
case $action in
print-cloud-init) render_cloud_init | mask ;;
deploy)
  setup_oci
  deploy
  ;;
destroy)
  setup_oci
  destroy
  ;;
esac
