#!/usr/bin/env bash
# Deploys webtor-relay to an Oracle Cloud (OCI) Always Free VM, or removes it again, through the OCI
# API only (the OCI CLI, over HTTPS): no SSH. The VM is set up by cloud-init: firewall, the latest
# webtor-relay release (checked against SHA256SUMS) as a systemd service, and Caddy for HTTPS with
# Let's Encrypt at <public-ip-with-dashes>.sslip.io (or RELAY_HOST). Everything it creates is named
# webtor-relay and tagged managed-by=webtor-relay; a re-run reuses it and never makes duplicates.
# A re-run on an existing VM reboots it, which installs the latest release. See relay/README.md.
#
# Usage: scripts/deploy-relay-oci.sh [--deploy | --destroy] [--dry-run]
#        scripts/deploy-relay-oci.sh --print-cloud-init      # rendered user-data, token masked
#
# Environment (the workflow .github/workflows/deploy-relay-oci.yml maps repo secrets of these names):
#   OCI_TENANCY_OCID OCI_USER_OCID OCI_FINGERPRINT OCI_REGION   API signing key details (required)
#   OCI_PRIVATE_KEY        PEM of the API signing key, e.g. "$(cat ~/Downloads/key.pem)" (required)
#   RELAY_TOKEN            relay password, >= 32 chars of A-Z a-z 0-9 . _ ~ - (required for deploy)
#   OCI_COMPARTMENT_OCID   compartment for everything (default: the tenancy's root compartment)
#   OCI_SSH_PUBLIC_KEY     authorize this key for ssh ubuntu@<ip> and open 22/tcp (default: no SSH)
#   RELAY_HOST             your own DNS name (A record → the VM's IP) instead of <ip>.sslip.io
#   RELAY_REPO             GitHub repo whose latest release is installed (default alexeychikk/webtor)
#   RELAY_WAIT_SECONDS     how long to wait for https://<host>/ to answer (default 900)
# --dry-run needs none of them: it prints the OCI calls it would make (with stand-in responses, as if
# nothing existed yet) and the rendered cloud-init. The token is never printed: output shows
# <RELAY_TOKEN> instead. Dry-run knobs: DRY_RUN_NO_A1=1 simulates "Out of host capacity" for the A1
# shape, DRY_RUN_NOT_HOME=1 a region that isn't the home region, DRY_RUN_USED_GB=<n> an existing
# boot volume of n GB.
set -euo pipefail
# Plain bash 3.2 (macOS) works: no empty-array expansions under set -u, no GNU-only tools.
cd "$(dirname "$0")/.."

NAME=webtor-relay
TAGS='{"managed-by":"webtor-relay"}'
FILES=scripts/deploy-relay-oci
VCN_CIDR=10.0.0.0/16
SUBNET_CIDR=10.0.0.0/24
A1_SHAPE=VM.Standard.A1.Flex
A1_OCPUS=1
A1_MEMORY_GB=6
MICRO_SHAPE=VM.Standard.E2.1.Micro
# 50 GB is the smallest boot volume size the API takes (the Console's 46.6/47 GB default is the
# image's own size); a fixed size keeps the storage check below exact.
BOOT_VOLUME_GB=50
# Always Free allowances (per tenancy, home region only): A1 4 OCPUs + 24 GB in total, two
# E2.1.Micro, 200 GB of boot and block volumes together.
FREE_A1_OCPUS=4
FREE_A1_MEMORY_GB=24
FREE_MICRO_COUNT=2
FREE_STORAGE_GB=200

action=deploy
dry_run=0
for arg in "$@"; do
  case $arg in
  --deploy) action=deploy ;;
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

log() { printf '%s\n' "$*" >&2; }
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
trap 'rm -rf "$WORK"' EXIT

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
  log "+ oci $*"
  if ((dry_run)); then
    fake_oci "$@"
    return
  fi
  oci --config-file "$WORK/config" --output json "$@"
}

