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

case_ "destroy: the instance terminates (own polling, no CLI wait), then the network goes"
run 0 --destroy
has "+ oci compute instance terminate --instance-id ocid1.instance.oc1.dryrun-existing --preserve-boot-volume false --force"
lacks "terminate --instance-id ocid1.instance.oc1.dryrun-existing --preserve-boot-volume false --force --wait-for-state"
has "Oracle accepted the termination (work request ocid1.coreservicesworkrequest.oc1.dryrun)."
has "Everything webtor-relay created is gone."

case_ "destroy, slow termination: waits while TERMINATING, then 404 = gone"
run 0 --destroy -- DRY_RUN_TERMINATE=slow
has "instance is TERMINATING, waiting…"
has "instance ocid1.instance.oc1.dryrun-existing is terminated."
has "Everything webtor-relay created is gone."

case_ "destroy, termination outlasts the wait: stops with the next step, network kept"
run 1 --destroy -- DRY_RUN_TERMINATE=stuck TERMINATE_WAIT_SECONDS=60
has "Oracle accepted the termination of instance ocid1.instance.oc1.dryrun-existing, but it is still TERMINATING after 1 min."
has "run the destroy (or deploy) again once the OCI Console (Compute → Instances) shows it Terminated."
has "error: destroy stopped: Oracle is still terminating instance ocid1.instance.oc1.dryrun-existing"
lacks "subnet delete"

case_ "destroy re-run while the instance is still TERMINATING: waits for it, then deletes the rest"
run 0 --destroy -- DRY_RUN_EXISTING_STATE=TERMINATING
has "is already TERMINATING (an earlier run or the OCI Console started it): waiting for it…"
lacks "compute instance terminate"
has "Deleted VCN ocid1.vcn.oc1.dryrun"

case_ "destroy, the CLI rejects the terminate (oci-cli 3.95.0 and --wait-for-state TERMINATED): says so, VM still RUNNING"
run 1 --destroy -- DRY_RUN_TERMINATE=rejected
has "  | Error: Invalid value for '--wait-for-state': invalid choice: TERMINATED."
has "rejected this command as invalid (exit 2): nothing was sent to Oracle."
has "requesting its termination once more…"
has "error: destroy stopped: the relay VM ocid1.instance.oc1.dryrun-existing is still RUNNING, it was NOT terminated. Why: the OCI CLI (dry run) rejected the terminate command as invalid"
lacks "Deleted the reserved public IP"

case_ "destroy, Oracle accepts but the VM stays RUNNING: work request errors, one retry, then the reason"
run 1 --destroy -- DRY_RUN_TERMINATE=ignored
has "work request ocid1.coreservicesworkrequest.oc1.dryrun: FAILED (TerminateInstance, 0 % done)"
has "its errors: InternalError: dry run: the termination failed"
has "still RUNNING a minute after the terminate request: requesting it once more…"
has "is still RUNNING, it was NOT terminated. Why: Oracle's terminate work request reports: InternalError: dry run: the termination failed."

case_ "destroy, the CLI's delete waits time out (exit 2): logged, destroy carries on"
run 0 --destroy -- DRY_RUN_WAIT_TIMEOUT=1
has "the OCI CLI gave up waiting (exit 2) for: oci network public-ip delete (the request itself was accepted)."
has "subnet ocid1.subnet.oc1.dryrun: Oracle goes on deleting it."
has "Oracle is still deleting: the reserved public IP ocid1.publicip.oc1.dryrun-reserved, subnet"

case_ "deploy right after a destroy, the old VM still TERMINATING: waits for it before the storage check"
run 0 --deploy -- DRY_RUN_EXISTING_STATE=TERMINATING
has "(an earlier relay VM) is still TERMINATING: its boot volume counts against the free"
has "instance ocid1.instance.oc1.dryrun-existing is terminated."
has "take 0 of the 200 GB Always Free storage: none"
has "compute instance launch"

case_ "deploy, the old VM never finishes terminating: says to retry in a few minutes"
run 1 --deploy -- DRY_RUN_EXISTING_STATE=TERMINATING DRY_RUN_TERMINATE=stuck TERMINATE_WAIT_SECONDS=30
has "error: the old relay VM ocid1.instance.oc1.dryrun-existing and its disk are still being deleted at Oracle. Run the deploy again in a few minutes."
lacks "compute instance launch"

case_ "upgrade, the old VM is slow to terminate: the new relay serves, warning only"
run 0 --deploy --upgrade -- DRY_RUN_EXISTING_SHAPE=$MICRO DRY_RUN_TERMINATE=stuck TERMINATE_WAIT_SECONDS=30
has "warning: the new relay serves; Oracle is still terminating the old VM"

