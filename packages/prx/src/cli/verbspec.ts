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

export type VerbSpec<I extends ZodType = ZodType, O extends ZodType = ZodType, C = unknown> = {
  /** Stable verb id — the CLI subcommand, MCP tool name, OpenAPI operationId. */
  id: string;
  summary: string;
  /** The owning actor (binds to the capability/permission model). */
  actor: string;
  input: I;
  output: O;
  /** Input keys parsed as positionals (in order) rather than `--flags`. */
  positionals?: readonly string[];
  /**
   * Build the verb's default capability/deps slice — the real implementations
   * the CLI / MCP / OpenAPI surfaces run with. Omit for pure verbs (whose only
   * side effects are the fs/proc capabilities they import directly). This is the
   * per-verb seam that replaces the cli.ts 188-field `CliDeps` bag: each verb
   * declares the small slice it needs, defaults it to reals here, and a test
   * passes its own slice straight to `run`. Surfaces never see it — the
   * MCP/OpenAPI/Anthropic projections consume only `input`/`output`.
   */
  deps?: () => C;
  run: (input: z.infer<I>, deps?: C) => Promise<z.infer<O>> | z.infer<O>;
  /**
   * Optional CLI projection of the structured output. The `output` schema is the
   * canonical, multi-surface contract (MCP result / OpenAPI response); `render`
   * is the human-facing CLI view. When absent the CLI prints JSON. MCP/OpenAPI
   * never use `render` — they consume `output`.
   */
  render?: (output: z.infer<O>, input: z.infer<I>) => string;
  /**
   * Raw/binary stdout projection — exact bytes, no trailing newline (e.g.
   * `plan load --format=raw`). Takes precedence over `render` when it returns a
   * Buffer; return null to defer to `render`. CLI-only.
   */
  renderRaw?: (output: z.infer<O>, input: z.infer<I>) => Buffer | null;
  /**
   * Optional CLI exit code derived from a *successful* run's output — for verbs
   * with "success but non-zero" semantics (e.g. a refusal, or a check that
   * found drift) that the legacy handlers expressed by returning a code rather
   * than throwing. Defaults to 0. CLI-only: thrown errors still exit 1, and the
   * MCP/OpenAPI surfaces never consult it (they return `output`).
   */
  exitCode?: (output: z.infer<O>, input: z.infer<I>) => number;
  /**
   * Optional CLI stderr lines derived from a *successful* run — operator
   * warnings/notes/diagnostics that the legacy handlers wrote to `output.error`
   * alongside the stdout result (e.g. `--skip-validate` warnings, persist-on-
   * failure notes). The bridge writes each line to stderr before `render`'s
   * stdout. CLI-only: MCP/OpenAPI consume `output` and never see these (the
   * data they convey should also live in `output`).
   */
  warnings?: (output: z.infer<O>, input: z.infer<I>) => readonly string[];
};

/** Identity helper that preserves input/output/deps inference. */
export function defineVerb<I extends ZodType, O extends ZodType, C = unknown>(
  spec: VerbSpec<I, O, C>,
): VerbSpec<I, O, C> {
  return spec;
}

export type JsonSchema = Record<string, unknown>;

/**
 * A verb-thrown error carrying an explicit CLI exit code. The bridge
 * (`runSpecVerb`) maps it to `output.error(message)` + that code, with NO
 * stdout — for verbs that distinguish "the check ran and refused" from "the
 * check could not run" (e.g. `plan preflight` uses exit 2 for a thrown
 * network/parse error vs exit 1 for a refusal). CLI-only.
 */
export class CliExitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "CliExitError";
  }
}

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
  // Array fields accumulate repeated occurrences (`--k a --k b`); scalars take
  // the last value. Either form also comma-splits below (`--k a,b`).
  const setRaw = (key: string, value: string | true) => {
    if (isArray(key) && value !== true) {
      const prev = raw[key];
      raw[key] = Array.isArray(prev) ? [...prev, value] : [value];
    } else {
      raw[key] = value;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        setRaw(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) setRaw(key, true);
        else {
          setRaw(key, next);
          i++;
        }
      }
    } else {
      positionalValues.push(a);
    }
  }
  const pos = v.positionals ?? [];
  pos.forEach((name, idx) => {
    if (isArray(name)) {
      // A variadic (array-typed) positional collects every positional from its
      // index onward, merged ahead of any same-name flag occurrences
      // (`cmd a b --name c` → [a, b, c]). Only sensible as the last positional.
      const rest = positionalValues.slice(idx);
      if (rest.length) {
        const prev = raw[name];
        raw[name] = Array.isArray(prev) ? [...rest, ...prev] : rest;
      }
    } else if (positionalValues[idx] !== undefined) {
      raw[name] = positionalValues[idx];
    }
  });
  // comma-split array fields (a CLI-ism, kept out of the schema), flattening the
  // accumulated occurrences so repeated and comma forms compose.
  for (const [k, val] of Object.entries(raw)) {
    if (!isArray(k)) continue;
    const items = Array.isArray(val) ? val : typeof val === "string" ? [val] : [];
    raw[k] = items.flatMap((s) => (typeof s === "string" ? s.split(",") : [])).filter(Boolean);
  }
  return v.input.parse(raw);
}

// ── the thin router ───────────────────────────────────────────────────────────

// Verbs in a registry carry heterogeneous input/output/deps types; erase them
// at the registry boundary (each verb's `run` only ever sees its own parsed
// input and its own `deps()` default, so the registry never needs the precise
// per-verb types — `defineVerb` keeps those for authoring).
export type AnyVerbSpec = VerbSpec<any, any, any>;
export type Registry = Record<string, AnyVerbSpec>;

export type DispatchResult =
  | { kind: "help"; text: string }
  | { kind: "ok"; id: string; output: unknown; input: unknown };

/** Resolve verb → parse → run. This is ALL `cli.ts` needs to be. */
export async function dispatch(reg: Registry, argv: readonly string[]): Promise<DispatchResult> {
  const [id, ...rest] = argv;
  if (!id) throw new Error("no verb given");
  const v = reg[id];
  if (!v) throw new Error(`unknown verb: ${id}`);
  if (rest.includes("--help") || rest.includes("-h")) return { kind: "help", text: toHelp(v) };
  const input = parseArgs(v, rest);
  // Each verb runs against its own default deps slice (reals); pure verbs omit
  // `deps` and ignore the argument.
  const output = await v.run(input, v.deps?.());
  return { kind: "ok", id, output, input };
}

/** Default pretty-printer (a verb may carry its own later). */
export const render = (output: unknown): string => JSON.stringify(output, null, 2);