fake_oci() {
  local cmd="$1 $2 $3" id
  id="ocid1.${2//-/}.oc1.dryrun"
  case $cmd in
  "iam availability-domain list")
    echo '{"data":[{"name":"Xxxx:EU-FRANKFURT-1-AD-1"},{"name":"Xxxx:EU-FRANKFURT-1-AD-2"}]}'
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
    echo "{\"data\":{\"id\":\"$id\",\"lifecycle-state\":\"PROVISIONING\"}}"
    ;;
  "iam region-subscription list")
    local home=$OCI_REGION
    if [[ ${DRY_RUN_NOT_HOME:-} == 1 ]]; then
      home=us-ashburn-1
    fi
    jq -n --arg r "$OCI_REGION" --arg h "$home" \
      '{data: ([$h, $r] | unique | map({"region-name": ., "is-home-region": (. == $h)}))}'
    ;;
  "compute instance get") echo '{"data":{"lifecycle-state":"RUNNING"}}' ;;
  "compute instance list-vnics") echo '{"data":[{"public-ip":"203.0.113.10"}]}' ;;
  "bv boot-volume get") echo "{\"data\":{\"size-in-gbs\":${DRY_RUN_USED_GB:-0}}}" ;;
  "search resource structured-search")
    if [[ -n ${DRY_RUN_USED_GB:-} && " $* " == *" query bootvolume, volume "* ]]; then
      echo '{"data":{"items":[{"identifier":"ocid1.bootvolume.oc1.dryrun","resource-type":"BootVolume"}]}}'
    else
      echo '{"data":{"items":[]}}'
    fi
    ;;
  *" list")
    # Deploy: nothing exists yet. Destroy: one of each, so the delete calls show.
    if [[ $action == destroy ]]; then
      echo "{\"data\":[{\"id\":\"$id\",\"lifecycle-state\":\"AVAILABLE\",\"freeform-tags\":$TAGS}]}"
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
    state=$(instance_state "$id")
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

# Does one more instance of this shape fit the Always Free allowance next to the tenancy's other
# instances (any compartment, stopped ones included)? A Pay As You Go account would be billed beyond it.
fits_free_tier() {
  local shape=$1 ids id info a1_ocpus=0 a1_mem=0 micros=0
  ids=$(oci_ search resource structured-search \
    --query-text "query instance resources where lifecycleState != 'TERMINATED' && lifecycleState != 'TERMINATING'" |
    jq -r '.data.items[]?.identifier') ||
    die "can't list the tenancy's instances to check the Always Free allowance (the user needs permission to inspect instances)"
  for id in $ids; do
    info=$(oci_ compute instance get --instance-id "$id" |
      jq -r '[.data.shape, (.data["shape-config"].ocpus // 0), (.data["shape-config"]["memory-in-gbs"] // 0)] | @tsv') ||
      die "can't read instance $id to check the Always Free allowance"
    case $info in
    "$A1_SHAPE"*)
      a1_ocpus=$(awk -v a="$a1_ocpus" -v b="$(cut -f2 <<<"$info")" 'BEGIN { print a + b }')
      a1_mem=$(awk -v a="$a1_mem" -v b="$(cut -f3 <<<"$info")" 'BEGIN { print a + b }')
      ;;
    "$MICRO_SHAPE"*) micros=$((micros + 1)) ;;
    esac
  done
  if [[ $shape == "$A1_SHAPE" ]]; then
    if awk -v o="$a1_ocpus" -v m="$a1_mem" -v fo=$FREE_A1_OCPUS -v fm=$FREE_A1_MEMORY_GB \
      -v no=$A1_OCPUS -v nm=$A1_MEMORY_GB 'BEGIN { exit !(o + no <= fo && m + nm <= fm) }'; then
      return 0
    fi
    log "Other instances already use $a1_ocpus of $FREE_A1_OCPUS free A1 OCPUs and $a1_mem of $FREE_A1_MEMORY_GB GB."
    return 1
  fi
  if ((micros < FREE_MICRO_COUNT)); then
    return 0
  fi
  log "The tenancy already has $micros $MICRO_SHAPE instances (Always Free allows $FREE_MICRO_COUNT)."
  return 1
}

