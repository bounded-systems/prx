---
"@bounded-systems/prx": patch
---

Add the `ghappd-box` OCI image — the container that runs `prx ghapp serve` inside a guest-room (prx-36xr, the linchpin for running ghappd in the per-repo pod).

- **nix/oci/ghappd-box.nix** — `streamLayeredImage` mirroring keeperd-box, but the
  App PEM is a RUNTIME SECRET: the entrypoint points `PRX_GH_APP_KEY_FILE` at the
  mounted secret (`/run/secrets/ghapp-key`) so the daemon reads it in-process —
  the PEM never enters env/argv/a layer (stronger than keeperd-box, which cats
  its key into env). Non-secret App id read from `/run/secrets/ghapp-id` when
  present; installation defaults in the daemon. Unmounted ⇒ serves but leases
  error (by design). Contents: prx + cacert (HTTPS to api.github.com only — no
  git/ssh).
- **flake.nix** — `packages.<linux>.ghappd-box` (Linux-only, like the other boxes).
- **.github/workflows/publish-oci-boxes.yml** — a `ghappd-box` publish job
  (build → skopeo push to ghcr → digest in the step summary to pin), mirroring
  beadsd-box.

Follow-up (after the first publish): pin the digest into `room/ghappd-room.ts`
and wire the room into the per-repo pod (prx-36xr steps 2–5).
