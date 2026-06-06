# ADR — `prx ci` as a signed derivation chain (GH-352)

> Status: **accepted**, implemented in `packages/prx/src/pr-state/ci-attest.ts`
> + the `ci` verb wiring in `cli.ts`; tests in `test/pr-state/ci_attest.test.ts`.
> Signs via the existing provenance tier (`packages/prx/src/provenance/`), but
> records a **content-addressed** derivation, not a bare commit-vouch. See
> *History* for the two earlier drafts and why this shape won.

## Problem

`prx ci` runs the validation pipeline (`install → typecheck → docs → build →
test`) and emits `LOCAL_CI_*` lines on stderr (`packages/prx/src/pr-state/local-ci.ts`),
but the **result is ephemeral**: a green run is a line in a log, not an
artifact. Nothing records *which tree-state* was validated, *who* validated it,
or *whether that result still holds* once HEAD moves. The merge decision
therefore trusts "CI was green" on faith. `local-ci.ts` flagged the gap:

> *Out of scope (covered by #352): projecting `LOCAL_CI_*` events into … the
> parity chain.*

## The two models in `anchored-chain`

The `Derivation` struct hosts two patterns that **do not compose**:

| | **bucket A — "the chain"** | **bucket B — "vouchers"** |
| --- | --- | --- |
| examples | scout reads, the fetcher example | `attest.ts` / `checks/v1` |
| keyed on | `sha256:` content digests | `gitCommit:<oid>` |
| `inputs` mean | lineage edges (`input == output`) | (empty) / SLSA materials |
| consumed via | `lineage` / `isStale` / `invalidate` | `derivationsByOutput` + verify |
| reproducible? | yes (`id = digest(manifest)` over content) | it's a signed assertion |

The pilot's `checks/v1` is bucket B: **empty `inputs`, a `gitCommit:` subject,
consumed by the merge-guard via `derivationsByOutput("gitCommit:<oid>")` +
`verifySlsaDerivation`**. Nothing in `provenance/`, `pr-state/`, or `pipeline/`
ever calls `isStale` / `lineage.*` / `invalidate.*` — so a `checks/v1` is a
*signed boolean about a commit*, and the chain's defining features are inert
with respect to it. Reusing it for `prx ci` (the first implemented draft, #307)
put CI in bucket B — a signed vouch, **not** an extension of *the chain*.

## Decision

**A green `prx ci` run records, per phase, a signed derivation whose `inputs`
are the `sha256:` content digests of what was validated — `tree`, `lock`,
`toolchain` — and whose output is the commit, wrapped in the same SLSA/DSSE
envelope the merge-guard verifies.** This is the unification, not a third shape:

```
inputs { tree, lock, toolchain }  (sha256:, bucket-A)  →  output { commit }  (gitCommit:, merge-guard)
                                   └── signed SLSA/DSSE envelope (bucket-B verify) ──┘
                                                  one derivation, per phase
```

- **Content inputs ⇒ bucket A.** With the validated tree carried as `sha256:`
  inputs, `lineage.isStale(id, { tree: currentTree })` answers "does this green
  still cover HEAD's tree?"; `invalidate.descendants(oldTree)` finds the CI work
  that validated a superseded tree; and CI composes with the rest of the
  content-addressed chain (e.g. scout reads, themselves bucket A).
- **Commit output ⇒ merge-guard unchanged.** The commit stays the SLSA subject
  (→ the `gitCommit:<oid>` output `projectProvenanceAxis` reverse-looks-up), so
  the existing fail-closed merge gate keeps working with **no change**.
- **Same signing path.** `persistAttestation` builds the manifest from the SLSA
  spec — subject → outputs, `resolvedDependencies` → inputs — and signs it. We
  pass the materials as `resolvedDependencies`; everything else is reused.
- **Signed, attributed to the source authority.** The verdict is signed with
  the *ambient actor's* authority — the dispatch **source** model: a direct
  `prx ci` is sourced from the human (the `claude-code` default), and a
  leg-dispatched run carries that leg's actor. `persistAttestation` reads that
  actor for `builder.id`, so the signer and `builder.id` stay consistent and the
  merge-guard's per-actor verifier resolves the right key. We deliberately do
  **not** pin a `local_ci` tool actor: that attributes the verdict to the *tool*
  rather than the *authority* that ran it, diverges from how the pilot's
  `checks/v1` signs (also the default actor), and risks fail-closed rejection
  under a production trust map that doesn't pin it.
- **Fail-closed.** Attestation runs only on a clean pass (`code === 0`). A
  failure records nothing ⇒ absence of a derivation for a tree ≡ "not verified".

Build type: `https://prx.dev/ci/phase/v1` (distinct from the input-less
`checks/v1`, since this one carries materials).

## What was built

- **`pr-state/ci-attest.ts`** — `resolveCiInputs({ treeOid, lock, toolchain })`
  (pure → the `sha256:` inputs), `attestCiPhases(deps, inputs, commit, phases)`
  (one signed `ci/phase/v1` per phase via `persistAttestation`; idempotent), and
  `currentCiRefs(inputs)` (the freshness key for `isStale`).
- **`cli.ts` `ci` verb** — on a green run, when a signer + canonical ledger
  resolve, compute the inputs (`git rev-parse HEAD^{tree}`, `bun.lock`,
  `bun <version>`) and attest the phases. Best-effort: never alters the CI exit
  code; with no `PRX_PROVENANCE_KEY` it is a no-op (behavior unchanged).
- **`test/pr-state/ci_attest.test.ts`** — signed/verifiable, content inputs not
  empty, commit-subject (merge-guard), distinct ids per phase, idempotency, and
  — the point of the change — **`isStale` fresh/stale and `invalidate.descendants`
  over the validated tree** (against a real temp ledger).

## Signing — and why scout is unsigned

CI derivations carry a DSSE-signed SLSA envelope; enforcement
(`requireSignedDerivations()`, fail-closed) rejects unsigned ones at the
merge-guard / publisher tier.

> **On scout being unsigned.** `recordScoutReadDerivation`
> (`packages/scout/src/provenance.ts`) records *integrity only* (no `envelope`)
> because a bare-CLI `scout read` runs under **no actor authority** — it has no
> key to sign with. The fix follows the same source model as CI: a scout read
> *dispatched inside a leg* should sign with that leg's authority (the dispatch
> `source`). That needs one missing piece — **dispatch does not yet propagate
> its `source` into the signing/audit context** (`setAuditRuntimeContext`'s
> `actor` is only ever the `claude-code` default today). Wire that, and both
> dispatched scout reads and leg-run CI attribute to the real authority; being
> already bucket A (`sha256:source → sha256:envelope`), scout reads then compose
> with these CI derivations in one chain. Tracked in *Follow-ups*.

## Follow-ups

- Project the CI verdict into `.pr/local/pr.json` (the GH-352 local
  semantic-state read), and have the merge guard consult `isStale` (the bucket-A
  freshness signal) in addition to the commit-keyed presence check.
- Attest a *partial* pass (the phases that passed before a failure) — needs
  `runCi` to surface per-phase results; the current slice attests only a full
  green.
- **Propagate the dispatch `source` into the signing/audit context** so a
  leg-dispatched verb (CI or a scout read) signs with the dispatching leg's
  authority rather than the `claude-code` default. This is the shared mechanism
  the next two items rest on.
- Sign in-pipeline scout reads with the dispatching leg's authority (close the
  unsigned gap above), once `source` propagation lands.
