# The beads dolt-data build artifact (prx-asr data layer).
#
# The owner steer: the pod's beads data should be a deterministic, build-like
# artifact that SEPARATES network-fetch from copy, so dolt-box is standalone.
# This derivation is the **network-fetch stage**: a fixed-output derivation
# (FOD) that clones the DoltHub remote, pins to a specific commit, and emits a
# content-addressed dolt data dir. The **copy stage** (populate the pod's
# `prx-dolt-data` named volume from this artifact) happens later at pod-provision
# time with NO network — see packages/prx/src/room/dolt-service.ts.
#
# Determinism: the DoltHub remote HEAD moves (it's the live canonical mirror), so
# we pin a COMMIT (`pinnedCommit`) as the anchor — `dolt clone` fetches current
# HEAD, then we `dolt reset --hard` the default branch to the pinned commit and
# `dolt gc` so the store carries only chunks reachable from it (dolt forbids a
# detached HEAD, so reset rather than checkout). Reproducible PER-COMMIT; the
# recursive-NAR `outputHash` pins the exact bytes (bump both together to advance
# the data). FOD ⇒ network is allowed under the sandbox.
#
# Build (offloads to the prx-62h linux builder from a macOS host):
#   nix build .#packages.aarch64-linux.dolt-data
self:
{ pkgs, system ? pkgs.stdenv.hostPlatform.system }:
let
  remote = "doltremoteapi.dolthub.com/bounded-systems/prx";
  database = "io_github_bounded_systems_prx";
  # Determinism anchor — the DoltHub commit this artifact pins (advance with the
  # outputHash together). Captured 2026-06-28 from the canonical clone HEAD.
  pinnedCommit = "bb6ekib413d7lc3r543vj60fh5m53nes";
in
pkgs.stdenvNoCC.mkDerivation {
  name = "dolt-data-${database}";
  nativeBuildInputs = [ pkgs.dolt pkgs.cacert ];

  # FOD: network allowed; output content-addressed by the NAR hash of the tree.
  outputHashMode = "recursive";
  outputHashAlgo = "sha256";
  outputHash = "sha256-NG5HnzeR0c55Dbs7PVVf79uEU4HdMz8FHwg3t66gw8E=";

  SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";

  # No src; the whole build is the clone+pin.
  dontUnpack = true;

  buildPhase = ''
    runHook preBuild
    export HOME="$PWD/.home"
    mkdir -p "$HOME"
    echo "dolt-data: cloning ${remote} (network stage)..."
    # Clone into a dir named for the database — dolt sql-server --data-dir serves
    # each immediate subdir-with-.dolt as a database by that dir name, and beadsd
    # connects to `${database}`.
    dolt clone ${remote} ${database}
    cd ${database}
    echo "dolt-data: pinning the default branch to commit ${pinnedCommit}..."
    # dolt forbids a detached HEAD; reset the (checked-out default) branch to the
    # pinned commit so the working set + branch point at the anchor.
    dolt reset --hard ${pinnedCommit}
    echo "dolt-data: gc (drop chunks unreachable from the pinned commit)..."
    dolt gc
    cd ..
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    # $out is a DATA-DIR: it holds the database as a subdir, so populating the
    # pod's /var/lib/dolt volume from $out yields /var/lib/dolt/${database}/.dolt.
    mkdir -p "$out/${database}"
    # Normalize local-only state that is not content (working-set pointer, server
    # lock) so the bytes are stable across rebuilds.
    rm -f ${database}/.dolt/repo_state.json ${database}/.dolt/sql-server.lock 2>/dev/null || true
    cp -r ${database}/. "$out/${database}/"
    runHook postInstall
  '';

  meta = {
    description = "Deterministic beads dolt-data artifact (DoltHub clone pinned to ${pinnedCommit})";
  };
}
