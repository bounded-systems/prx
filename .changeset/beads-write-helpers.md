---
"@bounded-systems/prx": patch
---

Add `beadsd/writes.ts` — daemon-routed `createBeadViaDaemon` / `updateBeadViaDaemon` / `closeBeadViaDaemon`, the write twins of `beadsd/reads.ts` (GH-296 wave 2). These are the single-source replacements that internal `execBd` write call sites migrate onto, so host writes go to the one beads the daemon owns. A non-ok daemon verdict throws; the echoed bd record is parsed with the same transform the readers use.
