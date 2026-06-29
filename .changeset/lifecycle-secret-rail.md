---
"@bounded-systems/prx": minor
---

Lifecycle-runner room-secret rail (prx-82b Slice 2c.4): `renderBdLifecycleArgs`
now accepts `secrets: RoomSecret[]` and renders `--secret <name>,target=<path>`
the SAME way the pod's rooms get theirs (keeperd's `keeper-key`, forge-d's App
key) — so a cred-bearing ephemeral op (`dolt push`, private `dolt clone`) gets
its DoltHub creds via a `prx pod secrets`-provisioned podman secret, not an
ad-hoc bind. Adds the `DOLT_CREDS_SECRET` declaration (`prx-dolt-creds` →
`/run/secrets/dolt-creds`). The `dolt push` cutover that mounts it is gated on a
live DoltHub validation (dolt's active-creds discovery for a mounted jwk) — until
then push stays on host.
