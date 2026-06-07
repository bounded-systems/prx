---
"@bounded-systems/prx": patch
---

refactor(triage): break the triage actors↔machine import cycle; make the per-run actors testable

`triage/actors.ts` could not be loaded in isolation — `actors → prune-merged →
pr-state/cli → prime → machine → actors` formed an import cycle that threw a TDZ
on `statusActor` (and dragged the 23k-line CLI in at load time, hanging tests).
Root cause: `pruneMergedActor`'s delegate reached into `pr-state/cli.ts` for two
surface-sync/git primitives that never belonged there.

- Extract `pruneStaleRemoteRefs` + `applyParityChainActions` into a focused leaf
  module `pr-state/parity-chain.ts`; `cli.ts` re-exports them so its existing
  callers (gc drivers, tests) are unaffected, and `prune-merged.ts` imports them
  directly — breaking the cycle and the CLI's load-time pull.
- Forward an optional, test-only `deps` seam through every real triage actor's
  input to its delegate (mirroring `dep-research/actors`'s `fetcher` seam), so a
  wrapper can be driven hermetically. The machine never supplies it (production
  uses the real deps); behavior is unchanged.
