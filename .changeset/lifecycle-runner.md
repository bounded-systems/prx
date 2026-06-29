---
"@bounded-systems/prx": minor
---

Ephemeral lifecycle runner (prx-82b Slice 2c.1): `renderBdLifecycleArgs` /
`runBdLifecycle` run a one-shot bd/dolt SETUP op inside an ephemeral beadsd-box
container (`podman run --rm --userns keep-id -v <repo>:/work --entrypoint <bin>`)
instead of host `bd`. The foundation for relocating the setup ops (init / migrate
/ dolt remote add / config set) off the host bd binary — these run before a repo's
pod exists and are operator-triggered, so an ephemeral container sidesteps both
the chicken-and-egg and any door/authorization. Pure render is unit-tested;
`--userns keep-id` keeps `/work` writes host-owned.
