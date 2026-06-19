# AST convention enforcement — structural rules an agent can't violate (spike)

> Design-only spike. No `src/`/`packages/` changes in this unit — the
> **diagnosis, the tool choice, and the first rule are the deliverable**.
> Written 2026-06-19. Companion to [`docs/agentic-code-hygiene.md`](../agentic-code-hygiene.md)
> (layers 1 & 3) and [`docs/code-health.md`](../code-health.md).

## 0. Status

**Proposed — not decided.** prx already encodes architecture as enforceable
rules (`dependency-cruiser`, the ratchet tests). But several guards are written
as **regex over source text** — the poor-man's AST. This spike proposes
upgrading the structural guards to real AST matching, and using the same engine
to encode house conventions that an agent would otherwise quietly break.

## 1. The regex ceiling

`test/architecture/ambient-authority-guard.test.ts` enforces "no ambient
authority" with regexes:

```
const ENV_RE   = /\bprocess\.env\b|\bBun\.env\b/;
const OS_RE    = /\bfrom\s+["']node:os["']/;
const SPAWN_RE = /\bchild_process\b|\bspawnSync\b|\bBun\.spawn\b|.../;
```

These work, but a regex over source has known failure modes: it false-positives
on the token inside a comment or string, and it misses forms it didn't enumerate
(aliased imports, `globalThis.process`, computed access). It also can't express
*relational* rules ("this call, but only inside that kind of function").

## 2. The upgrade: match the AST, not the text

Two engines fit a Bun + TS monorepo, and they are complementary:

| engine | shape | best for |
|---|---|---|
| **Biome GritQL plugins** | rules authored in GritQL, run *inside* the Biome linter (already a dep as of #691) | lint-style conventions that want per-rule severity + the ratchet you already adopted; **no new tool** |
| **ast-grep** | standalone tree-sitter matcher (`sgconfig.yml` rules, `sg scan`) | cross-cutting structural rules **and** codemods — it doubles as a lighter codemod engine alongside `ts-morph` |

## 3. Conventions worth encoding

Beyond replacing the ambient-authority regexes with precise structural matches:

- **No raw `process.env` / `node:os` / subprocess spawn outside the capability
  packages** — the existing guard, made AST-precise (no comment/string false
  positives, catches aliases).
- **Every `VerbSpec.run` consumes its parsed `input`** — flags dead-input verbs
  where the schema and the body have drifted apart.
- **No direct `node:fs` / `fetch` outside `@bounded-systems/fs` / a fetch
  capability** — the same "visible edge" rule, extended.
- **Test hygiene** — no focused tests (`.only`); already covered by Biome's
  `noFocusedTests`, a precedent for the GritQL approach.

## 4. Recommendation

1. **Start in Biome GritQL** — one rule that re-expresses a single
   ambient-authority check structurally, adopted at `warn` then ratcheted to
   `error` (the same path as the lint rules in #691). No new dependency, and it
   proves the engine on a rule we already trust.
2. **Add ast-grep** when the first *codemod-shaped* convention appears (a rule
   that also auto-fixes), since it unifies "lint the shape" and "rewrite the
   shape" — complementing `ts-morph` for the heavier `cli.ts` decomposition.
3. Migrate the regex guards rule-by-rule; keep each as a ratchet so nothing
   regresses during the move.

## 5. Forcing function

Each AST rule is a ratchet (warn → 0 → error), exactly like the dependency-cruiser
rules and the Biome lint set. The win is qualitative: the guard stops being a
string search and becomes a statement about the program's structure — and the
failure message can point at the exact node, which is what makes a gate
*self-documenting* for the next agent (doctrine property #2).

## 6. Decision needed

Approve the Biome-GritQL-first path and the first rule to port, then file as a
work unit. This doc is the design input; no code yet.
