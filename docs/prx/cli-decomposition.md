# ADR — decomposing the `pr-state/cli.ts` monolith

**Status:** accepted · in progress — the spine is built and the migration is
underway (see [Progress](#progress) below). The original plan is retained; the
sections after [Decision](#decision) document what was actually built and the
repeatable recipe + wrinkles discovered in execution.

## Context

`packages/prx/src/pr-state/cli.ts` is **~24,000 lines** — the one entry in the
`MONOLITHS` allowlist (`test/code_health.test.ts`, budget 2,000). The cheap,
cohesive helper clusters have already been extracted into sibling leaves with the
`extract-module` ts-morph codemod (`scripts/codemod/extract-module.ts`), totalling
~2,450 lines out:

- `cli-error.ts` (`CliError`), `cli-types.ts` (result types), `cli-spawn.ts`
  (git/subprocess helpers), `cli-format.ts` (60 `format*` functions),
  `work-agent.ts`, `session-finder.ts`.

What remains is the **interwoven core** — three structures that reference each
other and can't be peeled off as helper clusters:

| Structure | Size | Shape |
| --- | --- | --- |
| `CliDeps` type | ~188 fields | a `typeof <localFn>` map of the dispatcher's own handlers, threaded whole into `runCli` (the test-injection seam) |
| `ParsedCommand` union + `parseCommand` | ~335 variants / ~54 parse fns | the typed-argv layer |
| `runCli` dispatcher | ~215 `if (parsed.command === "X")` branches | the handler bodies |

`CliDeps` is why the easy cuts stalled: it's defined once and depends on ~26
cli.ts-local functions, so no handler can leave while it stays a flat bag.

## Decision

Finish the **spec-driven migration** already proven for `pilot`/`fleet`/`health`/
`docs`/`schemas`/`features` (see `docs/prx/cli-from-spec.md`, code-health §4):
each legacy `if (command === X)` handler becomes a `VerbSpec` whose `run()` lives
in a **feature module**, registered in `verb-registry.ts` and dispatched via
`runSpecVerb`. The dispatcher collapses to *resolve verb → parse (Zod) → run →
print*. `cli.ts` ends as the early-dispatch shim + the shrinking legacy fallback.

The enabling structural move is **dissolving `CliDeps`**: instead of one 188-field
bag, each feature module declares its own small deps interface (the slice it
needs), and the global `CliDeps` shrinks by those fields as each handler leaves.

## The VerbSpec spine — three projections

A `VerbSpec` (`src/cli/verbspec.ts`) is authored once and projected to every
surface (CLI, MCP tool, Anthropic tool, OpenAPI op). Migration showed the CLI
needs three *optional* projections beyond `input`/`output`/`run`. Each was added
with its first consumer; MCP/OpenAPI never consult them (they read `input`/
`output` only):

- **`render(output, input) → string`** — the human CLI view of the structured
  `output`. Absent ⇒ the CLI prints `output` as JSON. (First consumer: `graph`.)
- **`deps: () => C` + `run(input, deps)`** — the per-verb capability slice that
  *replaces* the 188-field `CliDeps` bag. The verb declares the small slice it
  needs, defaults it to the real implementations here, and a test passes its own
  slice straight to `run`. (First consumer: `stately`.) This is the structural
  unlock — every migrated deps-bearing verb deletes its `CliDeps` field(s).
- **`exitCode(output, input) → number`** — a *successful* run mapping its output
  to a non-zero CLI exit (a refusal, or a check that found drift), which legacy
  handlers expressed by returning a code rather than throwing. Defaults to 0.
  (First consumer: `plan-close`; also `remote-ci-check`/`scout-logs`/`repo-checks`.)

The dispatch bridge is `runSpecVerb` (`src/cli/orchestrator-cli.ts`): resolve →
parse (Zod) → run → `render` → `exitCode`. It also (a) surfaces the **first Zod
issue message** on a validation failure (clean errors, not the multi-issue JSON
dump) and (b) maps a contract `ENOENT` to the friendly `prx contract init` hint —
both so every verb inherits the legacy UX.

## Migration recipe (repeatable)

For one handler `X` (top-level and/or `<ns> X` aliases):

1. **Classify deps.** For each helper the handler calls, is it leaf-importable or
   `cli.ts`-local? (`grep "export .* <fn>" src/pr-state/*.ts | grep -v cli.ts`.)
2. **Stage-0 extract** any `cli.ts`-local helper into a sibling leaf *first* — use
   the `extract-module` codemod for a **new** sibling (it carries imports and
   refuses on cycles); append-to-existing-leaf is a manual move. (Done for
   `status-report`, `detectBranchNameFromCwd`→`cli-spawn`, `planClose`→
   `plan-close-bd`.)
3. **Author the verb module** `pr-state/<x>-verb.ts`: Zod `input` (kebab flag
   names as object keys; `positionals` for args), `output` (a `.loose()` Zod
   mirror of the result type is fine — output isn't runtime-validated), a `deps`
   slice defaulted to reals, `run`, and `render`/`exitCode` as needed.
4. **Register** in `verb-registry.ts`.
5. **Route** via the early dispatch in `cli.ts` (before the legacy parse): the
   top-level id, plus each namespace alias intercepted precisely
   (`orchestratorVerb === "<ns>" && orchestratorRest[0] === "<sub>"`) so the rest
   of the namespace stays on legacy.
6. **Delete legacy**: the `ParsedCommand` variant, the parser branch, the
   dispatch branch, the `CliDeps` field(s), and now-dead imports.
7. **Port tests** to the verb boundary: in-process `runCliDirect(..., CliDeps)`
   tests can't reach verb deps (the early dispatch uses the verb's own slice), so
   call `verb.run(input, fakeDeps)` (+ `render`/`exitCode`) directly, or a small
   `parse → run → render → exit` helper for arg-parsing/exit-code cases.
8. **Verify**: `bun run typecheck` · `bun test` · `bun run docs:check` ·
   `bunx depcruise` (no new cycles) · `knip` spot-check (no new dead exports) ·
   smoke each route's `--help`.

## Wrinkles encountered & how they were solved

| Wrinkle | Solution |
| --- | --- |
| Handler depends on a `cli.ts`-local helper (would cycle) | Stage-0 extract the helper to a leaf first (recipe step 2). |
| "Success but non-zero exit" (refusal / drift) | the `exitCode` projection. |
| Thrown-error exit codes needing **stderr** (e.g. scout 64/65) | *not* covered by `exitCode` (that's success-path + stdout); needs a separate error→(stderr,code) seam — deferred. |
| Two-stream output (stdout + a stderr warning/timing line, e.g. `version`/`check-*`) | open; the single-stream `output→render` model doesn't express it yet. |
| CLI-flavored validation messages (`--reason`, "explicit work-unit id") | Zod field/enum `{ error: ... }` + `runSpecVerb` surfacing the first issue message. |
| Entangled multi-path handler (`protect-main` check/apply; `contract` trinity; `pr-comments` show/resolve) | model both paths in one verb (flag-gated `run`, union output, conditional `exitCode`), or split the command first. |
| Imperative arg derivation (`protect-main` `effectiveStrict` cascade, `--allow` spec) | do the derivation in `run`, not the Zod schema; relocate any local parse helper into the verb module. |

## Progress

Migrated to VerbSpecs (each its own PR): `graph`, `actors`, `model`, `skills`,
`open-mode`, `stately`, `overview`, `worktree`/`worktrees`, `status`,
`transition`, `plan-close`, `remote-ci-check`/`scout-logs`, `repo-checks`.
Stage-0 leaves added: `status-report` (`printStatus`/`refreshTaskSignals`),
`plan-close-bd` (the `planClose` driver), `detectBranchNameFromCwd`→`cli-spawn`.
`cli.ts` is down from ~24,039 to ~23,150 lines; `CliDeps` has shed ~10 fields.
The big line-count drop still comes at the **final union/dispatch collapse**
(below), once enough handlers are spec-driven.

Remaining heavy tier (each needs a design choice per the wrinkles table):
`protect-main`, `pr-comments`, `event`/`contract`, and the `plan`/`session`
families.

## Staged plan (each stage = one green PR)

**Stage 0 — remaining shared-helper leaves** (unblockers, like `cli-spawn`):
`cli-id.ts` (canonical-id resolution), `cli-validation.ts` (predicates),
`cli-parse-args.ts` (argv helpers), and the `Output` type → a leaf. (~550 lines.)

**Stages 1–N — handler families**, most self-contained first. Each PR moves a
domain's parser(s) + handler(s) + a local deps slice into a feature module,
registers the verb, deletes the dispatcher branch + `ParsedCommand` variants, and
prunes the now-dead `CliDeps` fields:

1. session (`session`, `session-plan`, `session-open-*`) — ~1.3k lines, the biggest handlers
2. plan (`plan-save/load/show/view/search`) — ~450
3. repos (`repos-*`, `repo-*`) — ~450
4. submit/author (`submit-*`, `author-session`) — ~650
5. doctor/publisher — ~550
6. scout — ~300
7. intake — ~400
8. triage — ~300
9. task/role/agent/dispatch — ~500
10. utilities (`help`, `check-*`, `tools-*`, `keeper`, `sprint`, `init`, `status`, …) — ~1k+

**Final stages — collapse the union/dispatch**: once handlers are spec-driven,
delete the orphaned parse functions and the `ParsedCommand` variants, and flip the
dispatcher from the legacy if-chain to registry lookup. This is where the bulk of
the line count (the ~7k dispatcher + ~1.8k union) actually leaves.

**Honest estimate:** ~15 PRs to clear `MONOLITHS`. The handler-family stages are
mechanical-ish; the final union/dispatch collapse is the delicate part. *(Update:
the early single-verb stages went faster than "families" — ~13 verbs landed as
small per-verb PRs reusing the recipe above; see [Progress](#progress). The line
count barely moved because the bulk still lives in the union/dispatch, which only
collapses once most handlers are spec-driven.)*

## Mechanism

- `extract-module` (existing) handles the **Stage-0 leaves** (declaration moves +
  import fixups + cycle refusal).
- Handler families are **manual + ts-morph-assisted** (move parser+handler+deps
  slice; a small codemod can delete orphaned parse fns and prune `CliDeps`
  fields). The all-or-nothing helper codemod can't rewrite the union/dispatch — a
  dedicated "extract-verb" codemod is optional later.

## Risks & how each stage stays green

- **Live command surface** — `cli.test.ts` (520 cases), the help snapshots
  (`snapshot:help:check`), and the dispatch-parity tests are the safety net; run
  them every stage. Legacy union + spec registry **coexist** through the family
  stages, so behavior is preserved until a verb fully owns its command.
- **Cycles** — feature modules import shared symbols from leaves, never from
  `cli.ts`; dependency-cruiser `no-circular` (now 56) is the guard. The
  `CliError`-leaf repoint already removed 7 cycles; keep that direction.
- **`CliDeps` dumping-ground** — define deps slices in the feature module and
  delete the global fields in the same PR.

## Success metrics

`cli.ts` ≤ 2,000 (out of `MONOLITHS`); all commands reachable (verb or legacy
fallback); `cli.test.ts` + help snapshots green every stage; dependency graph
acyclic; `CliDeps` reduced from ~188 fields to a small shared-primitive core.

## Status — 2026-06 (post-#691)

The registry this decomposition feeds now projects to a fourth surface: the
OpenAPI doc is emitted from `verbRegistry` to `packages/prx/openapi.json`
(drift-gated). Every handler migrated to a `VerbSpec` therefore gains CLI + MCP +
Anthropic + OpenAPI coverage for free — extra pull toward finishing the
migration. `cli.ts` remains the sole `MONOLITHS` entry (~23k lines); the bulk
still leaves at the union/dispatch collapse. See
[`docs/agentic-code-hygiene.md`](../agentic-code-hygiene.md) for where this sits
among the self-check layers.
