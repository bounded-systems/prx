# Opt-in CodeQL bundle for prx, vendored hermetically.
#
# The official codeql-bundle release ships the CLI *and* the standard query
# packs (including `codeql/javascript-queries`, which holds the quality rules
# js/unused-local-variable, js/useless-assignment-to-local, js/trivial-conditional).
# We pin it by sha256 via `pkgs.fetchurl` — a fixed-output derivation, so it
# works under `sandbox = true` with no nix.conf changes, exactly like the prx
# release binaries in ./fetch-release.nix.
#
# This is deliberately NOT in `devShells.default` (the bundle is ~1.3GB). It is
# opt-in: `nix develop .#codeql`, `nix build .#codeql`, or `nix run .#codeql`.
#
# Hashes live in ./codeql-hashes.json; bump `tag`/`version`/hashes to upgrade.
# Refresh hashes from the release without downloading the tarball:
#   curl -fsSL .../codeql-bundle-<asset>.checksum.txt    # → sha256 hex
#   nix hash convert --hash-algo sha256 --to sri <hex>   # → sha256-… SRI
self:
{ pkgs, system ? pkgs.stdenv.hostPlatform.system }:
let
  inherit (pkgs) lib stdenv;
  manifest = builtins.fromJSON (builtins.readFile (self + "/nix/codeql-hashes.json"));
  inherit (manifest) version tag;
  sysInfo = manifest.systems.${system} or (throw
    "codeql: no bundle pinned for system '${system}' (have: ${
      builtins.concatStringsSep ", " (builtins.attrNames manifest.systems)
    }). Add its asset + sha256 to nix/codeql-hashes.json.");
  src = pkgs.fetchurl {
    url = "https://github.com/github/codeql-action/releases/download/${tag}/${sysInfo.asset}";
    hash = sysInfo.sha256;
  };
in
stdenv.mkDerivation {
  pname = "codeql-bundle";
  inherit version src;

  # The bundle's CLI launcher + bundled JDK/extractors are prebuilt ELF binaries
  # on Linux; patch them to the Nix store loader. No-op on Darwin (Mach-O).
  nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    stdenv.cc.cc.lib
    pkgs.zlib
  ];
  # Some bundled tools reference libs we don't ship; don't fail the build on them.
  autoPatchelfIgnoreMissingDeps = lib.optionals stdenv.hostPlatform.isLinux [ "*" ];

  # The tarball unpacks to a single top-level `codeql/` dir; stay in its parent
  # so the installPhase can copy that dir wholesale.
  sourceRoot = ".";

  dontConfigure = true;
  dontBuild = true;
  # CodeQL's own binaries are self-contained; stripping risks breaking them.
  dontStrip = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/libexec" "$out/bin"
    cp -r codeql "$out/libexec/codeql"
    ln -s "$out/libexec/codeql/codeql" "$out/bin/codeql"
    runHook postInstall
  '';

  meta = with lib; {
    description = "CodeQL CLI + standard query packs (official bundle ${version}), opt-in for prx";
    homepage = "https://github.com/github/codeql-action";
    # GitHub CodeQL CLI terms — free to analyze open-source/research; see
    # https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md
    license = licenses.unfree;
    sourceProvenance = [ sourceTypes.binaryNativeCode ];
    platforms = builtins.attrNames manifest.systems;
    mainProgram = "codeql";
  };
}
