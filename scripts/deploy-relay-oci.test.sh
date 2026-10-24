#!/usr/bin/env bash
# Dry-run checks of scripts/deploy-relay-oci.sh (no OCI credentials, no network): runs it with the
# DRY_RUN_* knobs and checks the exit status and the log. Usage: scripts/deploy-relay-oci.test.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

MICRO=VM.Standard.E2.1.Micro
failed=0
out=""

# run <expected exit> <args…> [-- <VAR=value>…]: runs a dry run, keeps its log in $out.
run() {
  local want=$1 args=() vars=() status
  shift
  while (($#)) && [[ $1 != -- ]]; do
    args+=("$1")
    shift
  done
  if (($#)); then
    shift
    vars=("$@")
  fi
  out=$(env ${vars[@]+"${vars[@]}"} scripts/deploy-relay-oci.sh "${args[@]}" --dry-run 2>&1) # bash 3.2: no empty "${a[@]}" under -u
  status=$?
  if ((status != want)); then
    fail "exit $status, expected $want"
  fi
}
fail() {
  printf '  FAIL: %s\n' "$1"
  failed=1
}
has() { grep -qF -- "$1" <<<"$out" || fail "missing: $1"; }
lacks() { ! grep -qF -- "$1" <<<"$out" || fail "unexpected: $1"; }
case_() { printf '%s\n' "$1"; }

case_ "fresh deploy, nothing used: within the free storage"
run 0 --deploy
has "take 0 of the 200 GB Always Free storage: none"
has "makes it 50 GB, within the free storage."

case_ "upgrade, old boot volume 50 + others 150 = 200 GB: only the overlap goes over, proceeds"
run 0 --deploy --upgrade -- DRY_RUN_EXISTING_SHAPE=$MICRO DRY_RUN_USED_GB=100,50
has "take 200 of the 200 GB Always Free storage:"
has "  - webtor-relay (Boot Volume): boot volume, 50 GB, attached to webtor-relay (RUNNING): terminated by this upgrade"
has "  - old-vm-1 (Boot Volume): boot volume, 100 GB, not attached"
has "  - data-2: block volume, 50 GB, not attached"
has "50 GB over the free storage, briefly, until the upgrade terminates the old VM (then 200 GB, free)"
has "about \$0.003 an hour"
has "compute instance launch"
has "Old VM terminated."

case_ "upgrade, others take 160 GB: still over once the old VM is gone, dies"
run 1 --deploy --upgrade -- DRY_RUN_EXISTING_SHAPE=$MICRO DRY_RUN_USED_GB=100,60
has "  - webtor-relay (Boot Volume): boot volume, 50 GB, attached to webtor-relay (RUNNING): terminated by this upgrade"
has "  - data-2: block volume, 60 GB, not attached"
has "error: even after the upgrade terminates the old VM's 50 GB boot volume, the relay's 50 GB boot volume would make it 210 GB, 10 GB over"
has "about \$0.43 a month"
has "Not attached to anything: old-vm-1 (Boot Volume): 100 GB boot volume; data-2: 60 GB block volume."
lacks "compute instance launch"

case_ "upgrade, others take 160 GB, RELAY_ALLOW_PAID=1: proceeds, cost logged"
run 0 --deploy --upgrade -- DRY_RUN_EXISTING_SHAPE=$MICRO DRY_RUN_USED_GB=100,60 RELAY_ALLOW_PAID=1
has "10 GB over the 200 GB Always Free storage. That part is billed: about \$0.43 a month"
has "compute instance launch"

case_ "fresh deploy, 200 GB used: dies, as before, with the volume list"
run 1 --deploy -- DRY_RUN_USED_GB=150,50
has "  - old-vm-1 (Boot Volume): boot volume, 150 GB, not attached"
has "error: the relay's 50 GB boot volume would make it 250 GB, 50 GB over the 200 GB Always Free storage, which is billed (about \$2.12 a month)"
has "or set RELAY_ALLOW_PAID=1 to accept the cost."
lacks "compute instance launch"

case_ "fresh deploy, 200 GB used, RELAY_ALLOW_PAID=1: proceeds, cost logged"
run 0 --deploy -- DRY_RUN_USED_GB=150,50 RELAY_ALLOW_PAID=1
has "50 GB over the 200 GB Always Free storage. That part is billed: about \$2.12 a month"

if ((failed)); then
  echo "deploy-relay-oci.test: FAILED"
  exit 1
fi
echo "deploy-relay-oci.test: all passed"
