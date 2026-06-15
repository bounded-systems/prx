# nix/beadsd-box.nix — the beadsd-box OCI image (prx-634, epic prx-zj8).
#
# A pinned `dockerTools` image running the beads daemon foreground as PID 1:
#   prx beads serve --socket /run/prx/doors/beadsd.sock --cwd /var/lib/prx/beads
#
# `prx beads serve` (runBeadsServe, packages/prx/src/beadsd/daemon.ts) binds the
# socket and holds the listening Server in the foreground, so it is a valid
# container entrypoint — no init wrapper. The daemon shells out to `bd` (which
# orchestrates `bd dolt …`) and queries `dolt sql` directly for schema
# resolution; both binaries are in the image.
#
# Linux-only (dockerTools). On a darwin host, build via the registered linux
# remote builder:  nix build .#packages.aarch64-linux.beadsd-box
#
# Runs as root for now (the dockerTools default); non-root hardening + volume
# ownership land with pod assembly (prx-asr) and the isolation tier (prx-5p5),
# where the door tmpfs and beads state volume define their own ownership.
{ pkgs, prx, bd, version }:
let
  # The released prx/bd binaries are dynamically linked against a /lib FHS
  # dynamic loader, which a minimal dockerTools image lacks. autoPatchelf
  # repoints their interpreter + rpath at nix's glibc/libstdc++ so they run in
  # the image. (dolt is nix-built and already store-patched.)
  fhsBins = pkgs.runCommand "beadsd-box-bins"
    {
      nativeBuildInputs = [ pkgs.autoPatchelfHook ];
      buildInputs = [ pkgs.stdenv.cc.cc.lib pkgs.glibc ];
    } ''
    mkdir -p "$out/bin"
    install -m755 ${prx}/bin/prx "$out/bin/prx"
    install -m755 ${bd}/bin/bd "$out/bin/bd"
    autoPatchelf "$out/bin"
  '';
in
pkgs.dockerTools.buildLayeredImage {
  name = "beadsd-box";
  tag = version;
  contents = [
    fhsBins # patched prx + bd
    pkgs.dolt # bd shells `bd dolt …`; the daemon also queries `dolt sql` directly
    pkgs.git # repo ops behind bd/dolt
    pkgs.cacert # TLS roots for dolt remote sync
    pkgs.coreutils
    pkgs.bashInteractive # debug shell: `podman run --entrypoint bash …`
    pkgs.dockerTools.fakeNss # /etc/passwd + nsswitch — dolt/git need a uid-0 entry
  ];
  # Mount points: /run/prx/doors is the shared door tmpfs (the socket lands
  # here); /var/lib/prx/beads is the served dolt-backed beads clone.
  extraCommands = ''
    mkdir -p ./run/prx/doors ./var/lib/prx/beads ./tmp
    chmod 0777 ./run/prx/doors ./tmp
  '';
  config = {
    Entrypoint = [
      "prx"
      "beads"
      "serve"
      "--socket"
      "/run/prx/doors/beadsd.sock"
      "--cwd"
      "/var/lib/prx/beads"
      "--pidfile"
      "/run/prx/beadsd.pid"
    ];
    Env = [
      "PATH=/bin"
      "HOME=/var/lib/prx/beads" # dolt/git config dir; must be writable (the volume)
      "PRX_BEADS_CWD=/var/lib/prx/beads"
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
    ];
    WorkingDir = "/var/lib/prx/beads";
    Volumes = { "/var/lib/prx/beads" = { }; };
  };
}
