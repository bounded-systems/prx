# The released prx binary, made runnable inside a minimal dockerTools image
# (keeperd-box / beadsd-box) WITHOUT modifying the binary.
#
# `fetch-release.nix` installs the RAW released prx — a `bun --compile` single-file
# executable: a Bun runtime with the app blob appended after the ELF, and
# FHS-dynamically-linked (PT_INTERP = /lib/ld-linux-<arch>.so). A from-scratch
# `streamLayeredImage` has no /lib loader, so the raw binary fails at exec
#   `/bin/prx: cannot execute: required file not found`.
#
# The fix is NOT patchelf: rewriting the (longer nix) interpreter grows the file
# and corrupts the appended blob → the binary degrades to bare Bun
# (`prx --version` → `Bun vX`), the app never runs. Nor is a /lib loader symlink
# enough (still degrades). The working approach — proven in the claude-box flake —
# leaves the bytes untouched and invokes the nix glibc loader DIRECTLY on the
# binary, passing it as an argument (so Bun locates its blob via argv):
#   ld-linux-<arch>.so --library-path <glibc:libstdc++> /libexec/prx "$@"
#
# Drop-in for `import ../fetch-release.nix` in the daemon-box images: same
# `{ prx; version; }` shape, with `prx` a wrapper that runs the untouched binary.
# (bd is built from source — nix/oci/bd.nix — so it is store-linked and needs no
# help.)
self:
{ pkgs, system ? pkgs.stdenv.hostPlatform.system }:
let
  released = import ../fetch-release.nix self { inherit pkgs system; };
  # The FHS loader name the binary's PT_INTERP hardcodes, for this arch.
  loaderName = builtins.baseNameOf pkgs.stdenv.cc.bintools.dynamicLinker;
  prxLibs = pkgs.lib.makeLibraryPath [ pkgs.glibc pkgs.stdenv.cc.cc.lib ];
in
{
  inherit (released) version;
  prx = pkgs.runCommand "prx-${released.version}-fhs"
    { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
    install -Dm755 ${released.prx}/bin/prx "$out/libexec/prx"   # UNMODIFIED bytes
    makeWrapper ${pkgs.glibc}/lib/${loaderName} "$out/bin/prx" \
      --add-flags "--library-path ${prxLibs}" \
      --add-flags "$out/libexec/prx" \
      --set LD_LIBRARY_PATH "${prxLibs}"
  '';
}
