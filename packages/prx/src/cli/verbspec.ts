/**
 * SPIKE — spec-driven CLI: author a verb ONCE, project it everywhere.
 *
 * Today `prx`'s surface is a ~25k-line `cli.ts` of hand-rolled handlers + a
 * `registry.data.ts` that lists commands but carries no per-verb arg/output
 * schema (the GH-974/975 gap). This flips it: each verb is a `VerbSpec` whose
 * input/output are Zod schemas, and every surface is a pure projection:
 *
 *   VerbSpec (Zod, canonical)
 *     └─ z.toJSONSchema ──▶ JSON Schema (the interchange IR)
 *           ├─ toCli      ──▶ argv parser + `--help`   (thin router + printer)
 *           ├─ toMcpTool  ──▶ MCP tool { name, description, inputSchema }
 *           ├─ toAnthropicTool ──▶ tool-use { name, description, input_schema }
 *           └─ toOpenApiOperation ──▶ POST /{id}
 *
 * `cli.ts` collapses to: resolve verb → parse argv (validated by the Zod input)
 * → `run` → pretty-print. No per-verb handler boilerplate, no drift between the
 * CLI, the MCP server, the OpenAPI doc, and the agent tool schemas — they are
 * the same schema seen from four sides.
 */

import { z, type ZodType } from "zod";

export type VerbSpec<I extends ZodType = ZodType, O extends ZodType = ZodType> = {
  /** Stable verb id — the CLI subcommand, MCP tool name, OpenAPI operationId. */
  id: string;
  summary: string;
  /** The owning actor (binds to the capability/permission model). */
  actor: string;
  input: I;
  output: O;
  /** Input keys parsed as positionals (in order) rather than `--flags`. */
  positionals?: readonly string[];
  run: (input: z.infer<I>) => Promise<z.infer<O>> | z.infer<O>;
};

/** Identity helper that preserves input/output inference. */
export function defineVerb<I extends ZodType, O extends ZodType>(spec: VerbSpec<I, O>): VerbSpec<I, O> {
  return spec;
}

export type JsonSchema = Record<string, unknown>;

/**
 * MCP/OpenAPI-safe token for a verb id: spaces → `_` (MCP tool names and
 * OpenAPI operationIds can't contain spaces). `plan session` → `plan_session`;
 * single-token ids are unchanged.
 */
export const verbToken = (id: string): string => id.replace(/\s+/g, "_");

export const toInputJsonSchema = (v: VerbSpec): JsonSchema => z.toJSONSchema(v.input) as JsonSchema;
export const toOutputJsonSchema = (v: VerbSpec): JsonSchema => z.toJSONSchema(v.output) as JsonSchema;

// ── projections ─────────────────────────────────────────────────────────────

export type McpTool = { name: string; description: string; inputSchema: JsonSchema };
export const toMcpTool = (v: VerbSpec): McpTool => ({
  name: verbToken(v.id),
  description: v.summary,
  inputSchema: toInputJsonSchema(v),
});

export type AnthropicTool = { name: string; description: string; input_schema: JsonSchema };
export const toAnthropicTool = (v: VerbSpec): AnthropicTool => ({
  name: verbToken(v.id),
  description: v.summary,
  input_schema: toInputJsonSchema(v),
});

export const toOpenApiOperation = (v: VerbSpec): JsonSchema => ({
  operationId: verbToken(v.id),
  summary: v.summary,
  "x-prx-actor": v.actor,
  requestBody: {
    required: true,
    content: { "application/json": { schema: toInputJsonSchema(v) } },
  },
  responses: {
    "200": { description: "ok", content: { "application/json": { schema: toOutputJsonSchema(v) } } },
  },
});

/** Project a whole registry to an OpenAPI `paths` object (ids → `/a/b` paths). */
export const toOpenApiPaths = (reg: Registry): JsonSchema =>
  Object.fromEntries(
    Object.values(reg).map((v) => [`/${v.id.split(" ").join("/")}`, { post: toOpenApiOperation(v) }]),
  );

/** Project a whole registry to an MCP toolset. */
export const toMcpToolset = (reg: Registry): McpTool[] => Object.values(reg).map(toMcpTool);

// ── CLI projection: help + argv parser ───────────────────────────────────────

type JsonProps = { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };

export function toHelp(v: VerbSpec): string {
  const js = toInputJsonSchema(v) as JsonProps;
  const props = js.properties ?? {};
  const required = new Set(js.required ?? []);
  const pos = v.positionals ?? [];
  const usagePos = pos.map((p) => (required.has(p) ? `<${p}>` : `[${p}]`)).join(" ");
  const flags = Object.keys(props).filter((k) => !pos.includes(k));
  const lines = [`prx ${v.id} ${usagePos}`.trimEnd(), "", `  ${v.summary}`, ""];
  if (flags.length) {
    lines.push("Flags:");
    for (const f of flags) {
      const meta = props[f] ?? {};
      const req = required.has(f) ? " (required)" : "";
      const desc = meta.description ? ` — ${meta.description}` : "";
      lines.push(`  --${f} <${meta.type ?? "value"}>${req}${desc}`);
    }
  }
  return lines.join("\n");
}

/**
 * Parse argv into the verb's input, validated by its Zod schema. CLI-isms stay
 * here, not in the schemas: `--k v` / `--k=v` / boolean `--flag` / positionals,
 * and comma-split for array-typed fields (detected from the JSON Schema). The
 * Zod `parse` does coercion (`z.coerce.number`) and is the single validation.
 */
export function parseArgs<I extends ZodType>(v: VerbSpec<I, ZodType>, argv: readonly string[]): z.infer<I> {
  const js = toInputJsonSchema(v) as { properties?: Record<string, { type?: string }> };
  const props = js.properties ?? {};
  const isArray = (key: string) => props[key]?.type === "array";

  const raw: Record<string, unknown> = {};
  const positionalValues: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        raw[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) raw[key] = true;
        else {
          raw[key] = next;
          i++;
        }
      }
    } else {
      positionalValues.push(a);
    }
  }
  const pos = v.positionals ?? [];
  pos.forEach((name, idx) => {
    if (positionalValues[idx] !== undefined) raw[name] = positionalValues[idx];
  });
  // comma-split array fields (a CLI-ism, kept out of the schema)
  for (const [k, val] of Object.entries(raw)) {
    if (isArray(k) && typeof val === "string") raw[k] = val.split(",").filter(Boolean);
  }
  return v.input.parse(raw);
}

// ── the thin router ───────────────────────────────────────────────────────────

export type Registry = Record<string, VerbSpec>;

export type DispatchResult =
  | { kind: "help"; text: string }
  | { kind: "ok"; id: string; output: unknown };

/** Resolve verb → parse → run. This is ALL `cli.ts` needs to be. */
export async function dispatch(reg: Registry, argv: readonly string[]): Promise<DispatchResult> {
  const [id, ...rest] = argv;
  if (!id) throw new Error("no verb given");
  const v = reg[id];
  if (!v) throw new Error(`unknown verb: ${id}`);
  if (rest.includes("--help") || rest.includes("-h")) return { kind: "help", text: toHelp(v) };
  const input = parseArgs(v, rest);
  const output = await v.run(input);
  return { kind: "ok", id, output };
}

/** Default pretty-printer (a verb may carry its own later). */
export const render = (output: unknown): string => JSON.stringify(output, null, 2);
