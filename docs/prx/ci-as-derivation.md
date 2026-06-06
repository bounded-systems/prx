# ADR — `prx ci` as a signed derivation chain (GH-352)

> Status: **proposed**. Extends the anchored-chain provenance track (roadmap
> Track A) and the `local_ci` actor (`packages/prx/src/machine/actors.ts`).
> Precedent: `scout`'s read → derivation bridge (`packages/scout/src/provenance.ts`).
> No code yet — this is the contract to review before implementation.

## Problem

`prx ci` runs the validation pipeline (`install → typecheck → docs → build →
test`) and emits `LOCAL_CI_*` lines on stderr (`packages/prx/src/pr-state/local-ci.ts`),
but the **result is ephemeral**: a green run is a line in a log, not an
artifact. Nothing records *which tree-state* was validated, *who* validated it,
or *whether that result still holds* once the working tree moves. The merge
decision therefore trusts "CI was green" on faith, and a stale green (HEAD moved
after the run) is indistinguishable from a fresh one.

`local-ci.ts` already flags the gap:

> *Out of scope (covered by #352): projecting `LOCAL_CI_*` events into
> `.pr/local/pr.json` and the parity chain.*

## Decision

**A `prx ci` run becomes a signed sub-graph in the anchored chain: one
derivation per phase, anchored to the tree-state it consumed, feeding a single
roll-up *run* derivation. Every derivation is signed by the `local_ci` actor's
authority and verified with `requireSigned: true`. An unsigned CI derivation is
rejected.**

This mirrors `scout`'s pattern (a content-addressed operation records itself as
a `Derivation`) but as a **DAG** (Phase-level lineage) and **signed** (CI runs
under an actor authority; scout's bare-CLI read does not — see *Signing*).

```
            inputs (refs, content-addressed)
   source = sha256(git HEAD commit oid)   lock = sha256(bun.lock)   toolchain = sha256(bun/version…)
        │                │                          │
        ├────────────────┼──────────────────────────┤      each phase consumes the same inputs
        ▼                ▼                          ▼
  ┌───────────┐   ┌───────────┐   ┌──────┐   ┌───────┐   ┌──────┐
  │ install   │   │ typecheck │   │ docs │   │ build │   │ test │     prx.ci.phase/v1  (signed)
  └─────┬─────┘   └─────┬─────┘   └──┬───┘   └───┬───┘   └──┬───┘
        │ outputs: result digest    │           │          │
        └─────────────┬─────────────┴───────────┴──────────┘
                      ▼  inputs = { install: <digest>, typecheck: <digest>, … }
                 ┌─────────┐
                 │   run   │   prx.ci.run/v1  (signed)  ← the merge-guard artifact
                 └─────────┘
```

## The derivation shapes

A `Derivation` (`packages/anchored-chain/src/types.ts:25`) is
`{ derivationId, manifest{ producer, inputs, outputs, contracts, params }, envelope?, ts }`,
with `derivationId = digestManifest(manifest)` — content-addressed and
reproducible. Two producers:

### Phase derivation — `prx.ci.phase/v1`

```ts
manifest = {
  producer: "prx.ci.phase",
  inputs: {
    source:    "sha256:<HEAD-commit-oid hashed>",   // the tree-state validated
    lock:      "sha256:<bun.lock>",                  // resolved deps
    toolchain: "sha256:<bun version + target>",      // the runtime
  },
  outputs: {
    // sha256 of the phase result record (status, durationMs, captured log digest).
    result: "sha256:<phase-result-json>",
  },
  contracts: ["prx.ci.phase/v1"],
  params: { phase: "typecheck", status: 0, durationMs: 8423 },
};
```

The `source`/`lock`/`toolchain` inputs are the key move: with them recorded,
`store.invalidate.descendants(oldSourceDigest)` answers *"which CI phases
validated the now-superseded tree?"* — and `lineage.isStale` (below) turns that
into a gate.

### Run derivation — `prx.ci.run/v1`

A roll-up whose **inputs are the phase outputs**, so the phases are its
ancestors in the DAG:

```ts
manifest = {
  producer: "prx.ci.run",
  inputs: {
    install:   "sha256:<install phase result>",
    typecheck: "sha256:<typecheck phase result>",
    docs:      "sha256:<docs phase result>",
    build:     "sha256:<build phase result>",
    test:      "sha256:<test phase result>",
  },
  outputs: { verdict: "sha256:<{passed:true, phases:5}>" },
  contracts: ["prx.ci.run/v1"],
  params: { passed: true, source: "sha256:…", unit: "GH-352" },
};
```

### Why per-phase (the Phase DAG choice)

- **Per-phase invalidation.** `isStale`/`invalidate.descendants` work at phase
  granularity — a docs-only change can invalidate the `docs` phase while
  `typecheck`/`test` (whose inputs didn't change) stay valid.
- **Reuse.** A phase derivation is content-addressed on its inputs; an identical
  phase over an unchanged tree is the same `derivationId` — recordable once,
  referenceable by many runs (idempotent append, as in scout).
- **Honest lineage.** The run verdict is *derived from* its phases, not asserted
  independently — `lineage.ancestors(runId)` enumerates exactly what it rests on.

## Staleness = the merge guard

The store exposes (`packages/anchored-chain/src/store.ts:16`):

```ts
lineage.isStale(
  derivationId: Digest,
  currentRefs: Readonly<Record<string, Digest>>,
): Promise<boolean>;
```

We maintain a ref (e.g. `tree/HEAD`) tracking the current `source` digest. The
merge gate computes the *current* tree digest and asks:

```ts
const stale = await store.lineage.isStale(runId, { source: currentTreeDigest });
// stale === true  → HEAD moved since this green run; re-run required.
// stale === false → this signed green still covers the tree being merged.
```

That converts "CI was green" from a mutable claim into a **verifiable,
tree-bound fact** — the property `local-ci.ts` cannot offer today.

## Signing (mandatory)

Per *everything should be signed*: CI derivations carry a DSSE-signed in-toto
envelope and are validated with `requireSigned: true`. The infra already exists:

- `ed25519Signer(privateKey, keyid)` + `assembleEnvelope(statement)`
  (`packages/anchored-chain/src/signing.ts`, `in-toto.ts`) produce the
  `Derivation.envelope`.
- `validateDerivation(id, store, registry, { verifier, requireSigned: true })`
  (`packages/anchored-chain/src/validate.ts`) rejects an unsigned or
  wrongly-signed derivation when walking the DAG.

**Authority.** `local_ci` is a pipeline actor, so it has a signing identity —
exactly the *"each role signs an in-toto link with its authority"* contract in
`docs/prx/pipeline-orchestrator.md`. The signer is **injected** into the record
path (like `scout`'s `now` injection for determinism), so tests use a fixed test
key and production binds the actor's key via `@bounded-systems/auth`.

> **On scout being unsigned.** `recordScoutReadDerivation` records *integrity
> only* (no `envelope`) because a bare-CLI `scout read` runs under **no actor
> authority** — it has no key to sign with. That is a Phase-1 shortcut, not a
> principle. Under "everything should be signed" it is a gap: scout reads
> performed *within* a pipeline leg should sign with that leg's authority. Track
> separately (see *Follow-ups*); this ADR establishes the signed-by-default bar
> that scout should also meet.

## Wiring

1. **`packages/prx/src/pr-state/ci-provenance.ts`** — a pure builder +
   idempotent recorder, mirroring `scout/src/provenance.ts`:
   `ciPhaseDerivation(phaseResult, inputs, opts)`, `ciRunDerivation(phaseDerivations, opts)`,
   and `recordCiRun(store, runResult, signer, opts)`.
2. **`prx ci --ledger <path>`** — when given, open the chain
   (`openAnchoredChain`), record the phase + run derivations signed by the
   actor, and update the `prx/ci/<unit>` ref to the run's verdict digest. Mirrors
   scout's `--ledger` flag exactly. Absent `--ledger` → today's behavior
   (stderr events), so the surface is additive.
3. **GH-352 projection** — project the run verdict into `.pr/local/pr.json` so
   the local semantic-state read shows the signed CI fact, and the merge guard
   reads the `prx/ci/<unit>` ref + `isStale` rather than scraping log lines.
4. **SLSA export** — reuse the `scoutReadProvenance` projection shape so a CI
   run is exportable as a SLSA Provenance v1 statement (Rekor/slsa-verifier
   portable) without adopting their runtime.

The validation logic itself is untouched: `runCi` still drives the phases; this
adds a recording seam around each phase result.

## Alternatives considered

- **Run-level only (one derivation per run).** Simpler, but loses per-phase
  invalidation and reuse, and makes the verdict an assertion rather than a
  derivation of its phases. Rejected for the Phase DAG.
- **Unsigned, integrity-only (as scout does today).** Detects tampering but not
  forgery; can't answer *who* validated. Rejected — CI has an actor authority,
  so there's no reason to omit the signature.
- **Reuse GitHub's check-run status as the source of truth.** That's the remote
  signal; it isn't content-addressed, tree-bound, or locally verifiable, and it
  doesn't compose with the chain. Kept as a *projection target*, not the record.

## Follow-ups

- Sign `scout` reads performed inside a pipeline leg with that leg's authority
  (close the unsigned gap).
- Key management / rotation for actor signing authorities via
  `@bounded-systems/auth` (out of scope here).
- Remote CI parity: have `.github/workflows/ci.yml` record the same signed
  derivations (the workflow already shells `dist/prx ci`), so local and remote
  greens land in one chain.
