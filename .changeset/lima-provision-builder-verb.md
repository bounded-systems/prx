---
"@bounded-systems/prx": minor
---

Add the `prx lima provision-builder <vm>` verb (prx-62h) — wires `provisionVmNixBuilder` into the CLI so an operator can install nix in a Lima VM and register it as a nix remote builder in one command. Flags: `--max-jobs`, `--systems`, `--installer-url`; prints the `/etc/nix/machines` line to register (prx renders it, it does not edit host nix config). Completes the usable surface of the OCI build substrate begun in the prior slice.
