{
  description = "prx — the agent-run PR contract CLI (a bounded-systems monorepo)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib = pkgs.lib;
        rev = self.shortRev or self.dirtyShortRev or "dev";

        # Fixed-output derivation: populate the bun install cache (content-addressed
        # registry tarballs — deterministic given bun.lock). FODs are allowed network
        # because their output is hash-verified; the main build below is then fully
        # hermetic (offline), so it works under `sandbox = true` (no __noChroot).
        prxBunCache = pkgs.stdenv.mkDerivation {
          pname = "prx-bun-cache";
          version = "0.0.0";
          src = self;
          nativeBuildInputs = [ pkgs.bun pkgs.cacert ];
          dontConfigure = true;
          buildPhase = ''
            export HOME="$TMPDIR"
            export BUN_INSTALL_CACHE_DIR="$PWD/.bun-cache"
            rm -rf node_modules        # force a fresh download into the cache dir
            mkdir -p "$BUN_INSTALL_CACHE_DIR"
            bun install --frozen-lockfile
          '';
          installPhase = ''cp -R .bun-cache "$out"'';
          outputHashMode = "recursive";
          outputHashAlgo = "sha256";
          outputHash = lib.fakeHash; # placeholder — nix prints the real hash on first build
        };

        mkBin = { name, compileArgs }: pkgs.stdenv.mkDerivation {
          pname = name;
          version = "0.0.0";
          src = self;
          nativeBuildInputs = [ pkgs.bun ];
          dontConfigure = true;
          buildPhase = ''
            export HOME="$TMPDIR"
            export BUN_INSTALL_CACHE_DIR="${prxBunCache}"
            bun install --frozen-lockfile --offline
            ${compileArgs}
          '';
          installPhase = ''
            mkdir -p "$out/bin"
            cp ./${name} "$out/bin/${name}"
            chmod +x "$out/bin/${name}"
          '';
        };
      in {
        packages = rec {
          prx = mkBin {
            name = "prx";
            compileArgs = ''
              PRX_COMPILE_GIT_SHA="${rev}" \
              BUN="${pkgs.bun}/bin/bun" \
                bun packages/prx/scripts/prx-compile.ts ./prx
            '';
          };
          prx-tui = mkBin {
            name = "prx-tui";
            compileArgs = ''
              bun build --compile \
                --define __PRX_BUILD_GIT_SHA__="\"${rev}\"" \
                packages/prx/scripts/prx_tui.ts --outfile ./prx-tui
            '';
          };
          default = prx;
          deps = prxBunCache;
        };

        devShells.default = pkgs.mkShell { buildInputs = [ pkgs.bun ]; };
      });
}
