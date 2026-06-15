# Build the beads `bd` CLI from source, on our own builder (prx-634).
#
# beads (github.com/steveyegge/beads, MIT) is not in nixpkgs and we do NOT pull
# its prebuilt release binary — we compile it from pinned source here, so the
# beadsd-box image's bd is an inspectable, hermetic, content-addressed artifact
# like everything else in the fleet. This is the "build our own" path: the same
# bd `beadsd/provision.ts` installs, but produced by us, not downloaded.
#
# Bump: set `version` to the new tag, update `srcHash` (the fetchFromGitHub
# unpacked hash) and `vendorHash` (nix reports both on mismatch).
{
  pkgs,
  version ? "1.0.3",
  srcHash ? "sha256-K3X67XgUl55mZS4r4V/KTbXPNqCV7fPHi8HnrDime+E=",
  vendorHash ? "sha256-Rn1MnasYUOBbIgjFx0E6R2Zak6la1VajDkHqoiFpHtw=",
}:
pkgs.buildGoModule {
  pname = "bd";
  inherit version vendorHash;

  src = pkgs.fetchFromGitHub {
    owner = "gastownhall";
    repo = "beads";
    rev = "v${version}";
    hash = srcHash;
  };

  # Only the `bd` CLI (cmd/bd); the repo also carries plugins/website/etc.
  subPackages = [ "cmd/bd" ];

  # bd embeds dolt's SQL engine, which pulls `dolthub/go-icu-regex` — a cgo
  # binding that #includes <unicode/uregex.h>. ICU supplies the headers + libs.
  nativeBuildInputs = [ pkgs.pkg-config ];
  buildInputs = [ pkgs.icu ];

  # The repo's tests want a live dolt + network; the image build only needs the
  # binary. The from-source compile is the integrity check that matters here.
  doCheck = false;

  meta = {
    description = "beads (bd) issue tracker CLI, built from source for the beadsd-box image";
    homepage = "https://github.com/gastownhall/beads";
    license = pkgs.lib.licenses.mit;
    mainProgram = "bd";
  };
}
