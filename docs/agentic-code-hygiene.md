# Agentic code hygiene — a self-checking codebase

Most of the code in this repo is written by an agent. That moves the cost center
from *authoring* code to *trusting* it. Two goals are in tension and this doc is
how they're reconciled:

1. **Generation must stay low-friction** — an agent (or human) should be able to
   add a verb or a feature without first reading 134k lines.
2. **The codebase must check itself** — trust should be *mechanical*, produced by
   tools that run on every change, not by reviewer vigilance that doesn't scale to
   agent throughput.

The doctrine that satisfies both: **every quality property is a forcing
function** — machine-checked, ratcheted, and self-documenting. A property that
isn't enforced by a tool or a test is not a standard; it's a wish, and an agent
will regress it the first time it's convenient.

## The self-check layers

Each layer answers one question about a change. Together they make "is this code
good?" a set of deterministic checks instead of a judgement call.

| # | Layer | Question | Mechanism | State |
|---|-------|----------|-----------|-------|
| 1 | **Shape & style** | Does it read like the codebase? | **Biome** (format + lint) · TS strict | **new** (this PR) |
| 2 | Liveness | Is it reachable / used? | `knip` | have |
| 3 | Structure | Do imports point *down*? | `dependency-cruiser` · ≤2000-line size ratchet | have (64-cycle backlog) |
| 4 | Capability & safety | Does it respect the boundaries? | ambient-authority guard · `extractability.test.ts` (×22) · `@bounded-systems/policy` | have (env/os/spawn at **0**) |
| 5 | Behavior | Does it do what it *claims*? | `*.feature` tests · `value_props.test.ts` forcing functions · `--help` snapshots | **thin** (5 features) |
| 6 | Truth | Do the docs match the code? | drift-checked generated docs (README, `prx.jsonld`, `cli.md`, `STATUS`, this context) · schema export | have |
| 7 | History | Is the change recorded? | changesets → changelog · `docs-regen.yml` auto-PR · signed CI provenance | have |
| 8 | Self-report | Can it measure itself? | `bun run health` / `prx health` · `/claims-audit` | have |

Layers 2–8 already exist (see [`docs/code-health.md`](./code-health.md) for the
detection toolchain and the architecture ratchets). Layer 1 was the gap — there
was no formatter and no lint engine anywhere in the workspace, only TS-strict and
the size ratchet.

## What makes a check *agent-friendly*

Detection isn't enough; the check has to actively *help* the next change. Five
properties separate a gate that helps from one that just blocks:

1. **Local & deterministic.** It runs under `bun test` or a single binary — no
   network, no service. The agent gets the same answer the reviewer will, in one
   fast loop.
2. **Self-documenting failure.** The error message *is* the next action:
   "route through `@bounded-systems/proc`", "now under budget, remove from
   `MONOLITHS`". For an agent this is decisive — the gate teaches the fix instead
   of just reporting a violation.
3. **Ratchet, not gate-all.** Every gate is a *shrinking allowlist* —
   `MONOLITHS`, `SPAWN_BASELINE`, the type-coverage floor, and now lint rules at
   `warn` driven toward `error`. An agent can land incremental work without
   paying down the whole backlog, but it can never make the number worse.
4. **Generated, not maintained.** Docs and changelogs are projected from sources,
   so forgetting to update them is impossible — drift is a red check, not a stale
   file. The agent edits the source; the artifact follows.
5. **One source, many surfaces.** A `VerbSpec` is authored once and projected to
   the CLI, MCP, the Anthropic tool schema, and the OpenAPI document
   (`packages/prx/openapi.json`, generated + drift-gated), so those surfaces
   can't drift from each other. (See [`docs/prx/cli-from-spec.md`](./prx/cli-from-spec.md).)

## Biome in this frame (layer 1)

Biome fills the one missing layer. It is a formatter + linter + import-organizer
in a single Rust binary, and it **complements rather than duplicates** the
existing tools:

- **Not redundant with `knip`.** Knip sees dead *files and exports*; Biome sees
  dead *imports, locals, and parameters inside a file*. Today's baseline —
  **50 unused imports, 24 unused parameters, 3 unused locals, 5 `any` in `src`**
  — is invisible to every other tool in the repo.
