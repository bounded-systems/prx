# The ghappd-box OCI image (prx-36xr) — the container image that fills
# `room/ghappd-room.ts` in the per-repo pod (prx-zj8). ghappd is the GitHub App
# credential-broker door: `prx ghapp serve` exposes the `github-app:token` door
# so a claude-room can LEASE short-lived installation tokens without ever holding
# the App private key (ocap; see ghappd/daemon.ts + GHAPPD.md).
#
# THE CARE-ABOUT: the GitHub App PRIVATE KEY is a RUNTIME SECRET — never baked
# into the image or a plaintext layer. The pod mounts it via a podman secret onto
# a tmpfs path (default `/run/secrets/ghapp-key`); the entrypoint points
# PRX_GH_APP_KEY_FILE at that file and the daemon reads it IN-PROCESS. The PEM
# never enters the process env or argv — only the path does (stronger than the
# keeperd-box pattern, which cats its key into an env var). The (non-secret) App
# id and installation id are read the same way from `/run/secrets/ghapp-id` and
# `/run/secrets/ghapp-installation` — so this one image serves ANY bucket app
# (forge / projects / …): the mounts pick the bucket. Unmounted ⇒ the door still
# serves but every lease replies error (loud at lease time, by design).
#
# Build (offloads to the prx-62h linux builder from a macOS host):
#   nix build .#packages.aarch64-linux.ghappd-box
self:
{ pkgs, system ? pkgs.stdenv.hostPlatform.system }:
let
  # prx via ./prx-fhs.nix: the released `bun --compile` binary, wrapped to invoke
  # the nix glibc loader so it runs in a from-scratch image. { prx; version; }.
  bins = import ./prx-fhs.nix self { inherit pkgs system; };

  # Entrypoint: point the daemon at the mounted secret (path only — the PEM is
  # never read into env/argv), pass through the App id + installation id from
  # their mounts if present, then serve. All mounts optional; absent ⇒ leases
  # reply error. The id/installation mounts are what select the bucket app.
  entrypoint = pkgs.writeShellScriptBin "ghappd-box-entrypoint" ''
    set -eu
    key_file="''${PRX_GH_APP_KEY_FILE:-/run/secrets/ghapp-key}"
    [ -f "$key_file" ] && export PRX_GH_APP_KEY_FILE="$key_file"
    id_file="''${PRX_GH_APP_ID_FILE:-/run/secrets/ghapp-id}"
    if [ -f "$id_file" ]; then
      PRX_GH_APP_ID="$(cat "$id_file")"
      export PRX_GH_APP_ID
    fi
    inst_file="''${PRX_GH_INSTALLATION_ID_FILE:-/run/secrets/ghapp-installation}"
    if [ -f "$inst_file" ]; then
      PRX_GH_INSTALLATION_ID="$(cat "$inst_file")"
      export PRX_GH_INSTALLATION_ID
    fi
    exec /bin/prx ghapp serve --socket /run/prx/doors/ghappd.sock "$@"
  '';
in
pkgs.dockerTools.streamLayeredImage {
  name = "ghappd-box";
  tag = bins.version;

  contents = [
    bins.prx
    entrypoint
    # ghappd only talks HTTPS to api.github.com — cacert for TLS, no git/ssh.
    pkgs.cacert
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
    Entrypoint = [ "/bin/ghappd-box-entrypoint" ];
    Env = [
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "HOME=/home/prx"
    ];
    WorkingDir = "/work";
    Labels = {
      # Deterministically link the ghcr package to this repo (+ provenance) so the
      # repo's Actions own + can push it — explicit, not implicit auto-link.
      "org.opencontainers.image.source" = "https://github.com/bounded-systems/prx";
      "dev.prx.room" = "ghappd-room";
      "dev.prx.image" = "ghappd-box";
    };
  };
}
