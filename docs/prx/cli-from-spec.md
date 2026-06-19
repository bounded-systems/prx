# ADR — a spec-driven CLI: author verbs once, project everywhere

> Spike `spike/pipeline-driven-task`. Status: proposed, with a working slice
> (`packages/prx/src/cli/verbspec.ts` + `pilot-verbs.ts`).

## Problem

`prx`'s surface is a ~25k-line `cli.ts` of hand-rolled handlers. `registry.data.ts`
lists commands but carries no per-verb argument or output schema (the GH-974/975
gap — "per-verb option lists are not yet in the registry"). Consequences: help
text, arg parsing, validation, the MCP server, any HTTP/OpenAPI surface, and the
agent tool schemas are all authored (or would be) separately and drift.

## Decision

**Author each verb once as a `VerbSpec` whose input/output are Zod schemas.
JSON Schema (`z.toJSONSchema`) is the projection IR. Every surface is a pure
projection. `cli.ts` becomes a thin router + pretty-printer.**

```
VerbSpec (Zod — canonical, runtime + static, no build step)
  └─ z.toJSONSchema ──▶ JSON Schema (draft 2020-12, the interchange IR)
        ├─ toCli (parseArgs + toHelp) ──▶ argv → typed input, `--help`
        ├─ toMcpTool             ──▶ { name, description, inputSchema }
        ├─ toAnthropicTool       ──▶ { name, description, input_schema }
        └─ toOpenApiOperation    ──▶ POST /{id} (requestBody/response schemas)
```

### Why Zod-canonical (and not the alternatives we weighed)

| candidate | verdict |
| --- | --- |
| **Zod → JSON Schema** | **Chosen.** Already pervasive in prx; runtime validation **and** static types; `z.toJSONSchema` is native in zod 4; no codegen/FFI. Matches core.md ("structured outputs as enforceable specs… use Zod"). |
| OpenAPI as canonical | Great *projection*, awkward to *author* CLI verbs in (HTTP-resource-shaped). |
| MCP tool as canonical | Its inputSchema *is* JSON Schema — so it's a projection target, not the authoring format (raw JSON Schema loses TS types + ergonomics). |
| gRPC / protobuf | Adds a codegen + FFI boundary to a single-language TS monorepo; proto's type system is weaker than JSON Schema (oneofs/optionals/constraints lossy); RPC-shaped, not verb-shaped. |

JSON Schema is the hub: MCP, OpenAPI, and Anthropic tool-use all consume it, so
"author once" is real, not aspirational.

## The slice (proven)

`pilot` and `fleet` are authored as `VerbSpec`s (`pilot-verbs.ts`); their `run`
drives the real machines. `verbspec.test.ts` (7 tests) shows one schema seen
from four sides with no drift:

- **CLI** — `parseArgs(pilotVerb, ["GH-5","--retreatBudget","2"])` → validated
  `{workUnitId:"GH-5", retreatBudget:2}` (number coerced by the schema);
  `dispatch(reg, ["pilot","GH-7"])` actually runs the pilot to `merged`.
- **MCP** — `toMcpTool(pilotVerb)` → name/description/inputSchema from the spec.
- **Anthropic tool** — identical `input_schema` (asserted equal to the MCP one).
- **OpenAPI** — `toOpenApiPaths(registry)` → `/pilot`, `/fleet` operations.
- **help** — usage + flags rendered from the JSON Schema.

CLI-isms (positional mapping, comma-split arrays, boolean flags) live in
`parseArgs`, not the schemas; the Zod `parse` is the single validation.

## Migration path

1. Keep `registry.data.ts` as the verb index; add `input`/`output` Zod + `run`
   per verb (this closes GH-974/975 — the flags ARE the schema).
2. Move each `cli.ts` handler body into its verb's `run`. The handler shrinks to
   a registered function; no bespoke arg parsing or help.
