---
"@bounded-systems/prx": minor
---

Retire the `prx lima` in-VM daemon verbs (prx-zj8 — the podman pod superseded
them). Removes `prx lima up|down|daemons|status|provision-beads` (and their
`lima/registry.ts` + `beadsd/provision.ts` modules); keeps `prx lima
provision-builder` (the nix remote builder, prx-62h). `doltHubUrl` moved to
`dolt/namespace.ts` (the kept local-beads path still uses it). First of the
Lima-daemon-retirement PRs; the host-native daemon + builder are untouched.
