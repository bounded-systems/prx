# prx — code health & modernization status

**Snapshot:** 2026-06-06 · **Refresh:** `bun run health` (+ `bun run typecov`).

This is a point-in-time status doc, not a generated/drift-checked artifact — the
numbers are a snapshot. Re-run the tools to refresh. It captures the honest state
of the codebase, the detection toolchain, the target module architecture, and the
prioritized backlog so the work continues across sessions.

## 1. Snapshot

| Lens | Measure | Tool |
| --- | --- | --- |
| Sprawl | 427 src files, **127,314** lines; largest `pr-state/cli.ts` = **25,617** (next 6,507) | `bun run health` |
| Coupling | **64** circular import edges; `shared-stays-pure` = 0 (the `lib` sink is clean); 8 orphans | dependency-cruiser |
| Dead code | **7** unused files (incl. dead clusters via stale barrels) | knip |
| Types | **99.37%** strict type coverage over non-test source | type-coverage |
| Product | **3 / 4** value props backed; 12 modules traced to a forcing function | `value_props.ts` |

The honest read: one **god file** (`pr-state/cli.ts`, 25.6k lines) is both the
biggest sprawl and the hub of most cycles; ~30 **standalone scripts** sit outside
the `prx` verb surface; the 64 cycles are the measurable symptom of imports
pointing *upward* rather than strictly down.

## 2. Detection toolchain

Replaced the ad-hoc `madge` orphan heuristics with maintained, declarative tools:

- **knip** (`knip.json`) — dead code by reachability from declared entrypoints.
  Catches dead *clusters* a zero-importer scan misses (e.g. `machine/events.ts`
  reachable only through the unused `machine/index.ts` barrel).
- **dependency-cruiser** (`.dependency-cruiser.cjs`) — coupling, and the home for
  the module architecture as gradeable rules (below).
- **type-coverage** (`bun run typecov`, `--strict --at-least 98`) — raw TS type
  coverage as a ratchet floor.
- **biome** (`biome.jsonc`, `bun run lint`) — the style + lint layer: formatter
  plus dead code *inside* a file (unused imports/locals/params, stray `any`) that
  knip's file/export scan can't see. Adopted in warn/ratchet mode; see
  [agentic-code-hygiene.md](agentic-code-hygiene.md).
- **`bun run health`** — sprawl + the value-prop product map on top of the above.

`madge` remains only for the legacy `no-intake-triage` cycle test (migrate next).

## 2a. Flagging & fixing the monolith

**What flags it:** `bun run health` (sprawl lens) names the largest files;
`bunx depcruise … --output-type metrics` ranks them by coupling (Ca/Ce/instability,
so `pr-state/cli.ts` shows as the top hub); ESLint `max-lines` / `max-lines-per-function`
is the canonical per-file linter (heavy to adopt retroactively); SonarJS adds
cognitive-complexity. We use a repo-native **ratchet** instead:
`test/code_health.test.ts` caps source files at 2,000 lines with a shrinking
`MONOLITHS` allowlist — no *new* monolith can land, and offenders only leave the
list by being split.

**What fixes it:** **ts-morph** (TS compiler API) for the codemods — move
declarations, split files, rewrite imports — applied verb-by-verb as each
`pr-state/cli.ts` handler becomes a registered VerbSpec whose body lives in a
feature module (§4). `jscodeshift` is the alternative.

## 2b. Packaging, rebuilds & extraction

- **Tree-shaking:** `sideEffects: false` set on all 19 `@bounded-systems/*` leaf
  packages (the CLI app keeps its entrypoint side effects). Combined with ESM +
  the acyclic rule, bundlers/consumers can drop unused exports.
- **Extraction readiness** is already gated per-package by `extractability.test.ts`
  (a package may import only node builtins + its own barrel — any other edge means
  an upward dep). The monorepo-internal twin is now a dependency-cruiser rule,
  **`prx-is-the-top`** (`error`, currently 0): no leaf may import the `prx` app.
  A concern earns its own repo only with a stable contract + external consumers +
  independent cadence + green extractability (`cas` qualifies; `pr-state` can't
  until decomposed).
- **Per-package nix derivations (planned, not yet landed):** `flake.nix` today
  fetches released binaries via `fetchurl`. The rebuild/cache win is a derivation
  *per package* (each hashed by its own inputs) so a leaf change doesn't bust
  unrelated builds — ~80% of the separate-repo caching benefit without the
  cross-repo coordination tax. Prereq: the acyclic graph above. (No nix in CI yet;
  spike pending.)

