---
"@bounded-systems/prx": minor
---

Add the `beadsd-box` OCI image (prx-634) — the pinned `dockerTools.streamLayeredImage` that fills `room/beadsd-room.ts` in the per-repo pod (prx-zj8). Built on the prx-62h linux builder via `nix build .#packages.aarch64-linux.beadsd-box`. Contents: prx (our release), `bd` **built from source** (`nix/oci/bd.nix`, buildGoModule over the MIT-licensed beads source + ICU for its dolt cgo dep — not a downloaded prebuilt), `dolt` from nixpkgs (the client for connect-to-external-dolt), and gitMinimal + cacert. Entrypoint `prx beads serve` on the `beadsd-room` door socket. The image is the artifact; the pod (prx-asr) supplies the dolt clone dir + external-dolt endpoint at runtime.