# Always Free covers 200 GB of boot and block volumes in total, across the tenancy (detached and
# preserved boot volumes included). Dies when one more boot volume would go over it.
check_free_storage() {
  local items id type size used=0
  items=$(oci_ search resource structured-search \
    --query-text "query bootvolume, volume resources where lifecycleState != 'TERMINATED' && lifecycleState != 'TERMINATING'" |
    jq -r '.data.items[]? | "\(.identifier) \(.["resource-type"])"') ||
    die "can't list the tenancy's volumes to check the Always Free storage (the user needs permission to inspect volumes)"
  while read -r id type; do
    [[ -n $id ]] || continue
    case $type in
    BootVolume) size=$(oci_ bv boot-volume get --boot-volume-id "$id" | jq -r '.data["size-in-gbs"] // empty') ;;
    *) size=$(oci_ bv volume get --volume-id "$id" | jq -r '.data["size-in-gbs"] // empty') ;;
    esac || die "can't read volume $id to check the Always Free storage"
    [[ $size =~ ^[0-9]+$ ]] || die "volume $id has no size (got '$size')"
    used=$((used + size))
  done <<<"$items"
  if ((used + BOOT_VOLUME_GB > FREE_STORAGE_GB)); then
    die "the tenancy's boot and block volumes already take $used of the $FREE_STORAGE_GB GB Always Free storage; the relay's $BOOT_VOLUME_GB GB boot volume would be billed. Free up space (delete unused volumes) first."
  fi
  log "Storage: $used GB used, $BOOT_VOLUME_GB GB more stays within the $FREE_STORAGE_GB GB Always Free allowance."
}

launch_instance() {
  local user_data=$1 config_tag=$2 tags shape image image_name ad out err ads ssh_args=()
  tags=$(jq -c --arg c "$config_tag" '. + {"config": $c}' <<<"$TAGS")
  if [[ -n $OCI_SSH_PUBLIC_KEY ]]; then
    printf '%s\n' "$OCI_SSH_PUBLIC_KEY" >"$WORK/ssh.pub"
    ssh_args=(--ssh-authorized-keys-file "$WORK/ssh.pub")
  fi
  ads=$(oci_ iam availability-domain list --compartment-id "$OCI_TENANCY_OCID" | jq -r '.data[].name')
  [[ -n $ads ]] || die "no availability domains in $OCI_REGION"
  check_free_storage

  for shape in "$A1_SHAPE" "$MICRO_SHAPE"; do
    local shape_args=()
    if [[ $shape == "$A1_SHAPE" ]]; then
      shape_args=(--shape-config "{\"ocpus\":$A1_OCPUS,\"memoryInGBs\":$A1_MEMORY_GB}")
    else
      log "Falling back to $MICRO_SHAPE (Always Free, amd64, 1 GB RAM: slower, but the relay runs)."
    fi
    if ! fits_free_tier "$shape"; then
      log "Skipping $shape: it would not be free."
      continue
    fi
    read -r image image_name < <(latest_ubuntu_lts "$shape") || true
    if [[ -z ${image:-} ]]; then
      log "No Ubuntu LTS image for $shape in $OCI_REGION, skipping it."
      continue
    fi
    log "Image for $shape: $image_name"
    for ad in $ads; do
      log "Launching $shape in $ad…"
      if out=$(oci_ compute instance launch --compartment-id "$COMPARTMENT" --availability-domain "$ad" \
        --display-name "$NAME" --hostname-label "$NAME" --shape "$shape" ${shape_args[@]+"${shape_args[@]}"} \
        --image-id "$image" --boot-volume-size-in-gbs "$BOOT_VOLUME_GB" --subnet-id "$SUBNET_ID" \
        --assign-public-ip true --user-data-file "$user_data" ${ssh_args[@]+"${ssh_args[@]}"} \
        --freeform-tags "$tags" 2>"$WORK/err"); then
        INSTANCE_ID=$(data_id <<<"$out")
        if wait_instance "$INSTANCE_ID" RUNNING; then
          log "Instance: created $INSTANCE_ID ($shape)"
          return 0
        fi
        log "  the launch in $ad failed (instance terminated), trying the next one."
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
  done
  die "no Always Free capacity in any availability domain of $OCI_REGION right now. Oracle frees capacity over time: run the deploy again later (the network is kept, a re-run only retries the instance)."
}

