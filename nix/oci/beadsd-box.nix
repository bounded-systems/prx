# The beadsd-box OCI image (prx-634) — the container image that fills
# `room/beadsd-room.ts` in the per-repo pod (prx-zj8 / prx-asr).
#
# A pinned `dockerTools.streamLayeredImage`: its digest is the sha we pin to,
# per docs/prx/claude-runtime.md. Contents:
#   - prx   — our released aarch64-linux binary (beadsd is `prx beads serve`).
#   - bd    — built from source (./bd.nix), not a downloaded prebuilt.
#   - dolt  — from nixpkgs; the client that talks to the EXTERNAL dolt (the
#             dolt-box / DoltHub remote) — "connect-to-external-dolt".
#   - git + cacert — bd derives identity from the git origin and clones/syncs the
#             dolt remote over TLS (see beadsd/provision.ts).
#
# The image is the artifact; the pod (prx-asr) supplies the runtime specifics —
# the dolt clone dir (`--cwd`) and the external-dolt endpoint. The door socket
# matches room/beadsd-room.ts (`/run/prx/doors/beadsd.sock`).
#
# Build (offloads to the prx-62h linux builder from a macOS host):
#   nix build .#packages.aarch64-linux.beadsd-box
self:
{ pkgs, system ? pkgs.stdenv.hostPlatform.system }:
let
  bins = import ../fetch-release.nix self { inherit pkgs system; };
  bd = import ./bd.nix { inherit pkgs; };
in
pkgs.dockerTools.streamLayeredImage {
  name = "beadsd-box";
  tag = bins.version;

  contents = [
    bins.prx
    bd
    pkgs.dolt
    # gitMinimal: bd only needs `git init`/`git remote add` (beadsd/provision.ts)
    # — drops git's perl/tcl/send-email closure (HTML-TagCloud & friends).
    pkgs.gitMinimal
    pkgs.cacert
    pkgs.coreutils
    pkgs.bashInteractive
  ];

  config = {
    # beadsd = `prx beads serve`, which shells to bd + dolt. The pod appends the
    # clone dir (`--cwd`) and any external-dolt endpoint; this is the door the
    # claude-room consumes (room/beadsd-room.ts).
    Entrypoint = [ "/bin/prx" "beads" "serve" ];
    Cmd = [ "--socket" "/run/prx/doors/beadsd.sock" ];
    Env = [
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "GIT_SSL_CAINFO=/etc/ssl/certs/ca-bundle.crt"
    ];
    WorkingDir = "/work";
    Labels = {
      "dev.prx.room" = "beadsd-room";
      "dev.prx.image" = "beadsd-box";
    };
  };
}
