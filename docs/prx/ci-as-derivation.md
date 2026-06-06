# ADR — `prx ci` as a signed derivation chain (GH-352)

> Status: **accepted**, with an implemented first slice (`packages/prx/src/pr-state/ci-attest.ts`
> + the `ci` verb wiring in `cli.ts`; tests in `test/pr-state/ci_attest.test.ts`).
> Reuses the existing `checks/v1` attestation tier (`packages/prx/src/provenance/`),
> the same one the pilot's verify step emits. Supersedes the initial draft, which
> proposed a parallel `prx.ci.phase/v1` shape (see *History*).

## Problem

`prx ci` runs the validation pipeline (`install → typecheck → docs → build →
test`) and emits `LOCAL_CI_*` lines on stderr (`packages/prx/src/pr-state/local-ci.ts`),
but the **result is ephemeral**: a green run is a line in a log, not an
artifact. Nothing records *which tree-state* was validated, *who* validated it,
or *whether that result still holds* once HEAD moves. The merge decision
therefore trusts "CI was green" on faith. `local-ci.ts` flagged the gap:

> *Out of scope (covered by #352): projecting `LOCAL_CI_*` events into … the
> parity chain.*

## Decision

**A green `prx ci` run records a signed `checks/v1` derivation per phase, keyed
on the commit under test — the exact same attestation the pilot's verify step
already emits — so a local CI pass becomes verifiable evidence in the anchored
chain. There is no parallel CI shape: the merge guard reads one `checks/v1`
family regardless of which surface produced it.**

This reuses the GH-2249 provenance tier wholesale rather than inventing a second
ledger shape:

- **Emission**: `provenance/attest.ts` `persistAttestation` builds a SLSA
  Provenance v1 Statement (`buildType = https://prx.dev/checks/v1`, subject =
  the commit), signs it via the resolved `Signer`, and appends a `Derivation`
  carrying the DSSE `envelope`. `ci-attest.ts` calls it once per passed phase.
- **Signer**: `resolveProvenanceSigner()` — the env-gated, per-actor signer
  (dev key auto-persists; zero env wiring for the dev loop).
- **Verification / enforcement**: `provenance/verify.ts` `verifySlsaDerivation`
  + the `requireSignedDerivations()` fail-closed flag, already consumed by the
  merge-guard / publisher tiers.

### Why this shape

- **Signed by construction.** Every recorded derivation carries a signature;
  `verifySlsaDerivation` rejects an unsigned one. CI runs under an actor
  authority (`local_ci` / the ambient actor), so there is no reason to omit it —
  see *On scout being unsigned*.
- **Per-phase granularity.** One `checks/v1` per phase (`install/typecheck/docs/
  build/test`); the `phase` param feeds the manifest digest, so each phase is a
  distinct, content-addressed derivation sharing one subject commit.
- **Fail-closed.** Attestation runs only on a clean pass (`code === 0` ⇒ every
  requested phase passed). A failure records nothing, so **absence of a
  `checks/v1` for a commit ≡ "not verified"** — the same discipline as
  `attestingChecks` (which signs only on `status === 0`).
- **Tree-bound.** The subject is the commit oid. "Is this green still valid?"
  becomes "is there a `checks/v1` for *this* HEAD?" — when HEAD moves to a new
  commit, the old attestations simply do not cover it. (This is the `checks/v1`
  analogue of the chain's `isStale`; the merge guard already keys on the commit.)
- **One shape.** A `prx ci` green and a pilot green land identical-shaped,
  merge-guard-readable attestations in one ledger.

## What was built (first slice)

- **`packages/prx/src/pr-state/ci-attest.ts`** — `attestCiPhases(deps, commit,
  phases)`: one signed `checks/v1` per phase via `persistAttestation`.
  Idempotent (content-addressed id, no timestamp inside), pure over its
  `{ signer, store }` deps so it unit-tests against a fake store + a fixed
  keypair.
- **`cli.ts` `ci` verb** — after a green run, when a signer + canonical ledger
  resolve (`resolveProvenanceSigner` + `resolveCanonicalChainLedger`) and HEAD
  is known, open the ledger and attest the run's phases. Best-effort: a failure
  to attest never changes the CI exit code. With no `PRX_PROVENANCE_KEY`, the
  path is a no-op and behavior is unchanged.
- **`test/pr-state/ci_attest.test.ts`** — per-phase signed/verifiable
  derivations, distinct ids per phase, idempotency, and commit-binding; mirrors
  `test/provenance/checks-attest.test.ts`.

## Signing (mandatory) — and why scout is unsigned

CI derivations carry a DSSE-signed SLSA envelope; enforcement
(`requireSignedDerivations()`, fail-closed) rejects unsigned ones at the
merge-guard / publisher tier.

> **On scout being unsigned.** `recordScoutReadDerivation`
> (`packages/scout/src/provenance.ts`) records *integrity only* (no `envelope`)
> because a bare-CLI `scout read` runs under **no actor authority** — it has no
> key to sign with. That is a Phase-1 shortcut, not a principle. Under
> "everything should be signed" it is a gap: scout reads performed *within* a
> pipeline leg should sign with that leg's authority. Tracked separately (see
> *Follow-ups*).

## Follow-ups

- Project the `checks/v1` verdict into `.pr/local/pr.json` (the GH-352 local
  semantic-state read) so the merge guard reads the attestation, not a log line.
- Record `checks/v1` on a *partial* pass (attest the phases that passed before a
  failure) — needs `runCi` to surface per-phase results; the current slice
  attests only on a full green.
- Have `.github/workflows/ci.yml` (already a thin shell over `dist/prx ci`)
  carry a signer so remote greens land in the same chain as local ones.
- Sign `scout` reads performed inside a pipeline leg with that leg's authority
  (close the unsigned gap above).

## Alternatives considered

- **A parallel `prx.ci.phase/v1` phase-DAG** (the initial draft): one derivation
  per phase with `source`/`lock`/`toolchain` inputs feeding a roll-up `run`
  derivation, giving `lineage.isStale`-on-inputs semantics. **Rejected**: it
  stands up a second CI-attestation shape next to the `checks/v1` the merge
  guard already consumes, which the codebase works to avoid. The commit-keyed
  `checks/v1` gives the same fail-closed, tree-bound guarantee with zero new
  ledger surface.
- **Unsigned, integrity-only (as scout does today).** Detects tampering but not
  forgery. Rejected — CI has an actor authority.
- **GitHub's check-run status as the source of truth.** Not content-addressed,
  tree-bound, or locally verifiable, and it doesn't compose with the chain.
  Kept as a *projection target*, not the record.

## History

The first draft of this ADR proposed `prx.ci.phase/v1` derivations with
`{ source, lock, toolchain }` inputs and a run roll-up, relying on
`lineage.isStale(runId, { source })`. Reviewing the existing
`packages/prx/src/provenance/` tier showed the pilot already runs and signs the
project checks as `checks/v1` (`attestingChecks` / `runAttestedChecks`), with a
signer resolver and a merge-guard consumer. Reusing that — rather than building
a parallel shape — is the accepted decision above. Two further notes from that
review, recorded so they are not re-litigated:

- `lineage`/`invalidate` link edges by `input_digest == output_digest`, whereas
  the core `validateDerivation` recurses treating each input as a `derivationId`
  — two different graph conventions. The `checks/v1` path sidesteps the question
  (it is a single signed node keyed on the commit, verified by
  `verifySlsaDerivation`, not the recursive walk).
- `validateDerivation` rejects a SLSA envelope (`anchored-chain/envelope-mismatch`)
  because it re-binds the *bespoke* predicate; SLSA verification lives in
  `provenance/verify.ts` by design.
