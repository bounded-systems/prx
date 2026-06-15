---
"@bounded-systems/prx": minor
---

Provision the prx Lima VM as a nix remote builder (prx-62h, flavor B of `docs/prx/claude-runtime.md`). Add `provisionVmNixBuilder` — install nix (Determinate, skip-if-present), make the VM login user a `trusted-user`, enable flakes, restart the daemon — and the pure `/etc/nix/machines` descriptor `nixBuilderMachineLine` / `NixBuilderMachine`. The in-VM effects run through the injected `Run` seam (unit-tested offline; live path runs against a real VM); prx renders the host registration line but does not edit host nix config. This is the build substrate the OCI fleet images (prx-634, prx-anj) offload to so they can be built from a kernel-less macOS host. Foundation only: the CLI verb and the host-side registration write are follow-ons.
