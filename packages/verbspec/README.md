# @bounded-systems/verbspec

Spec-driven CLI core — author a verb once, project it everywhere.

A verb's input and output are Zod schemas. JSON Schema (`z.toJSONSchema`) is the
projection IR, and every surface is a pure projection of the one spec: the CLI
parser and `--help`, the MCP tool, the Anthropic tool-use schema, and the
OpenAPI operation. There is no codegen and no build step — the schema is the
single source of truth, so the surfaces can't drift.

```
VerbSpec (Zod — canonical, runtime + static)
  └─ z.toJSONSchema ──▶ JSON Schema (the interchange IR)
        ├─ toHelp / parseArgs   ──▶ argv → typed input, `--help`
        ├─ toMcpTool            ──▶ { name, description, inputSchema }
        ├─ toAnthropicTool      ──▶ { name, description, input_schema }
        └─ toOpenApiOperation   ──▶ POST /{id} (request/response schemas)
```

## Install

```sh
npm install @bounded-systems/verbspec zod
```

`zod` is a peer dependency (`^3.25 || ^4`).

## Usage

```ts
import { z } from "zod";
import {
  defineVerb,
  parseArgs,
  dispatch,
  toMcpTool,
  toAnthropicTool,
  toOpenApiOperation,
  render,
} from "@bounded-systems/verbspec";

// Author the verb once.
const greet = defineVerb({
  id: "greet",
  summary: "Greet someone by name",
  actor: "work",
  positionals: ["name"],
  input: z.object({ name: z.string(), loud: z.boolean().default(false) }),
  output: z.object({ message: z.string() }),
  run: ({ name, loud }) => ({ message: loud ? `HELLO ${name}!` : `hello ${name}` }),
});

// CLI: argv → validated input → run → printed result.
const result = await dispatch({ greet }, ["greet", "Ada", "--loud"]);
if (result.kind === "ok") console.log(render(result.output)); // { "message": "HELLO Ada!" }

// MCP / Anthropic / OpenAPI: the same schema, seen from other sides.
toMcpTool(greet); //        { name, description, inputSchema }
toAnthropicTool(greet); //  { name, description, input_schema }
toOpenApiOperation(greet); // POST /greet
```

`parseArgs` carries the CLI-isms (positionals, boolean flags, repeated and
comma-split array values); the Zod `parse` is the only validation. The
MCP/OpenAPI/Anthropic projections take structured JSON and consume only
`input`/`output` — never the CLI-only `render`/`exitCode`/`warnings` hooks.

## Design

- **One spec, four surfaces.** The CLI, MCP server, Anthropic tool schema, and
  OpenAPI operation are pure projections of a single `VerbSpec`, so help text,
  arg parsing, validation, and tool schemas can't drift.
- **Zod-canonical.** Runtime validation *and* static types from one definition;
  `z.toJSONSchema` is the interchange IR. No codegen, no FFI, no build step to
  author a verb.
- **Self-contained.** The only production dependency is the `zod` peer dep. An
  extractability test enforces outward-only imports and no ambient authority (no
  shelling out, no `process.env`).

## License

[MIT](./LICENSE) © Bounded Systems
