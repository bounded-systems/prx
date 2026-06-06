# spike: effect-typed CUE spec unifying the prx actor-model invariants (+ Rule 4, MCP-as-projection)

**Type:** spike (task + kind=spike) · **Priority:** P2

## Context

Three open epics each tackle one axis of the prx surface in prose, but there is
no single machine-checkable model that enforces them, and one axis (per-verb
write effects) is unfiled. The Zod registry (`src/cli/registry.ts` +
`registry.data.ts`, GH-974) carries a 4-value `domain` field and per-tool-actor
`emits:[]` events, but **no per-verb read/write surface** and no enforceable
grammar. Per-verb `--help` is still unwired (GH-974/975).

This spike adds the **enforceable layer**: an **effect-typed actor model** in
**CUE** that encodes all four invariants as types, so a violating surface fails
`cue vet`. CUE not OpenAPI — OpenAPI models HTTP resources, while our
load-bearing facts are *effects* (which surface a verb mutates), which OpenAPI can
only carry as `x-` extension soup. The CUE spec becomes canonical; the CLI table,
help sitemap, an OpenAPI doc, and an **opt-in, default-off MCP manifest** are all
*projections* of it. MCP defaults off because every exposed tool's schema is
injected into the model context each session (token cost).

## The four invariants (encoded as CUE types in `spec/prx/schema.cue`)

Rules 1–3 already have open epics; this spike unifies them under one checkable
schema and **adds Rule 4 + the MCP decision**:

1. **Every first arg is an actor** — `prx <actor> <verb>`; no loose top-level verbs. *(epic: GH-1242)*
2. **Every actor has `agent`** — the uniform headless operator (required, no default). No special cases, help included. *(epic: GH-2025)*
3. **No surface as an actor** — `beads` is a `#Surface`, never an actor. (`dolt`, `sync` flagged same category — confirm.) *(design: GH-1933)*
4. **One write surface per verb** *(NET-NEW)* — `writes: #Surface | *null`; two-surface mutation is structurally unrepresentable. Cross-store propagation splits into a canonical write + a separate single-surface projection.

## Current violations (hand-linted from the catalog; reproducible via `spec/prx/gen-current.py`)

- **Rule 1** — ~12 loose verbs: `tui, next, do, review, scratch, ultrareview, ci, phase, snapshot, statusline, actions, init`.
- **Rule 2** — only 5/~42 comply (`intake, triage, submit, implement, author`); ~35 actors need an `agent` or need to prove they aren't actors.
- **Rule 3** — `beads` (explicit), plus `dolt` and `sync` are surface-shaped actor keys.
- **Rule 4** — two-surface mutators cluster in the mirror/reconcile family: `delegate assign` ("bd-canonical; mirror projects to GH"), `beads publish` ("bd→GH mirror"), `beads sync`/`sync issues` (bidirectional reconcile), `submit publish` ("push + gh pr create"). Fix = split each into write + projection.

## Deliverables

- [x] `spec/prx/schema.cue` — the four invariants as enforceable CUE types (DONE in spike branch).
- [ ] `gen-current` generator — projects `prx help-all` → `surface.current.cue` + lint report. Prototyped in Python on the spike branch, but **omitted from this integration**: the repo enforces a zero-exemptions no-Python invariant (`test/no-operational-python.test.ts`). Reimplement as TypeScript, consistent with the "Authoring IDL = Zod" decision below.
- [ ] `spec/prx/surface.current.cue` — today's surface as data; its `cue vet` failures = the migration backlog.
- [ ] `spec/prx/surface.proposed.cue` — redesigned map: beads dissolved to a surface, `agent` on every actor, the 4 reconcile verbs split.
- [ ] Decide MCP scope: confirm default-off + the `agent`-verbs-only allowlist.
- [ ] **Authoring IDL = Zod (DECIDED 2026-05-29).** Rationale: the registry is
      already Zod and already generates the CLI + help; TypeSpec would add a
      DSL hop (`TypeSpec→Zod→CLI`) through immature tooling
      (`bterlson/typespec-zod` is pre-release on the unreleased emitter
      framework; `@typespec-tools/emitter-zod` is ~1yr stale) to re-derive what
      we have. Even TypeSpec's MCP emitter bottoms out at Zod. OpenAPI comes
      from Zod directly via `zod-to-openapi`. Smithy/TypeSpec = trait-taxonomy
      reference only. Build: extend `CommandSpec` with `reads`/`writes`/`mcp`/
      `caps` traits on **2–3 actors** (`intake`, `triage`, `delegate` — exercise
      all four rules incl. the Rule-4 `delegate assign` split) + emitters
      (MCP manifest, OpenAPI, CUE/Zod-refine gate).