## 3. Target module architecture

bobby's rule: **"parents import children; shared is one global module; you always
click DOWN, never up."** Formally that is an **acyclic downward dependency graph
with a single shared sink** (`src/lib`). It is encoded as dependency-cruiser
rules, `warn`/`info` today (a measurable backlog), flipped to `error` per rule as
its count hits zero:

- `no-circular` (64) — every cycle is an up-edge; drive to 0, then `error`.
- `shared-stays-pure` (0) — `src/lib` may import nothing app-specific. Already clean.
- `no-orphans` (8) — cross-check with knip before deleting.

## 4. The convergence

Three stated goals collapse into **one** refactor:

1. **Scripts → one `prx` surface.** Every `scripts/*.ts` and `gen-*.ts` becomes a
   registered **VerbSpec** (`docs/prx/cli-from-spec.md`), projected to CLI / MCP /
   Anthropic / OpenAPI. A drift test fails on any new top-level script.
2. **Decompose the god file.** Each `pr-state/cli.ts` handler body moves to its
   verb's `run()` in a feature module — which *is* step (1) applied to the CLI.
3. **Module rule.** Those feature modules import strictly downward, shared in `lib`.

Mechanically: a **parse → normalize → codegen** pipeline using **ts-morph**
(TS compiler API) — parse the tree, normalize to the conventions (hoist shared,
flip up-imports down, split barrels, dedupe), re-emit. "Author once, project
everywhere" turned on the code itself. Execute as assisted codemods with the test
suite + the gates above as the safety net — never big-bang.

## 5. Backlog

Landed (PR #290 / #282):
- [x] Single owner-of-effect map (`ownersOf` in `@bounded-systems/policy`).
- [x] `provenance-ownership.feature` + faithfulness test (§2 verify gate).
- [x] Modern code-health tooling (knip, dependency-cruiser) + `bun run health`.
- [x] `type-coverage` ratchet gate (`bun run typecov`).
- [x] Re-grounded `docs/capability-orchestrator.md` (#282).

Also landed:
- [x] Automated changelog workflow (`.github/workflows/version.yml`, SHA-pinned).
- [x] Schema-first health report (`src/health/model.ts` → `schemas/health/`).
- [x] `sideEffects: false` on all 19 leaf packages (tree-shaking).
- [x] `prx-is-the-top` layering rule (`error`, 0) + monolith ratchet (≤2000 lines).
- [x] Generated CLI reference (`docs/cli.md`) + GitHub Pages site (`pages.yml`).
- [x] Migrated the intake-cycle guard to dependency-cruiser; dropped `madge`.
- [x] Zod **boundary** lens in `health` (`z.any()`/`z.unknown()` holes; `JSON.parse` sites).
- [x] **Auto-docs-PR workflow** (`.github/workflows/docs-regen.yml`) — on push to `main`,
      `docs:render` and open a "docs: regenerate" PR when a generated doc drifts. Owns
      `docs/cli.md` (and the rest) so they stay current without hard-gating feature PRs.
- [x] **VerbSpec coverage** lens in `health` — spec-driven-CLI readiness: share of the
      command registry declaring the GH-1242 substrate (`args` input Zod, typed `event`).
      A coverage ratchet toward full `VerbSpec`; today ~1% input / 0% event.
- [x] **Scripts-delegate guard** (`test/architecture/scripts-delegate.test.ts`) — the §4
      forcing function: every `scripts/*.ts` must import from `../src/` (delegate to the
      prx library / a verb) unless baselined as standalone build/infra tooling. The
      `SCRIPT_BASELINE` only shrinks. All five value props are now forcing-function-backed
      (`features/*.feature`); STATUS 5/5.

Next:
- [~] Scripts → `prx` verbs — **template landed**: `prx health` is now a spec-driven
      `VerbSpec` (`src/health/verb.ts`) sharing `computeHealthReport()` with the
      `bun run health` script; dispatched via `verb-registry.ts`. Remaining: migrate
      the `gen-*` codegen + `export-*` schema scripts onto the same pattern.
- [ ] Decompose `pr-state/cli.ts` (ts-morph codemods, verb-by-verb) → shrink `MONOLITHS`.
- [ ] Per-package nix derivations (spike) + flip `no-circular` to `error` once ratcheted to 0.
