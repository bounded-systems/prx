// `prx skills` as a spec-driven VerbSpec — a catalog/read slice of the cli.ts
// decomposition (ADR docs/prx/cli-decomposition.md), neighbour of `actors` /
// `model` / `graph`. A pure read over the cli-format leaf: it derives the
// skill catalog for the contract's current state (which transitions are
// allowed) and renders it as text or JSON. No side effects, no CliDeps.

import { z } from "zod";

import { defineVerb } from "../cli/verbspec.ts";
import { formatSkillCatalog } from "./cli-format.ts";

export const SkillsOutput = z.object({ rendered: z.string() }).strict();
export type SkillsOutput = z.infer<typeof SkillsOutput>;

export const skillsVerb = defineVerb({
  id: "skills",
  summary: "List the pr skill catalog (events allowed from the contract's current state).",
  actor: "work",
  input: z.object({
    contract: z
      .string()
      .default(".pr/local/pr.json")
      .describe("path to the pr contract whose state gates the catalog"),
    format: z.enum(["plain", "json"]).default("plain").describe("output format"),
  }),
  output: SkillsOutput,
  run: ({ contract, format }): SkillsOutput => ({ rendered: formatSkillCatalog(contract, format) }),
  render: (out) => out.rendered,
});
