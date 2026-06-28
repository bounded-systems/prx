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
  # prx via ./prx-fhs.nix: the released `bun --compile` binary is wrapped to run
  # under the nix glibc loader in a from-scratch image. Drop-in for fetch-release.
  bins = import ./prx-fhs.nix self { inherit pkgs system; };
  bd = import ./bd.nix { inherit pkgs; };

  # connect-to-external-dolt (prx-asr): the repo's `/work/.beads` is bind-mounted
  # and SHARED with host bd, so beadsd must NOT serve (or mutate) it directly.
  # Build a box-local `.beads` copy that points bd at the EXTERNAL dolt-box over
  # the pod netns (server-mode), instead of spawning bd's own dolt on /work:
  #   - drop the local `dolt/` clone + stale lock → force server-mode (verified:
  #     bd connects with metadata only, no local clone — the prx-asr spike);
  #   - set `dolt-server.port` to dolt-box's (default 3307; `PRX_DOLT_PORT`).
  # The metadata (dolt_database, project_id, dolt_mode=server) carries over from
  # /work/.beads unchanged. `"$@"` receives the pod's `--socket` arg override.
  entrypoint = pkgs.writeShellScript "beadsd-box-entrypoint" ''
    set -eu
    cwd=/work
    if [ -d /work/.beads ]; then
      cwd=/beadsd
      rm -rf "$cwd"
      mkdir -p "$cwd"
      cp -r /work/.beads "$cwd/.beads"
      rm -rf "$cwd/.beads/dolt" "$cwd/.beads/dolt-server.lock"
      printf '%s' "''${PRX_DOLT_PORT:-3307}" > "$cwd/.beads/dolt-server.port"
      # bd warns if .beads is group/other-readable; the copy inherits /work's
      # 0755, so tighten to 0700.
      chmod 700 "$cwd/.beads"
    fi
    exec /bin/prx beads serve --cwd "$cwd" "$@"
  '';
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
    # /etc/passwd + nsswitch — prx (Bun `os.homedir()` → uv_os_homedir) and dolt
    # resolve the user; without it prx crashes `ENOENT … uv_os_homedir` and dolt
    # fails `unknown userid 0`.
    pkgs.dockerTools.fakeNss
  ];

  # A writable HOME for prx (config/cache) + the door-socket dir.
  extraCommands = ''
    mkdir -p ./tmp ./home/prx ./run/prx/doors ./beadsd
    chmod 1777 ./tmp
  '';

  config = {
    # beadsd = `prx beads serve`, via the entrypoint wrapper that builds a
    # box-local `.beads` pointing at the external dolt-box (connect-to-external-
    # dolt, prx-asr) before serving `--cwd /beadsd`. Cmd carries the door socket
    # (`"$@"` in the wrapper); the pod overrides it to the shared fabric path.
    Entrypoint = [ "${entrypoint}" ];
    Cmd = [ "--socket" "/run/prx/doors/beadsd.sock" ];
    Env = [
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "GIT_SSL_CAINFO=/etc/ssl/certs/ca-bundle.crt"
      "HOME=/home/prx"
    ];
    WorkingDir = "/work";
    Labels = {
      # Deterministically link the ghcr package to this repo (and record
      # provenance) so the repo's Actions own + can push it — instead of relying
      # on GitHub's implicit auto-link-on-create (which left beadsd-box orphaned).
      "org.opencontainers.image.source" = "https://github.com/bounded-systems/prx";
      "dev.prx.room" = "beadsd-room";
      "dev.prx.image" = "beadsd-box";
    };
  };
}
