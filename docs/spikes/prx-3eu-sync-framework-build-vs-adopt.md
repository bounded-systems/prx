# prx-3eu — Sync agent: adopt a sync framework, or build bespoke? (ADR)

> Design-only spike. Settles the build-vs-adopt question the operator raised for
> the sync-agent epic (`prx-697`) before any more reconcile code is written. No
> `src/`/`packages/` changes in this unit — the decision is the deliverable.
> Written 2026-06-07.

## 0. Status

**Accepted.** Keep **dolt** as the data-sync framework (already adopted); keep
the bd↔GitHub reconcile **bespoke** (it is a cross-system transform, not replica
sync); do **not** adopt a generic sync/CRDT framework. The "sync agent" is an
*orchestrator* over dolt + the existing reconciler, not a new framework.

## 1. The two layers

Sync here is two distinct problems, and conflating them is the trap:

1. **Data-sync layer — bd's storage.** bd is dolt-backed. Dolt *is* a sync
   framework: git-for-data with branches, merge, remotes, `push`/`pull`, and
   first-class conflict detection. Distributed convergence of the bead store is
   already solved by dolt. `prx-57l` (push durability) leverages exactly this —
   the daemon's refresh runs `dolt reconcile` (commit→pull→push).

2. **Application-reconcile layer — bd ↔ GitHub.** Mapping bead records to GitHub
   issues: `external_ref` pins, drift-fix axis sync, dedupe, the budget-gated
   `sync/run` tick. This is a *transform/reconcile between two different systems*
   (different schemas, auth, rate limits, write semantics), not replication of
   one shared model.

## 2. Why not a generic sync/CRDT framework for layer 2

| Candidate | Model it assumes | Why it mismatches bd↔GH |
|-----------|------------------|--------------------------|
| Automerge / Yjs (CRDT) | many replicas of **one** document/model converge | bd and GH are **different** models; there is no shared replica to converge — there is a mapping to maintain |
| ElectricSQL / PowerSync | a server DB ↔ client replicas of the **same** schema | GitHub is not our DB; it is a foreign API with its own issue schema, rate limits, and auth |
| A bespoke transform/reconcile loop | a declarative diff between two heterogeneous systems | ✅ this is the actual shape; `sync/run` already does idempotent reconcile ticks |

Adopting a replica-sync framework for a cross-system transform adds a dependency
and an impedance mismatch without removing the domain logic (the bd↔GH field
mapping) that is the actual work.

## 3. What we *do* adopt

- **dolt** for all data-layer sync/durability/conflict (layer 1) — already in.
- The **reconciler-loop discipline** for layer 2 (idempotent, declarative diff,
  re-runnable ticks) — already how `sync/run` is built; keep and extend it.

## 4. Consequence for `prx-697`

Proceed with the bespoke reconcile, routed through the daemon:

- `prx-fda` — route the bulk **readers** (`sync/run`, `backfill`, `dedupe`,
  scout-graph) through `loadAllBeadsViaDaemon`.
- `prx-ebo` — route **drift-fix** writes through the daemon helpers.
- `prx-h4b` — the sync-agent **actor** is an orchestrator (owns the reconcile +
  the dolt push), not a framework wrapper; gate its bd/gh/dolt capabilities.

No new sync-framework dependency is introduced.
