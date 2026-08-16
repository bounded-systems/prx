# The dolt-box OCI image (prx-zj8) — the per-repo dolt SQL server as a pinned
# container, the third OCI fleet image after beadsd-box (prx-634) and keeperd-box
# (prx-anj).
#
# Unlike the other boxes, dolt-box is NOT a unix-socket door member: it serves
# the MySQL wire protocol on a TCP port, which beadsd-box's dolt client reaches
# over the pod network ("connect-to-external-dolt"). So there is no dolt-room
# (the room model is for door-exposing members); dolt-box is a backing service.
#
# STATE — the dolt database is a NAMED VOLUME mounted at `$DOLT_DATA_DIR`
# (default /var/lib/dolt), never baked into a layer. The pod (prx-asr) supplies
# the volume (migrated from the Lima VM or re-cloned from the DoltHub remote).
#
# ARCHITECTURE NOTE (for prx-asr): today `prx dolt start` delegates to
# `bd dolt start` — bd owns the co-located dolt lifecycle (a competing server
# hits "database is locked"). The pod model inverts this: dolt-box owns the
# server, and beadsd-box's bd must CONNECT to it (server-mode, external host),
# not start its own. Wiring that decoupling is prx-asr's job; this is just the
# server image.
#
# Build (offloads to the prx-62h linux builder from a macOS host):
#   nix build .#packages.aarch64-linux.dolt-box
self:
{ pkgs, system ? pkgs.stdenv.hostPlatform.system }:
let
  # Serve the named-volume data dir on all interfaces (the pod network reaches
  # it) at the port bd's bootstrap probes (3307). HOME is set into a writable
  # path so dolt's global config never tries to write a read-only layer.
  entrypoint = pkgs.writeShellScriptBin "dolt-box-entrypoint" ''
    set -eu
    data_dir="''${DOLT_DATA_DIR:-/var/lib/dolt}"
    port="''${DOLT_PORT:-3307}"
    mkdir -p "$data_dir"
    export HOME="$data_dir"
    exec ${pkgs.dolt}/bin/dolt sql-server \
      --data-dir "$data_dir" --host 0.0.0.0 --port "$port" "$@"
  '';
in
pkgs.dockerTools.streamLayeredImage {
  name = "dolt-box";
  tag = pkgs.dolt.version;

  contents = [
    pkgs.dolt
    entrypoint
    pkgs.cacert
    pkgs.coreutils
    pkgs.bashInteractive
  ];

  config = {
    Entrypoint = [ "/bin/dolt-box-entrypoint" ];
    ExposedPorts = { "3307/tcp" = { }; };
    Env = [
      "DOLT_DATA_DIR=/var/lib/dolt"
      "DOLT_PORT=3307"
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
    ];
    # The dolt database is runtime state — a named volume, not a baked layer.
    Volumes = { "/var/lib/dolt" = { }; };
    WorkingDir = "/var/lib/dolt";
    Labels = {
      "dev.prx.image" = "dolt-box";
    };
  };
}
