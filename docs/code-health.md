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
- **`bun run health`** — sprawl + the value-prop product map on top of the above.

`madge` remains only for the legacy `no-intake-triage` cycle test (migrate next).

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

Next:
- [ ] Automated changelog workflow (hand-rolled changesets `version` PR, SHA-pinned).
- [ ] Zod **boundary** coverage lens in `health` (`JSON.parse` not `.parse`'d; `z.any()` holes).
- [ ] VerbSpec schema coverage (% of registry verbs with input/output Zod).
- [ ] Migrate `no-intake-triage` test off `madge`; drop `madge`.
- [ ] Scripts → `prx` verbs — template on `prx health`, then the `gen-*` codegen.
- [ ] Decompose `pr-state/cli.ts` (ts-morph codemods, verb-by-verb).
- [ ] Flip `no-circular` to `error` once ratcheted to 0.
