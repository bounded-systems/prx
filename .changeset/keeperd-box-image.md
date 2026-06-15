---
"@bounded-systems/prx": minor
---

Add the `keeperd-box` OCI image (prx-anj) — the pinned `dockerTools.streamLayeredImage` that fills `room/keeperd-room.ts` (`image: "keeperd-box"`) in the per-repo pod (prx-zj8). Runs `prx keeper serve` (the `git:write` door) from prx + gitMinimal + openssh + cacert. The care-about: the keeper provenance **signing key is a runtime secret** — the pod mounts it via a podman secret onto tmpfs (`/run/secrets/keeper-key`, overridable with `PRX_PROVENANCE_KEY_FILE`) and the entrypoint reads it into `PRX_PROVENANCE_KEY` at start; the key is never baked into a layer (verified: no key material in the image closure). Build on the prx-62h linux builder: `nix build .#packages.aarch64-linux.keeperd-box`.