- Carry a signer in `.github/workflows/ci.yml` (already a thin shell over
  `dist/prx ci`) so remote greens join the same chain as local ones.

## Alternatives considered

- **`checks/v1`-only (the #307 draft).** Reuses the pilot's emission verbatim —
  but it is bucket B (empty inputs, commit-keyed), so "CI in the chain" reduces
  to "another signed commit vouch" with the chain's lineage/`isStale` features
  inert. **Superseded** by adding content inputs (this ADR), which keeps the
  signature + merge-guard path and makes the record an actual chain node.
- **A standalone `prx.ci.phase/v1` DAG with a bespoke (non-SLSA) envelope.** Pure
  bucket A, but the core `validateDerivation` can't verify it (it recurses into
  content-leaf inputs and fails "derivation not found"), and the merge-guard
  speaks SLSA. **Rejected**: the SLSA envelope + content `resolvedDependencies`
  gets both properties with zero new verify surface.
- **GitHub's check-run status as the source of truth.** Not content-addressed,
  tree-bound, or locally verifiable, and it doesn't compose with the chain. Kept
  as a *projection target*, not the record.

## History

1. **Draft A** proposed a phase-DAG with `source/lock/toolchain` inputs + a run
   roll-up and a bespoke envelope.
2. **Draft B (#307, merged)** swapped to reusing the pilot's `checks/v1` for
   one-shape consistency — which review showed is bucket B and not chain-woven
   (empty inputs; nothing consumes it via lineage; the merge-guard only does
   `derivationsByOutput` + verify). Optimising for consistency with a pattern
   that itself isn't chain-woven was the wrong call.
3. **This ADR** keeps the SLSA/DSSE signing + commit subject of `checks/v1` (so
   the merge-guard is untouched) but adds Draft A's content inputs as
   `resolvedDependencies` — the bucket-A structure with bucket-B signing. Notes
   carried forward so they are not re-litigated: `lineage`/`invalidate` link by
   `input_digest == output_digest`, whereas core `validateDerivation` recurses
   on inputs-as-`derivationId`; and `validateDerivation` rejects a SLSA envelope
   (`anchored-chain/envelope-mismatch`) because it re-binds the bespoke
   predicate — SLSA verification lives in `provenance/verify.ts` by design.
