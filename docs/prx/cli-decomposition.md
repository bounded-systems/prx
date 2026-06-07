# ADR — decomposing the `pr-state/cli.ts` monolith

**Status:** proposed · **Scope:** plan only (no code changes in this doc)

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
mechanical-ish; the final union/dispatch collapse is the delicate part.

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
