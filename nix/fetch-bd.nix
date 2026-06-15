# Fetch the released `bd` (beads) binary for a given Linux system, hermetically.
#
# Mirrors nix/fetch-release.nix (the prx binary) for the third-party beads CLI.
# `bd` is published by gastownhall/beads as a per-platform tarball; we pin the
# version + per-system sha256 so the beadsd-box image is content-addressed.
# This replaces the unpinned runtime `curl … | tar` in the Lima provision recipe
# (packages/prx/src/beadsd/provision.ts) — the artifact-native goal is that what
# PRODUCES a pinned image is itself pinned.
#
# `pkgs.fetchurl` is a fixed-output derivation, so this works under
# `sandbox = true` with no nix.conf changes.
#
# Usage: import ./nix/fetch-bd.nix { inherit pkgs; }   # → { bd; version; }
{ pkgs, system ? pkgs.stdenv.hostPlatform.system }:
let
  version = "1.0.3";
  # SRI hashes from `nix store prefetch-file <url>`. Bump together with `version`.
  assets = {
    aarch64-linux = {
      slug = "linux_arm64";
      hash = "sha256-JDqcdQEueUiI/K+5V+diS4/v3+8DPRTNA+vJgxw7wS8=";
    };
    x86_64-linux = {
      slug = "linux_amd64";
      hash = "sha256-HvXcqBjX6BV0356fn8KharcR2gmw+nuCKuFi2agciRI=";
    };
  };
  asset = assets.${system} or (throw
    "bd: no pinned beads release for system '${system}' (have: ${
      builtins.concatStringsSep ", " (builtins.attrNames assets)
    })");
  tarball = pkgs.fetchurl {
    url = "https://github.com/gastownhall/beads/releases/download/v${version}/beads_${version}_${asset.slug}.tar.gz";
    inherit (asset) hash;
  };
in
{
  inherit version;
  # The tarball carries `bd` at its root (alongside README/LICENSE/CHANGELOG).
  bd = pkgs.runCommand "bd-${version}" { } ''
    mkdir -p "$out/bin"
    tar -xzf ${tarball} -C "$out/bin" bd
    chmod +x "$out/bin/bd"
  '';
}