- **Adopted in ratchet mode.** A curated, high-signal rule set, all at `warn`, so
  nothing blocks today (`biome.jsonc`). The path is the same as
  `.dependency-cruiser.cjs`: drive a rule's count to 0, then flip it to `error` to
  lock the property in.
- **Formatter scoped to hand-written TypeScript.** Generated docs (`*.md`), the
  JSON-LD graph, exported JSON schemas, drizzle migrations, and test
  fixtures/snapshots are projected from sources and are excluded — a formatter
  fighting a generator is drift, not cleanup (layer 6).

Two follow-ups, deliberately *not* in the adoption PR so the signal stays
reviewable:

- **The reformat.** `bun run format:write` touches ~908 of 1219 files (expected
  for a never-formatted tree). Land it as one dedicated commit and add its SHA to
  `.git-blame-ignore-revs` so it doesn't pollute `git blame`.
- **The gate.** Once the `warn` counts are driven down, wire `bun run lint` into a
  ratchet test (the shape of `test/code_health.test.ts`) so the counts can only
  shrink.

## The honest gaps (the next ratchets)

This system is strong on layers 2–4 and 6–8 and weak where it matters most for
agent-written code:

- **Behavior (layer 5) is thin** — 5 `.feature` files for 5 value props. The
  richest source of agent defects is *plausible-but-wrong behavior*, which only
  behavioral/contract tests catch; type-checks and lint never will. This is the
  highest-leverage place to invest next.
- **Lint is warn-only** and the reformat isn't applied — layer 1 is wired, not yet
  enforced.
- **`no-circular` is still 64** (warn) — flip to `error` at 0.
- **`VerbSpec` coverage is ~1%** — property 5 above is mostly potential, not yet
  realized across the command surface.

## Roadmap — open threads (capture)

So nothing is lost: every thread this doctrine surfaced, with its status and home.
Done items shipped in [#691]; queued items are scheduled work; spikes are
design-only docs awaiting a decision before any code moves.

| Thread | Layer | Status | Where |
|--------|-------|--------|-------|
| Biome — format + lint | 1 (shape) | **done** (#691) | `biome.jsonc` |
| Agentic-hygiene doctrine | — | **done** (#691) | this doc |
| verbspec's OpenAPI surface | 5/6 (truth) | **done** (#691) | `packages/prx/openapi.json` |
| Repo-wide `format:write` (~908 files) + `.git-blame-ignore-revs` | 1 | **queued** (own PR) | — |
| Ratchet `noFocusedTests` / `noDoubleEquals` `warn` → `error` (both at 0) | 1 | **queued** | `biome.jsonc` |
| OpenAPI polish — `components/schemas` hoist + Pages site | 6 | **queued** | `src/cli/openapi.ts`, `scripts/build-site.ts` |
| Capability-package consolidation | 4 (capability) | **spike** | [`spikes/capability-package-consolidation.md`](./spikes/capability-package-consolidation.md) |
| Behavior / property testing | 5 (behavior) | **spike** | [`spikes/behavior-property-testing.md`](./spikes/behavior-property-testing.md) |
| AST convention enforcement | 1 & 3 | **spike** | [`spikes/ast-convention-enforcement.md`](./spikes/ast-convention-enforcement.md) |
| Decompose `pr-state/cli.ts` | 3 (structure) | **in progress** (ADR) | [`prx/cli-decomposition.md`](./prx/cli-decomposition.md) |
| Finish the VerbSpec migration (past ~1%) | 5 | **in progress** (ADR) | [`prx/cli-from-spec.md`](./prx/cli-from-spec.md) |

[#691]: https://github.com/bounded-systems/prx/pull/691

## Adding a new check

A new gate earns its place only if it is **local & deterministic**, **ratcheted**
(a baseline that only shrinks), **self-documenting** (the failure states the fix),
and ideally **generated** from a source of truth. Prefer extending one of the
eight layers over inventing a parallel mechanism — the point is a small set of
checks an agent can internalize, not a sprawl of one-off scripts.
