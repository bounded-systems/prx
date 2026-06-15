#!/usr/bin/env bash
set -euo pipefail

# prx-62h — verify (and optionally provision) the aarch64-linux nix remote
# builder that the OCI fleet images offload to.
#
# Flavor B of docs/prx/claude-runtime.md: a Lima VM registered as a nix remote
# builder, so `nix build` of aarch64-linux/OCI artifacts (prx-634 beadsd-box,
# prx-anj keeperd-box) offloads INTO the VM from a kernel-less macOS host.
#
# This script is the OPERATOR companion to `prx lima provision-builder`: the
# prx verb renders the /etc/nix/machines line (pure, in-repo, testable); this
# script performs the privileged host steps prx deliberately does NOT do —
# register the line, set nix.conf, restart the daemon — and runs the acceptance
# smoke test.
#
# Usage:
#   prx62h-builder.sh                 # verify only (safe, read-mostly)
#   prx62h-builder.sh <lima-vm> [N]   # provision <lima-vm> (N jobs, default 8),
#                                     # register it, then verify
#
# Verify-only forces every build to a remote builder (--max-jobs 0) and builds a
# trivial aarch64-linux derivation: if it resolves on an `ssh://` builder and
# copies back, prx-62h's acceptance is met. Provisioning edits /etc/nix/machines
# and /etc/nix/nix.conf (needs sudo) and restarts the nix-daemon.

MACHINES=/etc/nix/machines
NIX_CONF=/etc/nix/nix.conf
VM="${1:-}"
MAX_JOBS="${2:-8}"

# A trivial aarch64-linux build, forced onto a remote builder. `--rebuild` makes
# the build actually run every invocation (not serve a cached path), so each run
# genuinely exercises the builder; `--max-jobs 0` forbids local building. The
# build log names the `ssh://` builder it ran on.
smoke() {
  nix build --impure --no-link --print-out-paths --max-jobs 0 --rebuild \
    --expr 'derivation {
      name = "prx62h-smoke";
      system = "aarch64-linux";
      builder = "/bin/sh";
      args = [ "-c" "echo prx62h-ok > $out" ];
    }'
}

echo "→ prx-62h: smoke-building aarch64-linux on a remote builder…"
if out="$(smoke 2>&1)"; then
  echo "$out" | grep -qE "on 'ssh" && echo "  $(echo "$out" | grep -E "on 'ssh" | head -1)"
  echo "✓ prx-62h acceptance met — aarch64-linux builds offload to a remote builder."
  exit 0
fi

echo "✗ no working aarch64-linux remote builder."
if [ -z "$VM" ]; then
  echo "  Pass a Lima VM to provision one:  $0 <lima-vm> [max-jobs]"
  echo "  (the VM must be reachable over ssh as the host's nix builder)"
  exit 1
fi

echo "→ provisioning Lima VM '$VM' as a nix remote builder…"
line="$(prx lima provision-builder "$VM" --max-jobs "$MAX_JOBS")"
echo "  machines line: $line"

echo "→ registering it in $MACHINES (idempotent)…"
sudo touch "$MACHINES"
if ! grep -qxF "$line" "$MACHINES"; then
  echo "$line" | sudo tee -a "$MACHINES" >/dev/null
fi

echo "→ ensuring 'builders = @$MACHINES' in $NIX_CONF…"
if ! nix config show 2>/dev/null | grep -qE "^builders = @$MACHINES"; then
  echo "builders = @$MACHINES" | sudo tee -a "$NIX_CONF" >/dev/null
fi

echo "→ restarting the nix-daemon…"
sudo launchctl kickstart -k system/org.nixos.nix-daemon 2>/dev/null \
  || sudo systemctl restart nix-daemon 2>/dev/null \
  || echo "  (could not restart the daemon automatically — restart it by hand)"

echo "→ re-running the smoke test…"
if smoke >/dev/null 2>&1; then
  echo "✓ prx-62h acceptance met — '$VM' now serves aarch64-linux builds."
else
  echo "✗ still failing after provisioning. Check: ssh to '$VM', the machines"
  echo "  line in $MACHINES, and that nix-daemon picked up the new config."
  exit 1
fi
