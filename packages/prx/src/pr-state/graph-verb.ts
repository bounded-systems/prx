// `prx graph` as a spec-driven VerbSpec — the first dispatcher handler migrated
// off the cli.ts monolith (ADR docs/prx/cli-decomposition.md). The structured
// `output` is the multi-surface contract (MCP result / OpenAPI response); the
// `render` projection reproduces the legacy human CLI output. Side effects
// (--output write, --open) live in `run`, mirroring the old handler.

import { writeFileSync } from "node:fs";

import { z } from "zod";

import { defineVerb } from "../cli/verbspec.ts";
import { formatGraph } from "./cli-format.ts";
import { runInheritStatus } from "./cli-spawn.ts";

const GRAPH_FORMATS = [
  "plain",
  "json",
  "xstate-json",
  "xstate-ts",
  "xstate-mermaid",
  "mermaid",
  "xstate-system-json",
  "xstate-system-ts",
  "xstate-system-mermaid",
  "system-mermaid",
] as const;
type GraphFormat = (typeof GRAPH_FORMATS)[number];

const isJsonGraphFormat = (format: GraphFormat): boolean =>
  format === "json" || format === "xstate-json" || format === "xstate-system-json";

export const GraphOutput = z
  .object({ graph: z.string(), wrotePath: z.string().optional() })
  .strict();
export type GraphOutput = z.infer<typeof GraphOutput>;

export const graphVerb = defineVerb({
  id: "graph",
  summary: "Emit the prx state-machine graph in a chosen format (xstate / mermaid / json).",
  actor: "work",
  input: z.object({
    format: z.enum(GRAPH_FORMATS).default("plain").describe("graph format"),
    output: z.string().optional().describe("write the graph to this path instead of stdout"),
    validate: z.coerce.boolean().default(false).describe("JSON-validate the graph (JSON formats only)"),
    open: z.coerce.boolean().default(false).describe("open the Stately editor after emitting"),
    url: z.string().default("https://stately.ai/registry/editor/"),
  }),
  output: GraphOutput,
  run: ({ format, output, validate, open, url }): GraphOutput => {
    const graph = formatGraph(format);
    if (validate) {
      if (!isJsonGraphFormat(format)) {
        throw new Error(`--validate requires a JSON graph format; got ${format}`);
      }
      try {
        JSON.parse(graph);
      } catch (error) {
        throw new Error(`Graph JSON validation failed: ${(error as Error).message}`);
      }
    }
    let wrotePath: string | undefined;
    if (output) {
      writeFileSync(output, graph);
      wrotePath = output;
    }
    if (open && runInheritStatus(["/usr/bin/open", url]) !== 0) {
      throw new Error(`Failed to open ${url}`);
    }
    return wrotePath ? { graph, wrotePath } : { graph };
  },
  render: (out, input) =>
    out.wrotePath
      ? [`Wrote graph output to ${out.wrotePath}`, ...(input.validate ? ["json-ok"] : [])].join(" | ")
      : out.graph,
});
