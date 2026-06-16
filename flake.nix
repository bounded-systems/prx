{
  description = "prx — the agent-run PR contract CLI (a bounded-systems monorepo)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    {
      # Portable home-manager module. From any home-manager config:
      #   inputs.prx.url = "github:bounded-systems/prx";
      #   modules = [ prx.homeManagerModules.default ];
      #   programs.prx.enable = true;
      homeManagerModules.prx = import ./nix/hm-module.nix self;
      homeManagerModules.default = import ./nix/hm-module.nix self;
    }
    // flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          # CodeQL's license is unfree (free to analyze open-source, but not
          # OSI/redistributable). Whitelist *only* our codeql-bundle so the
          # opt-in outputs build without consumers setting a global allowUnfree;
          # nothing else is loosened. The default devShell (bun) is unaffected.
          config.allowUnfreePredicate = pkg:
            builtins.elem (lib.getName pkg) [ "codeql-bundle" ];
        };
        lib = nixpkgs.lib;
        # Hermetic released binaries (fetchurl FOD — works under sandbox = true).
        # The from-source build needs network in the sandbox; distribution is the
        # released binary, so the flake's packages ARE the released binaries.
        bins = import ./nix/fetch-release.nix self { inherit pkgs system; };

        # Opt-in CodeQL (the bundle is ~1.3GB, so it is kept out of the default
        # devShell). Only exposed on systems pinned in nix/codeql-hashes.json.
        codeqlManifest = builtins.fromJSON (builtins.readFile ./nix/codeql-hashes.json);
        codeqlSupported = builtins.hasAttr system codeqlManifest.systems;
        codeql = import ./nix/codeql.nix self { inherit pkgs system; };
        codeql-quality = pkgs.writeShellApplication {
          name = "codeql-quality";
          # nodejs is required by CodeQL's TypeScript extractor (this repo runs
          # on bun, which the extractor can't use).
          runtimeInputs = [ codeql pkgs.bun pkgs.nodejs pkgs.git ];
          text = ''exec bun ${./packages/prx/scripts/codeql-quality.ts} "$@"'';
        };
      in
      {
        packages = {
          prx = bins.prx;
          default = bins.prx;
        } // lib.optionalAttrs codeqlSupported { inherit codeql; };

        devShells = {
          default = pkgs.mkShell { buildInputs = [ pkgs.bun ]; };

          # Opt-in: `nix develop .#jsr` → bun + node. For local `jsr` CLI
          # dry-runs / slow-types checks before pushing (publishing itself is
          # CI-only, enforced by the JSR scope). The jsr CLI is a node program;
          # jsr-sync.ts needs only bun. Pinned node here also sidesteps a broken
          # host asdf node shim.
          jsr = pkgs.mkShell { buildInputs = [ pkgs.bun pkgs.nodejs ]; };
        } // lib.optionalAttrs codeqlSupported {
          # Opt-in: `nix develop .#codeql` → bun + codeql + nodejs (TS extractor).
          codeql = pkgs.mkShell { buildInputs = [ pkgs.bun codeql pkgs.nodejs ]; };
        };

        # Opt-in: `nix run .#codeql-quality` → build a JS/TS DB and run the
        # three quality rules (unused-local / useless-assignment / trivial-conditional).
        apps = lib.optionalAttrs codeqlSupported {
          codeql-quality = {
            type = "app";
            program = "${codeql-quality}/bin/codeql-quality";
          };
        };
      });
}
