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
        # `nix run .#jsr-sync -- [--dry-run] [--repo owner/name]` — reserve +
        # describe + link the publishable packages on JSR. The jsr CLI is a node
        # program; the script itself needs only bun. NB: jsr-sync.ts discovers
        # packages relative to its own path (import.meta.dir/../..), so it must
        # run against the repo checkout — invoked from $PWD, not a store copy.
        # Run from the repo root. Auth: $JSR_TOKEN (jsr.io PAT, permission `all`).
        jsr-sync = pkgs.writeShellApplication {
          name = "jsr-sync";
          runtimeInputs = [ pkgs.bun pkgs.nodejs ];
          text = ''exec bun packages/prx/scripts/jsr-sync.ts "$@"'';
        };
      in
      {
        packages = {
          prx = bins.prx;
          default = bins.prx;
        } // lib.optionalAttrs codeqlSupported { inherit codeql; }
        # OCI fleet images (prx-zj8) are Linux-only; build them on the prx-62h
        # linux builder, e.g. `nix build .#packages.aarch64-linux.beadsd-box`.
        // lib.optionalAttrs pkgs.stdenv.isLinux {
          beadsd-box = import ./nix/oci/beadsd-box.nix self { inherit pkgs system; };
          keeperd-box = import ./nix/oci/keeperd-box.nix self { inherit pkgs system; };
          forge-d-box = import ./nix/oci/forge-d-box.nix self { inherit pkgs system; };
          concierged-box = import ./nix/oci/concierged-box.nix self { inherit pkgs system; };
          dolt-box = import ./nix/oci/dolt-box.nix self { inherit pkgs system; };
          # The nix remote BUILDER as a pinned container (prx-zj8 capstone) —
          # replaces the Lima builder VM (sshd + single-user nix on a /nix volume).
          nix-builder-box = import ./nix/oci/nix-builder-box.nix self { inherit pkgs system; };
        };

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
        apps = {
          jsr-sync = {
            type = "app";
            program = "${jsr-sync}/bin/jsr-sync";
          };
        } // lib.optionalAttrs codeqlSupported {
          codeql-quality = {
            type = "app";
            program = "${codeql-quality}/bin/codeql-quality";
          };
        };
      });
}