case_ "upgrade, the old VM is not terminated: says so, with the reason"
run 1 --deploy --upgrade -- DRY_RUN_EXISTING_SHAPE=$MICRO DRY_RUN_TERMINATE=ignored
has "error: the new relay serves, but the old VM ocid1.instance.oc1.dryrun-existing was NOT terminated: it is still RUNNING (Oracle's terminate work request reports"

# Every OCI call of these dry runs, run through the installed OCI CLI against an endpoint that
# refuses connections: an option this CLI version doesn't take is a usage error (exit 2, "Usage:"
# on stdout) before any request. That is how `instance terminate --wait-for-state TERMINATED` failed
# with oci-cli 3.95.0 (it takes work-request states there). Skipped without `oci` on PATH:
# pipx install oci-cli==<the version .github/workflows/deploy-relay-oci.yml installs>.
cli_check() {
  local dir calls cfg key f a args sum pinned have n=0 bad=0 rc out ssh
  pinned=$(grep -oE 'oci-cli==[0-9.]+' .github/workflows/deploy-relay-oci.yml | cut -d= -f3)
  if ! command -v oci >/dev/null; then
    case_ "OCI CLI check: skipped (no oci on PATH; pipx install oci-cli==$pinned)"
    return 0
  fi
  have=$(oci --version 2>/dev/null)
  case_ "OCI CLI check: every call of the dry runs, against oci-cli $have"
  [[ $have == "$pinned" ]] || printf '  note: the workflow installs oci-cli %s\n' "$pinned"
  dir=$(mktemp -d)
  calls=$dir/calls
  mkdir "$calls"
  ssh="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDryRunDryRunDryRunDryRunDryRunDryRunDryRunDr dry@run"
  run 0 --deploy -- DRY_RUN_CLI_LOG="$calls" OCI_SSH_PUBLIC_KEY="$ssh" DRY_RUN_EXISTING_STATE=TERMINATING
  run 0 --deploy -- DRY_RUN_CLI_LOG="$calls" DRY_RUN_EXISTING_SHAPE=$MICRO DRY_RUN_EXISTING_RESERVED=free
  run 0 --deploy --upgrade -- DRY_RUN_CLI_LOG="$calls" DRY_RUN_EXISTING_SHAPE=$MICRO DRY_RUN_EXISTING_RESERVED=1 DRY_RUN_USED_GB=50,20
  run 1 --deploy --upgrade -- DRY_RUN_CLI_LOG="$calls" DRY_RUN_EXISTING_SHAPE=$MICRO DRY_RUN_EXISTING_RESERVED=1 DRY_RUN_FAIL_MOVE=1
  run 0 --deploy -- DRY_RUN_CLI_LOG="$calls" DRY_RUN_NO_A1=1 RELAY_ALLOW_PAID=1
  run 0 --destroy -- DRY_RUN_CLI_LOG="$calls"
  run 1 --destroy -- DRY_RUN_CLI_LOG="$calls" DRY_RUN_TERMINATE=ignored
  cfg=$dir/config
  key=$dir/key.pem
  openssl genrsa -out "$key" 2048 2>/dev/null
  printf '[DEFAULT]\nuser=ocid1.user.oc1..check\nfingerprint=%s\ntenancy=ocid1.tenancy.oc1..check\nregion=eu-frankfurt-1\nkey_file=%s\n' \
    "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00" "$key" >"$cfg"
  chmod 600 "$cfg" "$key"
  printf 'dry run\n' >"$dir/file"
  : >"$dir/seen"
  for f in "$calls"/call.*; do
    sum=$(cksum <"$f")
    if grep -qxF "$sum" "$dir/seen"; then
      continue
    fi
    printf '%s\n' "$sum" >>"$dir/seen"
    args=()
    while IFS= read -r -d '' a; do
      # The dry run's user-data and SSH key files are gone: the CLI checks that a file exists.
      case $a in
      */user-data | */ssh.pub) a=$dir/file ;;
      esac
      args+=("$a")
    done <"$f"
    n=$((n + 1))
    rc=0
    out=$(OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING=True SUPPRESS_LABEL_WARNING=True oci --config-file "$cfg" \
      --no-retry --endpoint http://127.0.0.1:9 --output json "${args[@]}" </dev/null 2>/dev/null) || rc=$?
    if ((rc == 2)) && grep -q '^Usage: ' <<<"$out"; then
      bad=1
      fail "the OCI CLI rejects: oci ${args[*]}"
      grep -m1 '^Error: ' <<<"$out" | sed 's/^/    /'
    fi
  done
  rm -rf "$dir"
  ((bad)) || printf '  %d distinct calls, none rejected\n' "$n"
}
cli_check

if ((failed)); then
  echo "deploy-relay-oci.test: FAILED"
  exit 1
fi
echo "deploy-relay-oci.test: all passed"
