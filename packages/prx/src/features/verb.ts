// `prx features` — render (or --check) every generated gherkin .feature, as a
// spec-driven VerbSpec (the `prx docs` / `prx schemas` template applied to the
// gen-*-feature family). One verb over every feature file, each rendered from its
// source of truth via the shared registry, so verb and scripts can't diverge.
//
// The registry is imported DYNAMICALLY inside `run` (it pulls in the generators'
// source modules + resolves the repo root) so none of that loads at CLI startup.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import { z } from "zod";

import { getRepoRoot } from "@bounded-systems/repo-root";
import { defineVerb } from "@bounded-systems/verbspec";

export const FeaturesReport = z
  .object({
    check: z.boolean(),
    driftCount: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
  })
  .strict();
export type FeaturesReport = z.infer<typeof FeaturesReport>;

export const featuresVerb = defineVerb({
  id: "features",
  summary: "Render (or --check) every generated gherkin .feature from its source of truth.",
  actor: "work",
  input: z.object({
    check: z.boolean().optional().describe("validate drift instead of writing files"),
  }),
  output: FeaturesReport,
  run: async ({ check = false }): Promise<FeaturesReport> => {
    const root = getRepoRoot();
    const { featureArtifacts } = await import("./registry.ts");
    const artifacts = featureArtifacts();
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
        `feature files out of date: ${drifted.join(", ")}\nrun \`bun run features:render\` and commit the result.`,
      );
    }
    return { check, driftCount: drifted.length, count: artifacts.length };
  },
});
