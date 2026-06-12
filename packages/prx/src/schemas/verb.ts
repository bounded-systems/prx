// `prx schemas` — render (or --check) every committed JSON-Schema artifact, as a
// spec-driven VerbSpec (the `prx docs` template applied to the export-* family).
// One verb over every schema target, each rendered from its Zod source via the
// shared registry, so the verb and the export-* scripts can't diverge.
//
// The registry is imported DYNAMICALLY inside `run` (it pulls in every schema
// source module + resolves the repo root) so none of that loads at CLI startup.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import { z } from "zod";

import { getRepoRoot } from "@bounded-systems/repo-root";
import { defineVerb } from "@bounded-systems/verbspec";

export const SchemasReport = z
  .object({
    check: z.boolean(),
    driftCount: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
  })
  .strict();
export type SchemasReport = z.infer<typeof SchemasReport>;

export const schemasVerb = defineVerb({
  id: "schemas",
  summary: "Render (or --check) every committed JSON-Schema artifact from its Zod source.",
  actor: "work",
  input: z.object({
    check: z.boolean().optional().describe("validate drift instead of writing files"),
  }),
  output: SchemasReport,
  run: async ({ check = false }): Promise<SchemasReport> => {
    const root = getRepoRoot();
    const { schemaArtifacts } = await import("./registry.ts");
    const artifacts = schemaArtifacts();
    const drifted: string[] = [];
    for (const { path, content } of artifacts) {
      if (check) {
        let current = "";
        try {
          current = readFileSync(path, "utf8");
        } catch {
          current = "";
        }
        if (current !== content) drifted.push(relative(root, path) || path);
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, "utf8");
      }
    }
    if (check && drifted.length > 0) {
      throw new Error(
        `schema artifacts out of date: ${drifted.join(", ")}\nrun \`bun run schemas:export\` and commit the result.`,
      );
    }
    return { check, driftCount: drifted.length, count: artifacts.length };
  },
});
