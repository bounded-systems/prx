---
"@bounded-systems/prx": minor
---

Build the **beadsd-box** OCI image (prx-634, epic prx-zj8) — the first pinned daemon image of the service fleet. `nix/beadsd-box.nix` is a `dockerTools` layered image running `prx beads serve` foreground as PID 1 (binds the door socket, no init wrapper); `nix/fetch-bd.nix` pins the third-party `bd` (beads) CLI as a per-system fixed-output derivation (v1.0.3), replacing the unpinned runtime `curl` in the Lima provision recipe. Wired into `flake.nix` under `lib.optionalAttrs pkgs.stdenv.isLinux` (darwin still evaluates); exposed as `packages.aarch64-linux.beadsd-box`.

Built + validated from the darwin dev host by offloading to the registered `aarch64-linux` remote builder (the Lima devshell VM) — overturning the ADR's "no Linux builder, not buildable here" caveat. The minimal image surfaced two fixes baked into the image: the FHS-dynamically-linked prx/bd binaries are run through `autoPatchelfHook`, and `dockerTools.fakeNss` + `HOME` give dolt/git a uid-0 passwd entry. Smoke-tested under `podman` (all four binaries run; the entrypoint comes up serving on `/run/prx/doors/beadsd.sock`). keeperd-box (prx-anj) and pod assembly (prx-asr) are follow-ons.
