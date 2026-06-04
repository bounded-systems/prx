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
        pkgs = import nixpkgs { inherit system; };
        # Hermetic released binaries (fetchurl FOD — works under sandbox = true).
        # The from-source build needs network in the sandbox; distribution is the
        # released binary, so the flake's packages ARE the released binaries.
        bins = import ./nix/fetch-release.nix self { inherit pkgs system; };
      in
      {
        packages = {
          prx = bins.prx;
          default = bins.prx;
        };

        devShells.default = pkgs.mkShell { buildInputs = [ pkgs.bun ]; };
      });
}
