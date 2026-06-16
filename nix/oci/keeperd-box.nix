# The keeperd-box OCI image (prx-anj) — the container image that fills
# `room/keeperd-room.ts` in the per-repo pod (prx-zj8 / prx-asr).
#
# keeperd is the git-write daemon: `prx keeper serve` exposes the `git:write`
# door (commit/push, signed) so claude-room can request signed git writes
# without holding git authority itself (ocap).
#
# THE CARE-ABOUT (prx-anj): the keeper provenance SIGNING KEY is a RUNTIME
# SECRET — never baked into the image or a plaintext layer. The pod mounts it
# via a podman secret onto a tmpfs path (default `/run/secrets/keeper-key`); the
# entrypoint reads that file into `PRX_PROVENANCE_KEY` (the env the keeper signs
# from, see keeperd/daemon.ts + lima-keeperd.ts) at start, then execs the
# daemon. The key lives only in the running process env, never on disk in a
# layer. Override the path with PRX_PROVENANCE_KEY_FILE.
#
# Build (offloads to the prx-62h linux builder from a macOS host):
#   nix build .#packages.aarch64-linux.keeperd-box
self:
{ pkgs, system ? pkgs.stdenv.hostPlatform.system }:
let
  # prx via ./prx-fhs.nix: the released `bun --compile` binary can't run in a
  # from-scratch image as-is — it's wrapped to invoke the nix glibc loader
  # directly (see prx-fhs.nix). Drop-in for fetch-release.nix; same { prx; version; }.
  bins = import ./prx-fhs.nix self { inherit pkgs system; };

  # Entrypoint: load the signing key from the mounted secret (if present) into
  # PRX_PROVENANCE_KEY, then serve. The key is never written to a layer — it is
  # read from the runtime tmpfs mount into the process env only.
  entrypoint = pkgs.writeShellScriptBin "keeperd-box-entrypoint" ''
    set -eu
    key_file="''${PRX_PROVENANCE_KEY_FILE:-/run/secrets/keeper-key}"
    if [ -f "$key_file" ]; then
      PRX_PROVENANCE_KEY="$(cat "$key_file")"
      export PRX_PROVENANCE_KEY
    fi
    exec /bin/prx keeper serve --socket /run/prx/doors/keeperd.sock "$@"
  '';
in
pkgs.dockerTools.streamLayeredImage {
  name = "keeperd-box";
  tag = bins.version;

  contents = [
    bins.prx
    entrypoint
    # keeper does real git writes (commit/push); gitMinimal + openssh (ssh push)
    # + cacert (https). Push credentials, like the signing key, are runtime
    # secrets the pod supplies — not baked here.
    pkgs.gitMinimal
    pkgs.openssh
    pkgs.cacert
    pkgs.coreutils
    pkgs.bashInteractive
    # /etc/passwd + nsswitch — prx (Bun `os.homedir()` → uv_os_homedir) and
    # git resolve the user; without it prx crashes at startup with
    # `ENOENT … uv_os_homedir`.
    pkgs.dockerTools.fakeNss
  ];

  # A writable HOME for prx (config/cache) + the door-socket dir.
  extraCommands = ''
    mkdir -p ./tmp ./home/prx ./run/prx/doors
    chmod 1777 ./tmp
  '';

  config = {
    Entrypoint = [ "/bin/keeperd-box-entrypoint" ];
    Env = [
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "GIT_SSL_CAINFO=/etc/ssl/certs/ca-bundle.crt"
      "HOME=/home/prx"
    ];
    WorkingDir = "/work";
    Labels = {
      "dev.prx.room" = "keeperd-room";
      "dev.prx.image" = "keeperd-box";
    };
  };
}