3. Replace `cli.ts`'s dispatch with `dispatch(registry, argv)` + `render`.
4. Stand up the MCP server and (optionally) an OpenAPI doc as `toMcpToolset` /
   `toOpenApiPaths` over the same registry — no new authoring.
5. `/prx` and the role subagents consume `toAnthropicTool` of the same verbs, so
   the agent's tools and the CLI can't diverge.

## More projections

- **Namespaced router** (`router.ts`) — `dispatchTree` resolves the longest
  matching multi-token verb id (`plan session`), exact-verb-wins-over-namespace,
  and lists a namespace's children for bare `prx plan`. So the *whole* registry
  is reachable, not just single-token verbs. (6 tests.)
- **Claude Code plugin** (`claude-plugin.ts`) — "prx installed as a Claude
  extension" is just another projection: `toClaudePlugin(registry)` emits a
  plugin manifest, a `.mcp.json` pointing Claude at the **separate** runtime
  (`prx mcp serve`), and one slash command per verb delegating to that verb's
  MCP tool (`mcp__prx__<verbToken>`). Install the plugin, keep running the prx
  binary — Claude calls in. The plugin's commands and the server's tools are the
  same registry, so they can't drift. (4 tests.)

- **`prx mcp serve`** (`mcp-server.ts`) — the runtime side of the plugin, built.
  `handleMcpRequest` mounts the registry as an MCP server: `initialize` /
  `tools/list` (= `toMcpToolset`) / `tools/call` (resolve by `verbToken` →
  validate args against the verb's Zod input → `run` → rendered result). The
  handler is transport-agnostic and unit-tested (6 tests); `serveStdio` is the
  thin newline-delimited-JSON shell (prod swaps in the official MCP stdio
  transport). The MCP path takes structured JSON args — no CLI-isms; the Zod
  schema is the only validation. End-to-end: plugin `.mcp.json` → `prx mcp serve`
  → `tools/call` → `verb.run`.

- **Permission projection** (`permissions.ts`) — built. A verb's `actor` drives
  its `ToolPolicy {allow, deny}` (the GH-1530 registry-derived ruleset idea);
  one table projects to the CLI flag-layer (`--allowedTools`/`--disallowedTools`)
  and the plugin command's `allowed-tools` frontmatter, so the CLI and the
  plugin grant the SAME authority. Unknown actors fall back to `READ_ONLY`.
  Wired into `toClaudePlugin`. (5 tests.)

## Open

- **Output presenters** — optional `present(output)` on `VerbSpec` for a custom
  pretty-printer (table, status line) beyond `render`'s JSON.

## Tracked follow-up (separate spike)

The real migration off `cli.ts` is its own work unit — **"refactor the CLI to be
spec-driven and add the projections"**: port `registry.data.ts` entries to carry
`input`/`output` Zod + `run`, move each `cli.ts` handler body into its verb,
swap dispatch to `dispatchTree`, and stand up `prx mcp serve` + the OpenAPI doc
+ the Claude plugin as registry projections. File via `prx intake spike` once the
beads/Dolt server is reachable. This doc + the spike slice are the design input.

## Status — 2026-06 (post-#691)

The fourth surface is now real: `toOpenApiOperation` is **emitted** to
`packages/prx/openapi.json` from `verbRegistry` (generator
`scripts/gen-openapi.ts`, drift-gated by `test/cli/openapi.test.ts`). CLI, MCP,
the Anthropic/Claude plugin, and OpenAPI all project from the one Zod source and
can't drift — "author once, project everywhere" now holds on all four. ~30 verbs
are spec-driven in `verb-registry.ts` against a ~216-command surface; the deeper
VerbSpec-substrate coverage (`prx health`) is ~1%, so the migration past that
floor is the remaining work (see [`cli-decomposition.md`](./cli-decomposition.md)
and [`docs/agentic-code-hygiene.md`](../agentic-code-hygiene.md)).
