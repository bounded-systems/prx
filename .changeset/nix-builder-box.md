---
"@bounded-systems/prx": minor
---

Add the `nix-builder-box` OCI image (prx-zj8 capstone) — the nix remote BUILDER
as a pinned container (sshd + single-user nix on a /nix volume), to replace the
Lima builder VM. Adds the image (nix/oci/nix-builder-box.nix), its publish job,
and the `NIX_BUILDER_IMAGE` pin (packages/prx/src/room/nix-builder-service.ts).
Verified: `nix store info --store ssh-ng://…` against the running container
returns Trusted:1 (a functional remote builder). Wiring it as the registered
builder + retiring Lima follows.