- [ ] Wire `cue vet` (install `cue`; add to `prx ci`).

## IDL landscape (one source of truth → CLI / TUI / MCP / OpenAPI / docs)

The prx object is a *workflow* (Artifact / Transition / Contract / Capability /
Actor / Verb), not an HTTP service — so OpenAPI is the wrong root. The
discriminator across IDLs is whether **effects** (which surface a verb mutates)
and **capabilities** (which actor may dispatch which verb) are first-class.

| IDL | Effects/caps as first-class? | Codegen | Fit |
|---|---|---|---|
| OpenAPI / JSON Schema | no (only `x-` extensions) | mature | data shapes only — wrong root |
| **Smithy** | **yes — `@readonly`/`@idempotent` built-in traits; custom `@writes`; resource lifecycle** | SDK/docs/CLI | philosophically closest to the transition-contract model |
| TypeSpec | via decorators; compiles to OpenAPI/JSON Schema/Protobuf | best authoring DX, multi-target | strong if we want author-once-emit-many |
| CUE | constraints-as-types (great for invariants) | weak (custom tooling) | the policy/lint LAYER, not the codegen root |
| **Zod** (current registry) | add trait fields to `CommandSpec` | custom emitters | already here (218 entries) + already generates dispatch — **CHOSEN** |

> **TypeSpec→Zod assessed & rejected (2026-05-29):** emitters exist but are
> immature (`bterlson/typespec-zod` pre-release; `@typespec-tools/emitter-zod`
> ~1yr stale), and routing `TypeSpec→Zod→CLI` re-derives a Zod registry we
> already maintain. OpenAPI emits from Zod via `zod-to-openapi`; MCP emits from
> Zod (TypeSpec's own MCP emitter bottoms out at Zod anyway).

Note the data-plane is already JSON-Schema'd (the contract trinity:
`schemas/contracts/{agent,artifact,transition}.json`) while the surface-plane is
Zod. The real move is unifying both under one trait-bearing model. Decision lean:
**extend the Zod registry** with `reads`/`writes`/`mcp`/`caps` traits (avoids a
218-entry migration), keep CUE/Zod-refine as the invariant gate, and write
emitters (registry → help / MCP manifest / OpenAPI / docs). Smithy/TypeSpec are
reference designs to steal trait concepts from, not necessarily to adopt.

## Acceptance criteria

- CUE schema encodes all four invariants such that a violating instance fails `cue vet`.
- `surface.current.cue` is generated (not hand-maintained) and its vet failures enumerate the migration tasks 1:1.
- A written decision on: (a) dolt/sync as surfaces vs actors, (b) MCP default-off + allowlist, (c) the write/projection split pattern for the reconcile family, (d) **the authoring IDL**, backed by the trait-Zod-vs-TypeSpec prototype diffs (not asserted upfront).
- No code behavior change in this spike — spec + prototype + lint + decision memo only.

## Prior art in-repo (this is half-built already — don't green-field it)

- **Data plane already modeled**: contract trinity `schemas/contracts/{agent,artifact,transition}.json` (`npm run schemas:export`).
- **Surface plane already generates the CLI**: Zod `CommandSpec`/`ActorSpec` in `src/cli/registry.ts` + `registry.data.ts` (218 entries) → dispatch table + help sitemap. The spike's job is to ADD the missing `effects`/`caps` traits and unify the two planes, not invent a model.
- **Capabilities live in a separate file today**: per-actor allowlists/dispatch targets in `src/machine/runtime_profiles.ts` (7 session profiles) + `src/machine/actors.ts` (`emits[]`). Rule-2/Rule-4 work should fold these into the verb traits rather than leaving caps split across three files.

## Links / lineage

- **relates GH-1242** — epic: collapse CLI to `prx <actor> <action>`, hard-remove flat verbs (Rule 1).
- **relates GH-2025** — epic: universalize `prx <actor> agent` (Rule 2).
- **relates GH-1933** — design: retire prx beads namespace → verb-noun shapes (Rule 3).
- **relates GH-974 / GH-975** — Zod registry-backed help surface; this CUE spec is its enforceable layer.
- **relates GH-1816** — git capability broker (adjacent to Rule 4 per-actor effects).
- **context GH-1545** — auto-mode hard-blocks `prx intake` writes (filing-path caveat).
