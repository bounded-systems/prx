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
| **Zod → JSON Schema** | ✅ Chosen. Already pervasive in prx; runtime validation **and** static types; `z.toJSONSchema` is native in zod 4; no codegen/FFI. Matches core.md ("structured outputs as enforceable specs… use Zod"). |
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

## Open

- **Output presenters** — a verb may want a custom pretty-printer (table, status
  line) beyond `render`'s JSON; add an optional `present(output)` to `VerbSpec`.
- **Subcommand namespaces** — `plan session`, `intake spike` are two-token ids;
  the router needs prefix resolution (trie over ids).
- **Permission projection** — the `actor` field should drive the allow/deny tool
  lists per surface (CLI flag-layer, MCP exposure), tying into the capability
  model.
