# Fetch the released prx binary for a given system, hermetically.
#
# `pkgs.fetchurl` is a fixed-output derivation, so this works under
# `sandbox = true` with no nix.conf changes — the portable distribution path
# (the from-source build needs network in the sandbox; the binaries don't).
#
# Hashes live in ../release-hashes.json, updated per release by the
# release-binary workflow. Usage:
#   import ./nix/fetch-release.nix self { inherit pkgs; }   # → { prx; version; }
self:
{ pkgs, system ? pkgs.stdenv.hostPlatform.system }:
let
  hashes = builtins.fromJSON (builtins.readFile (self + "/release-hashes.json"));
  version = hashes.version;
  sysHashes = hashes.systems.${system} or (throw
    "prx: no released binary for system '${system}' (have: ${
      builtins.concatStringsSep ", " (builtins.attrNames hashes.systems)
    })");
  fetchBin = name: sha256:
    let
      bin = pkgs.fetchurl {
        url = "https://github.com/bounded-systems/prx/releases/download/v${version}/${name}-${system}";
        inherit sha256;
      };
    in
    pkgs.runCommand "${name}-${version}" { } ''
      mkdir -p "$out/bin"
      install -m755 ${bin} "$out/bin/${name}"
    '';
in
{
  inherit version;
  prx = fetchBin "prx" sysHashes.prx;
}
