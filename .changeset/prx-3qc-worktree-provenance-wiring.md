---
"@bounded-systems/prx": patch
---

feat(workspace): emit signed worktree-add/v1 in production (prx-hc5 slice 2 / prx-3qc)

Wires keeper's `attestWorktreeAdd` (slice 1) into the live `claude --worktree`
path. After a real materialization, the create hook emits a signed
`worktree-add/v1` for the new worktree — opt-in + fail-safe, mirroring keeper
push:

- `resolveProvenanceSigner()` (the `PRX_PROVENANCE_KEY` env seam) → no key ⇒ no
  emission;
- `resolveCanonicalChainLedger(targetPath)` → the per-workspace anchored-chain
  ledger (I-WS5: never under the mainx replica) ⇒ no ledger, no emission;
- base commit (`origin/main`, what the branch was cut from) recorded as a
  material when resolvable;
- only on a real placement (`status: "created"`, not the idempotent `exists`);
- best-effort — a signing/ledger failure never aborts worktree creation.

Injectable (`WorktreeHookCliDeps.emitProvenance`) for tests. Completes
`docs/prx/worktree-provenance.md`'s slice 2.