public_ip_of() {
  local ip deadline=$((SECONDS + 300))
  while :; do
    ip=$(oci_ compute instance list-vnics --instance-id "$1" | jq -r '[.data[]?["public-ip"] // empty][0] // empty')
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

# --- relay checks -------------------------------------------------------------------------------

# curl that keeps the URL (it may hold the token) out of the process list and logs.
curl_url() {
  local url=$1
  shift
  printf 'url = "%s"\n' "$url" | curl -fsS --max-time 15 "$@" -K -
}

wait_relay() {
  local host=$1 deadline=$((SECONDS + RELAY_WAIT_SECONDS)) next_note=0
  if ((dry_run)); then
    log "(dry run: would wait up to ${RELAY_WAIT_SECONDS}s for https://$host/ to answer)"
    return 0
  fi
  if ((${REBOOTED:-0})); then
    # Don't take the old relay's last answers for the new one: wait (up to 3 min) until it goes down.
    local down=$((SECONDS + 180))
    while ((SECONDS < down)) && curl_url "https://$host/" -o /dev/null 2>/dev/null; do
      sleep 5
    done
  fi
  log "Waiting for https://$host/ (first boot installs packages and gets a certificate: 5–10 min)…"
  until curl_url "https://$host/" -o /dev/null 2>/dev/null; do
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
  if info=$(curl_url "https://$host/$RELAY_TOKEN/v1/info" 2>/dev/null); then
    log "Relay answers: $(jq -r '"\(.name) \(.version)"' <<<"$info" 2>/dev/null || echo ok)"
  else
    log "warning: the relay answers but rejects RELAY_TOKEN: it was created with another token."
    log "Run the destroy action, then deploy again, to use the current RELAY_TOKEN."
  fi
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

deploy() {
  render_cloud_init >"$WORK/user-data"
  if ((dry_run)); then
    log "--- cloud-init user-data (token masked) ---"
    mask <"$WORK/user-data" >&2
    log "--- end of user-data ---"
  fi
  local config_tag ids
  # Fingerprint of everything that only applies at launch, to tell when a re-run can't apply it.
  config_tag=$({ cat "$WORK/user-data"; printf '%s\n' "$OCI_SSH_PUBLIC_KEY"; } | sha256 | cut -c1-16)

  check_home_region
  ensure_network
  ids=$(find_instances)
  INSTANCE_ID=$(first_line <<<"$ids")
  if [[ -n $INSTANCE_ID ]]; then
    if (($(wc -l <<<"$ids") > 1)); then
      log "warning: several $NAME instances exist, using $INSTANCE_ID"
    fi
    log "Instance: reusing $INSTANCE_ID"
    local tag
    tag=$(oci_ compute instance get --instance-id "$INSTANCE_ID" | jq -r '.data["freeform-tags"].config // empty')
    if [[ $tag != "$config_tag" ]]; then
      log "Note: RELAY_TOKEN, RELAY_HOST, OCI_SSH_PUBLIC_KEY or the VM setup (e.g. ffmpeg for video"
      log "conversion) changed since this instance was created. Those apply only to a new instance:"
      log "run destroy, then deploy, to apply them."
    fi
    restart_instance "$INSTANCE_ID"
  else
    launch_instance "$WORK/user-data" "$config_tag"
  fi

  local ip host
  ip=$(public_ip_of "$INSTANCE_ID")
  host=${RELAY_HOST:-${ip//./-}.sslip.io}
  log "Public IP: $ip"
  if [[ -n $RELAY_HOST ]]; then
    log "RELAY_HOST is $RELAY_HOST: its DNS A record must point at $ip for the certificate."
  fi
  local ready=0
  wait_relay "$host" && ready=1

  local summary
  summary=$(
    cat <<EOF
Host:      $host
Relay URL: https://$host/<your RELAY_TOKEN>
Open https://$host/ (the app, served by the relay) or the hosted app, and paste the relay URL
into its relay setting (the "Relay" button).
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
    oci_ compute instance terminate --instance-id "$id" --preserve-boot-volume false --force \
      --wait-for-state TERMINATED --max-wait-seconds 1200 >/dev/null
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
