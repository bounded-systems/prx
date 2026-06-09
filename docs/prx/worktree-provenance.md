# ADR — signed provenance for `claude --worktree` materialization (prx-hc5)

> Status: **accepted**, first slice implemented in
> `packages/prx/src/pr-state/keeper.ts` (`attestWorktreeAdd`) +
> `packages/prx/src/provenance/attest.ts` (`WORKTREE_ADD_BUILD_TYPE`); tests in
> `test/pr-state/keeper.test.ts`. Production wiring (passing the keeper
> signer + ledger from the worktree-create hook) is the deferred second slice.

## Problem

`claude --worktree <name>` routes through prx's worktree lifecycle (the
`prx workspace worktree-create` hook → `reserve` → `materialize` → keeper's
`git worktree add`; see the worktree-lifecycle work in prx-6jb / prx-5q3 /
prx-ph7 / prx-hot). The materialization is a real, security-relevant act — a new
working tree on a branch cut from a base — but it left **no signed record**:
nothing attests *which branch* was placed *at which commit*, cut from *which
base*, by *which actor*. Every other keeper git-write is attestable (commit/push
emit signed SLSA steps via `provenance/attest.ts`); worktree-add was the gap.

## Rejected framing: route the resolution reads through scout

The first instinct was to route the worktree-create **resolution reads**
(`git worktree list`, `git config remote.origin.url`, the repo-registry
`index.json`) through `@bounded-systems/scout` for provenance. **Audited and
rejected:** scout is a *file-content* read surface (`read`/`grep`/`files`, sha256
content-addressing) for the agent's repo read surface. The resolution reads are
git **state** + prx's own **infra config**, not work-surface content reads —
scout's model does not fit them. (`gh` is likewise unnecessary: no GitHub API
call happens, the origin is local git config; the only `fetch` is keeper's
`git worktree add … origin/main`, which is keeper's concern.)

The real want is not "reads through scout" but **provenance over the
materialization decision** — which is the anchored-chain SLSA tier, not scout.

## Decision

Model the worktree placement as a signed SLSA derivation, **in keeper**, exactly
like `push/v1`. Keeper is the one git-knower *and* the provenance signer (it
already holds the key and emits `push/v1`), so `git worktree add` is just
another attestable keeper git-write.

- **`worktree-add/v1`** (`WORKTREE_ADD_BUILD_TYPE = https://prx.dev/git/worktree-add/v1`).
- **subject** = the new worktree's branch tip. Unlike commit/push — which are
  *self-describing* (`attestingGit` reads the cwd's `HEAD`) — `git worktree add`
  does **not** move the cwd's HEAD, so the subject is **declared**: resolve
  `HEAD` in the *target* worktree post-add. This is the `attestingProc`
  declared-subject strategy, not `attestingGit`.
- **materials** (`resolvedDependencies`) = the base commit the branch was cut
  from (`origin/main`), when known.
- **externalParameters** = `{ branch, targetPath }`.
- **Opt-in + fail-safe**, mirroring `runKeeperPush`: emitted only when a signer +
  ledger (`AttestDeps`) are configured and the placement was *real*
  (`created` / `recreated`, never the idempotent `exists`). A missing/malformed
  target HEAD yields `null` (no link) rather than a malformed attestation.

The emission is a separate composable async step (`attestWorktreeAdd`) rather
than folded into `runKeeperEnsureWorktree`, which stays **synchronous** — so
`reserve`/`materialize`/the hook adapter do not inherit an async cascade. The
caller invokes it post-ensure when signing is configured (the same
caller-decides shape as keeper push).

## Slices

1. **(this change)** keeper is attest-capable for worktree-add: the
   `WORKTREE_ADD_BUILD_TYPE` build type + `attestWorktreeAdd(attest, {branch,
   targetPath, baseCommit?})`, unit-tested against a fake store + signer
   (subject = target HEAD, base material, fail-safe on missing HEAD).
2. **(deferred)** production wiring: thread the keeper `Signer` + `DerivationStore`
   (the same factory `cli.ts` wires for `push/v1`) from the worktree-create hook /
   `runMaterialize` into `attestWorktreeAdd`, gated on the operator's
   provenance-key + ledger config. Then `claude --worktree` placements land a
   signed `worktree-add/v1` in the chain, verifiable via `provenance/verify.ts`.

## Consequences

- Worktree materialization joins the signed derivation chain — a `claude
  --worktree` placement is verifiable lineage, not an ephemeral act. Aligns with
  the artifact-native pipeline + signed-spawn ocap (the spawn's worktree now has
  provenance too).
- No new mechanism: reuses `persistAttestation` / the SLSA tier. The only novelty
  is the declared-subject (target-HEAD) strategy, justified above.
- keeper stays the sole git-writer **and** the sole signer of git-writes — no
  provenance authority leaks into the workspace actor or the hook adapter.
