# Capability-package consolidation — granularity of the `@bounded-systems/*` seams (spike)

> Design-only spike. No `src/`/`packages/` changes in this unit — the
> **diagnosis, the decision criteria, and the migration recipe are the
> deliverable**. Written 2026-06-19. Companion to
> [`docs/agentic-code-hygiene.md`](../agentic-code-hygiene.md) and
> [`docs/code-health.md`](../code-health.md).

## 0. Status

**Proposed — not decided.** Records a real shape mismatch: prx has **22**
sibling `@bounded-systems/*` packages, and roughly a third are sub-100-LOC,
single-file capability seams carrying full package machinery. The seam itself is
valuable and enforced; the question is *packaging granularity*, not whether the
boundary should exist. (The docs still say "19 leaf packages" — already drifted,
which is itself a small symptom.)

## 1. The mismatch

Several leaves are tiny but each carries ~6 files of packaging overhead
(`package.json` + `tsconfig.json` + `tsconfig.build.json` + `jsr.json` +
`README.md` + `extractability.test.ts`) around ~50 lines of code:

| package | src LOC | role |
|---|---:|---|
| `host` | 43 | the one reader of host/OS ambient state |
| `env` | 51 | the one reader/writer of `process.env` |
| `fs` | 62 | the filesystem capability seam |
| `cas` | 67 | content-addressed storage substrate |
| `repo-root` | 76 | repo-root resolution |
| `audit-context` | 87 | ambient audit attribution |
| `disposition` | 116 | pure work-unit classifier |
| `auth` | 183 | service-credential resolver |

The seam is **genuinely good and enforced** — `ambient-authority-guard.test.ts`
holds `src/` at zero raw `process.env` / `node:os` / spawn. This spike does not
touch that. It questions only whether each seam needs to be its own *published
package* versus a folder inside one.

## 2. The criterion already in the repo

`docs/code-health.md` §2b states when a concern earns its own repo: **a stable
contract + external consumers + independent cadence + green extractability**.
Apply the same test to "earns its own *package*":

- **Qualifies (keep):** `cas`, `verbspec`, `anchored-chain`, `scout`, `slack` —
  stable contracts, plausible external consumers, independent cadence.
- **Fails "external consumers / independent cadence" (candidates to fold):** the
  pure ambient seams — `env`, `host`, `fs`, `proc`, `repo-root`, `audit-context`.
  They exist to make ambient authority a visible import edge, not to be consumed
  externally on their own cadence.

## 3. Options

| option | shape | verdict |
|---|---|---|
| A — status quo | one package per seam | rejected: ~6× packaging tax per seam, and the count keeps drifting from the docs |
| B — fold all tiny leaves into one | `@bounded-systems/capabilities` | rejected: sweeps in `cas`/`disposition` which have independent value |
| **C — two-tier (recommended)** | keep value-bearing leaves; fold the pure ambient seams into one `@bounded-systems/capabilities` with sub-path folders (`env/`, `host/`, `fs/`, `proc/`, `repo-root/`, `audit-context/`) | preserves the seam (folders + the guard) at ~1/6 the overhead |

C keeps the import graph honest: `@bounded-systems/capabilities/env` is still a
visible edge, the ambient-authority guard is unchanged, and one
`extractability.test.ts` covers the bundle.

## 4. Migration recipe (when scheduled)

1. **Cross-check the published set first.** Some leaves are on npm/JSR (the
   `jsr:publish` READY set, see `.changeset/jsr-ready-*.md`). A published seam
   can't be folded without a deprecation cycle (a `@bounded-systems/env` →
   `@bounded-systems/capabilities/env` shim that re-exports, deprecated). Fold
   the **internal/unpublished** seams first; deprecate the published ones.
2. **ts-morph codemod** to rewrite imports `@bounded-systems/<seam>` →
   `@bounded-systems/capabilities/<seam>` across `src/`, `test/`, and `tsconfig.json`
   `paths`.
3. **Merge** the per-seam `extractability.test.ts` into one for the bundle;
   keep the ambient-authority guard untouched.
4. One changeset; the seam folders stay so the dependency graph still shows the
   boundary.

## 5. Forcing function

Add a lightweight ratchet: a test that flags a new sub-100-LOC package unless
it's on an allowlist with a one-line justification (the `MONOLITHS` pattern,
inverted — a *minimum* viable package size). Keeps granularity a deliberate call,
not an accident.

## 6. Decision needed

Confirm tier C and the keep/fold split in §2, then file the migration as its own
work unit. Until then this doc is the design input; no code moves.
