# The concierged-box OCI image (prx-8uf2 / prx-9s14) — the container image that
# fills `room/concierged-room.ts` in the per-repo pod. concierged is the grant
# BROKER door: `prx concierge serve` exposes the `grant:broker` door so in-pod
# boxes can `register` what they serve and `resolve` a capability to a SIGNED
# grant they present to a serving room's tcp/vsock gate (see concierge/daemon.ts).
#
# THE CARE-ABOUT: the door-authority PROVENANCE MASTER is a RUNTIME SECRET —
# never baked into the image. The pod mounts it via a podman secret onto a tmpfs
# path (default `/run/secrets/provenance-master`); the entrypoint points
# PRX_PROVENANCE_MASTER_FILE at that file and the daemon derives the door
# authority's per-actor key from it IN-PROCESS (the master never enters argv).
# `resolve` signs grants with that key; `keys` publishes its public half — the
# SAME key the serving doors verify against. Unmounted ⇒ the daemon falls back to
# the dev seed (resolveProvenanceMaster), so it still serves for local/dev runs.
#
# No network: concierged is local + unix only (no HTTPS, no git/ssh), so no
# cacert — unlike forge-d-box which talks to api.github.com.
#
# RELEASE DEPENDENCY: the box packages the RELEASED prx (fetch-release.nix), so a
# WORKING image needs a prx release that includes `prx concierge serve` (#853) —
# i.e. the publish must run AFTER prx is released past v0.19.0. Building from an
# older release yields a box whose entrypoint's `concierge serve` verb is absent.
#
# Build (offloads to the prx-62h linux builder from a macOS host):
#   nix build .#packages.aarch64-linux.concierged-box
self:
{ pkgs, system ? pkgs.stdenv.hostPlatform.system }:
let
  # prx via ./prx-fhs.nix: the released `bun --compile` binary, wrapped to invoke
  # the nix glibc loader so it runs in a from-scratch image. { prx; version; }.
  bins = import ./prx-fhs.nix self { inherit pkgs system; };

  # Entrypoint: point the daemon at the mounted master secret (path only — the
  # master never enters argv), then serve. The mount is optional; absent ⇒ the
  # daemon uses the dev seed (resolveProvenanceMaster fallback). The renderer
  # appends `--socket <doorDir>/concierged.sock` for the exposed door, so the
  # baked default below is overridden onto the shared fabric at run time.
  entrypoint = pkgs.writeShellScriptBin "concierged-box-entrypoint" ''
    set -eu
    master_file="''${PRX_PROVENANCE_MASTER_FILE:-/run/secrets/provenance-master}"
    [ -f "$master_file" ] && export PRX_PROVENANCE_MASTER_FILE="$master_file"
    exec /bin/prx concierge serve --socket /run/prx/doors/concierged.sock "$@"
  '';
in
pkgs.dockerTools.streamLayeredImage {
  name = "concierged-box";
  tag = bins.version;

  contents = [
    bins.prx
    entrypoint
    pkgs.coreutils
    pkgs.bashInteractive
    # /etc/passwd + nsswitch — prx (Bun os.homedir() → uv_os_homedir) resolves
    # the user; without it prx crashes at startup with ENOENT … uv_os_homedir.
    pkgs.dockerTools.fakeNss
  ];

  # A writable HOME for prx (config/cache) + the door-socket dir.
  extraCommands = ''
    mkdir -p ./tmp ./home/prx ./run/prx/doors
    chmod 1777 ./tmp
  '';

  config = {
    Entrypoint = [ "/bin/concierged-box-entrypoint" ];
    Env = [
      "HOME=/home/prx"
    ];
    WorkingDir = "/work";
    Labels = {
      # Deterministically link the ghcr package to this repo (+ provenance) so the
      # repo's Actions own + can push it — explicit, not implicit auto-link.
      "org.opencontainers.image.source" = "https://github.com/bounded-systems/prx";
      "dev.prx.room" = "concierged-room";
      "dev.prx.image" = "concierged-box";
    };
  };
}
