---
"@bounded-systems/prx": patch
---

Extend the beadsd write contract with the fields the internal write call sites need (GH-296 wave 2 parity): `create` gains `externalRef` (`--external-ref`) + `silent` (`--silent`); `update` gains `issueType` (`--type`). Wired through the daemon `beadsArgs` dispatch and the `createBeadViaDaemon`/`updateBeadViaDaemon` helpers. Unblocks flipping `promote` / `intake-mirror` (create with an external ref) and `drift-fix` (update the type axis) onto the daemon.
