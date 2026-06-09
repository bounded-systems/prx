---
"@bounded-systems/prx": patch
---

feat(keeper): signed `worktree-add/v1` provenance for worktree materialization (prx-hc5)

Worktree materialization (`claude --worktree` → keeper's `git worktree add`) was
the one keeper git-write with no signed record. Keeper can now attest it, like
`push/v1`:

- `WORKTREE_ADD_BUILD_TYPE` (`https://prx.dev/git/worktree-add/v1`).
- `attestWorktreeAdd(attest, {branch, targetPath, baseCommit?})` — emits a signed
  SLSA derivation whose **subject is the new worktree's branch tip** (declared,
  resolved via `HEAD` in the target worktree — `git worktree add` doesn't move the
  cwd's HEAD, so the self-describing `attestingGit` strategy doesn't apply), with
  the base commit as a material. Opt-in (only with a signer+ledger) and fail-safe
  (missing/malformed HEAD → no link), mirroring `runKeeperPush`.

`runKeeperEnsureWorktree` stays synchronous; the attestation is a separate
composable async step so `reserve`/`materialize`/the hook adapter don't inherit
an async cascade.

This replaces the rejected "route resolution reads through scout" framing
(scout is for file-content reads, not git-state/infra reads — audited in the
ADR). Production wiring (threading keeper's signer+ledger from the hook) is the
deferred second slice. See `docs/prx/worktree-provenance.md`.
