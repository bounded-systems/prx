---
"@bounded-systems/prx": minor
---

Retire all remaining Lima code (prx-zj8 capstone): delete `lima/nix-builder.ts` +
the `prx lima` command (its last verb, `provision-builder`, is replaced by the
nix-builder container), delete the dead `session-host/*`, and rename the
generic spawn seam `door/lima-exec.ts` → `door/exec.ts` (it was misnamed — just
`spawnRun` over @bounded-systems/proc; still used by provision-local). Adds the
`prx builder up | register` CLI (run the nix-builder container / print its
`/etc/nix/machines` + ssh-config registration), driven by the tested
container-builder render core. No `lima/` source dir remains; Lima is purely the
external devshell VM now.
