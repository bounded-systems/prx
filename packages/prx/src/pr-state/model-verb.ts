// `prx actors` and `prx model` (a.k.a. `model actors` / `model show`) as
// spec-driven VerbSpecs — the catalog/read slice of the cli.ts decomposition
// (ADR docs/prx/cli-decomposition.md), neighbours of `graph`. Both are pure
// reads over the cli-format leaf: one Zod input (scope × format), a structured
// `output` (the rendered catalog), and a `render` that reproduces the legacy
// human/JSON CLI text. No side effects, no CliDeps.

import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import { formatActors, formatModel } from "./cli-format.ts";

const CatalogInput = z.object({
  scope: z.enum(["pr", "workflow"]).default("pr").describe("actor scope"),
  format: z.enum(["plain", "json"]).default("plain").describe("output format"),
});

export const CatalogOutput = z.object({ rendered: z.string() }).strict();
export type CatalogOutput = z.infer<typeof CatalogOutput>;

export const actorsVerb = defineVerb({
  id: "actors",
  summary: "List the tool actors for a scope (pr / workflow), as text or JSON.",
  actor: "work",
  input: CatalogInput,
  output: CatalogOutput,
  run: ({ scope, format }): CatalogOutput => ({ rendered: formatActors(scope, format) }),
  render: (out) => out.rendered,
});

export const modelVerb = defineVerb({
  id: "model",
  summary: "Show the work-unit model (actors → raw facts → invariants → phase) for a scope.",
  actor: "work",
  input: CatalogInput,
  output: CatalogOutput,
  run: ({ scope, format }): CatalogOutput => ({ rendered: formatModel(scope, format) }),
  render: (out) => out.rendered,
});
