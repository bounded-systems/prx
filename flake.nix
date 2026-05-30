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
        rev = self.shortRev or self.dirtyShortRev or "dev";

        # Dev/local build. `bun install` needs network, so this opts out of the
        # sandbox (`__noChroot`, requires `sandbox = relaxed`). Bun's cache/
        # node_modules are not cleanly fixed-output-derivable (absolute symlinks),
        # so the PRODUCTION distribution path is the release-binary CI
        # (.github/workflows/release-binary.yml) + consumers fetchurl the asset —
        # not this from-source build.
        mkBin = { name, compileArgs }: pkgs.stdenv.mkDerivation {
          pname = name;
          version = "0.0.0";
          src = self;
          nativeBuildInputs = [ pkgs.bun pkgs.cacert ];
          __noChroot = true;
          dontConfigure = true;
          buildPhase = ''
            export HOME="$TMPDIR"
            bun install --frozen-lockfile
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
              PRX_COMPILE_GIT_SHA="${rev}" BUN="${pkgs.bun}/bin/bun" \
                bun packages/prx/scripts/prx-compile.ts ./prx
            '';
          };
          prx-tui = mkBin {
            name = "prx-tui";
            compileArgs = ''
              bun build --compile --define __PRX_BUILD_GIT_SHA__="\"${rev}\"" \
                packages/prx/scripts/prx_tui.ts --outfile ./prx-tui
            '';
          };
          default = prx;
        };

        devShells.default = pkgs.mkShell { buildInputs = [ pkgs.bun ]; };
      });
}
