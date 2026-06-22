# Author a verb once. Get the CLI, the MCP tool, the OpenAPI route, and the model schema for free.

*Draft — blog post #2. The one idea with outward pull.*

Ship one capability to both humans and agents today and you write it four times:
a CLI with flag parsing and `--help`, an MCP tool definition, an OpenAPI
operation, an Anthropic tool-use schema. Four artifacts, four hand-maintained
copies of the same shape — and they drift. The help text says one thing, the
tool schema says a slightly older thing, the OpenAPI spec a third. Each rots on
its own schedule, and nothing tells you when.

The fix is boring and total: there should be **one** definition, and every
surface should be a pure projection of it.

## One spec, four surfaces

That's verbspec. A verb's input and output are **Zod schemas** — the single
source of truth, giving you runtime validation *and* static types from one
definition. `z.toJSONSchema` turns it into the interchange IR, and every surface
is a pure function of that IR:

```
VerbSpec (Zod — canonical)
  └─ z.toJSONSchema ──▶ JSON Schema (the IR)
        ├─ parseArgs / --help   ──▶ a CLI
        ├─ toMcpTool            ──▶ an MCP tool
        ├─ toAnthropicTool      ──▶ a model tool-use schema
        └─ toOpenApiOperation   ──▶ a REST operation
```

You author the verb once:

```ts
const greet = defineVerb({
  id: "greet",
  summary: "Greet someone by name",
  input: z.object({ name: z.string(), loud: z.boolean().default(false) }),
  output: z.object({ message: z.string() }),
  run: ({ name, loud }) => ({ message: loud ? `HELLO ${name}!` : `hello ${name}` }),
});
```

…and the CLI (`greet Ada --loud`), the MCP tool, the model schema, and
`POST /greet` are all just that spec seen from different sides. No codegen, no
build step, no FFI to author a verb.

## Why it can't drift

The surfaces aren't generated-then-edited; they're **computed from the spec on
demand**. There's nothing to keep in sync because there's only one thing. That's
the whole trick — drift isn't fixed, it's made unrepresentable.

The package is a clean leaf: its only production dependency is the `zod` peer
dep, and an extractability test enforces that it stays pure — outward-only
imports, no ambient authority (no shelling out, no `process.env`). You can drop
it into anything.

## What it is and isn't

verbspec is the **projection layer** — author once, project everywhere,
drift-free. It is *not* the capability/security story (that's the door work);
it's the "one source of truth projected to many surfaces" mechanism, pulled out
as a standalone, usable thing. It's **MIT**, on npm, `zod` the only peer
dependency. It works today.

If you maintain a CLI *and* an MCP server *and* an OpenAPI spec for the same
operations, this collapses four hand-maintained artifacts into one — and the one
can't lie to the other three.

---

*This is one mechanism from a larger bet — keeping agent-authored contracts
honest as they multiply (see [post #1](bifurcation-and-inter-contract-enforcement.md)).
verbspec is the piece with the most pull on its own.*
